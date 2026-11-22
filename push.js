// =============================================================================
// Notifications (in Settings): turning push on for this phone, and choosing
// what each of you gets told about. The duo-photos Worker sends them; what's
// due is worked out by push_due() in schema.sql. The choices are per person,
// so they apply to all your phones.
// =============================================================================

import { tr, lang } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const PREFS = ["board", "mail", "games", "gifts", "trip_next", "trip_arrive"];
const SEEN_EVERY = 60_000; // while Duo is open, so board and game pushes wait

function b64urlBytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function createPush({ sb, getMe, toast, callWorker, publicKey, demo, isIOS, isStandalone }) {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const available = !demo && !!publicKey && !!callWorker;
  let prefs = null;      // this person's push_prefs row
  let subscribed = false; // this phone gets pushes
  let busy = false;
  let seenTimer = 0;

  async function currentSubscription() {
    if (!supported || !available) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  }

  async function save(sub) {
    const j = sub.toJSON();
    const { error } = await sb.rpc("save_push_subscription", {
      p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
      p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, p_lang: lang,
    });
    if (error) throw error;
  }

  async function loadPrefs() {
    const { data } = await sb.from("push_prefs").select("*").eq("user_id", getMe().id).maybeSingle();
    prefs = data ?? Object.fromEntries(PREFS.map((k) => [k, true]));
  }

  function seen() {
    if (document.visibilityState === "visible" && getMe()) sb.rpc("push_seen").then(() => {}, () => {});
  }

  async function start() {
    if (!available) return;
    seen();
    seenTimer = setInterval(seen, SEEN_EVERY);
    try {
      await loadPrefs();
      // Refresh this phone's details (its timezone changes when you travel)
      const sub = Notification.permission === "granted" ? await currentSubscription() : null;
      subscribed = !!sub;
      if (sub) await save(sub);
    } catch {}
    if ($("settings").open) render();
  }

  function stop() {
    clearInterval(seenTimer);
    prefs = null;
    subscribed = false;
  }

  async function turnOn() {
    // Must run straight from the tap: iOS only asks for permission then
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return render();
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlBytes(publicKey) });
    await save(sub);
    subscribed = true;
    if (!prefs) await loadPrefs();
  }

  /** Stop pushes to this phone (turning off, or signing out). */
  async function forget() {
    const sub = await currentSubscription().catch(() => null);
    if (!sub) return;
    await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint).then(() => {}, () => {});
    await sub.unsubscribe().catch(() => {});
    subscribed = false;
  }

  async function setPref(key, value) {
    prefs = { ...prefs, [key]: value };
    const { error } = await sb.from("push_prefs").upsert({ user_id: getMe().id, [key]: value });
    if (error) {
      prefs = { ...prefs, [key]: !value };
      toast(tr("Couldn't save that: ") + error.message);
      render();
    }
  }

  function statusText() {
    if (demo) return tr("Notifications don't work in demo mode.");
    if (!available) return tr("Notifications aren't set up yet (see the README).");
    if (isIOS && !isStandalone) return tr("On iPhone, notifications only work in the Home Screen app. Add Duo to your Home Screen, open it from there, and turn them on here.");
    if (!supported) return tr("This browser can't show notifications.");
    if (Notification.permission === "denied") return tr("Notifications are blocked for Duo. Allow them in your phone's Settings (Notifications › Duo), then come back here.");
    return subscribed ? tr("On for this phone.") : tr("Off for this phone.");
  }

  function render() {
    const canAsk = available && supported && !(isIOS && !isStandalone) && Notification.permission !== "denied";
    $("push-status").textContent = statusText();
    $("push-on").hidden = !canAsk || subscribed;
    $("push-off").hidden = $("push-test").hidden = !canAsk || !subscribed;
    $("push-prefs").hidden = !available;
    for (const input of $("push-prefs").querySelectorAll("[data-pref]")) {
      input.checked = !!prefs?.[input.dataset.pref];
      input.disabled = !prefs || busy;
    }
    for (const b of [$("push-on"), $("push-off"), $("push-test")]) b.disabled = busy;
  }

  async function run(job) {
    busy = true;
    render();
    try { await job(); }
    catch (err) { toast(tr("Notifications: ") + (err.message ?? err)); }
    finally { busy = false; render(); }
  }

  $("push-on").addEventListener("click", () => run(turnOn));
  $("push-off").addEventListener("click", () => run(forget));
  $("push-test").addEventListener("click", () => run(async () => {
    const { sent } = await callWorker("/push/test", { lang });
    toast(sent ? tr("Sent! It should show up in a few seconds.") : tr("Nothing was sent. Try turning notifications off and on again."));
  }));
  $("push-prefs").addEventListener("change", (e) => {
    const key = e.target.dataset.pref;
    if (key) setPref(key, e.target.checked);
  });

  return { start, stop, render, forget };
}
