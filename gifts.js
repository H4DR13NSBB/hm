// =============================================================================
// Gift boxes: something hidden in a box (a note, plus a photo, drawing, GIF,
// sticker, voice note or video) that the other person opens.
// Boxes only exist on special days (the same rules as gift_occasion() in
// schema.sql):
//   1-24 December    advent calendar: one box from each of you, every day
//   a birthday       only the other person gives one
//   the anniversary  one from each of you
// You can fill boxes ahead of time. A box shows up at the top of its day on the
// board; the recipient can't see it before then, nor what's inside before
// opening it (the database keeps the contents from them until then).
// =============================================================================

import { stopAll } from "./media.js";
import { tr, locale } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const OCCASIONS = {
  advent:      { emoji: "🎄", name: tr("Advent calendar") },
  birthday:    { emoji: "🎂", name: tr("Birthday") },
  anniversary: { emoji: "💞", name: tr("Anniversary") },
};
const PEEK = { photo: "📷", drawing: "🖍️", gif: "🎞️", sticker: "✨", audio: "🎙️", video: "🎥", note: "💌" };
const OPEN_MS = 1500; // how long the opening animation runs before the contents appear

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const md = (day) => day.slice(5);
const dayNum = (day) => Number(day.slice(8));
function fmtDay(day, withYear = false) {
  return new Date(day + "T12:00:00Z").toLocaleDateString(locale, {
    day: "numeric", month: "long", timeZone: "UTC", ...(withYear && { year: "numeric" }),
  });
}
function fmtWhen(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(locale, { day: "numeric", month: "short" }) + tr(" at ") +
    d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}
/** The next time an 'MM-DD' comes round, on or after `from`. */
function nextDay(mmdd, from) {
  const y = Number(from.slice(0, 4));
  const d = `${y}-${mmdd}`;
  return d >= from ? d : `${y + 1}-${mmdd}`;
}
const isDrawingPath = (p) => /\.png$/.test(p ?? "");
const contentKind = (c) => (!c?.kind ? "note" : c.kind === "photo" && isDrawingPath(c.media_path) ? "drawing" : c.kind);

export function createGifts({ sb, getMe, getMembers, colorOf, toast, photos, getToday, ensureSection, onShelvesChanged, pick }) {
  const gifts = new Map();     // id -> gifts row
  const contents = new Map();  // gift id -> gift_contents row (the ones I may read)
  const birthdays = new Map(); // user id -> 'MM-DD'
  let anniversary = null;
  let missing = false;         // the Gifts part of schema.sql hasn't been run yet
  let loaded = false;
  let channel = null;
  let reloadTimer = 0;
  const announced = new Set();
  const shelfDays = new Set();

  const meId = () => getMe()?.id;
  const other = () => getMembers().find((m) => m.user_id !== meId());
  const nameOf = (id) => getMembers().find((m) => m.user_id === id)?.display_name ?? "?";

  /** What box (if any) `giver` gives `receiver` on `day`. Mirrors gift_occasion() in schema.sql. */
  function occasionOf(day, giver, receiver) {
    if (md(day) === birthdays.get(receiver)) return "birthday";
    if (md(day) === birthdays.get(giver)) return null;
    if (md(day) === anniversary) return "anniversary";
    if (day.slice(5, 7) === "12" && dayNum(day) <= 24) return "advent";
    return null;
  }
  const sentFor = (day) => [...gifts.values()].find((g) => g.from_id === meId() && g.day === day);
  const waitingForMe = () => [...gifts.values()]
    .filter((g) => g.to_id === meId() && !g.opened_at && g.day <= getToday())
    .sort((a, b) => a.day.localeCompare(b.day));

  // ---------- loading ----------
  async function load() {
    if (!meId()) return;
    const [g, c, m, s] = await Promise.all([
      sb.from("gifts").select("*"),
      sb.from("gift_contents").select("*"),
      sb.from("members").select("user_id, birthday"),
      sb.from("settings").select("anniversary").maybeSingle(),
    ]);
    if (!meId()) return;
    missing = !!(g.error || c.error || m.error || s.error);
    if (missing) {
      gifts.clear();
      contents.clear();
    } else {
      gifts.clear();
      for (const r of g.data) gifts.set(r.id, r);
      contents.clear();
      for (const r of c.data) contents.set(r.gift_id, r);
      birthdays.clear();
      for (const r of m.data) if (r.birthday) birthdays.set(r.user_id, r.birthday);
      anniversary = s.data?.anniversary ?? null;
    }
    loaded = true;
    render();
    announce();
  }
  function reloadSoon() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 300);
  }

  function announce() {
    const fresh = waitingForMe().filter((g) => !announced.has(g.id));
    if (!fresh.length) return;
    fresh.forEach((g) => announced.add(g.id));
    if (fresh.some((g) => g.day === getToday())) {
      toast(tr("🎁 {name} left you a box on the board today", { name: nameOf(fresh[0].from_id) }));
    }
  }

  // ---------- drawing a box ----------
  function boxEl(g, { big = false } = {}) {
    const b = el("span", `gbox ${g.occasion}`);
    if (big) b.classList.add("big");
    b.style.setProperty("--c", colorOf.get(g.from_id) ?? "var(--accent)");
    if (g.occasion === "advent") b.dataset.v = String(dayNum(g.day) % 3);
    const lid = el("span", "gbox-lid");
    const body = el("span", "gbox-body");
    body.append(el("span", "gbox-tag", g.occasion === "advent" ? String(dayNum(g.day)) : OCCASIONS[g.occasion].emoji));
    b.append(el("span", "gbox-peek", PEEK[contentKind(contents.get(g.id))]), body, lid);
    if (g.opened_at) b.classList.add("open");
    return b;
  }

  // ---------- the board: a shelf at the top of each day that has boxes ----------
  function renderShelves() {
    const byDay = new Map();
    if (!missing) {
      for (const g of gifts.values()) {
        if (g.day > getToday()) continue; // filled ahead: not on the board yet
        if (!byDay.has(g.day)) byDay.set(g.day, []);
        byDay.get(g.day).push(g);
      }
    }
    const removed = [];
    for (const day of shelfDays) {
      if (byDay.has(day)) continue;
      document.querySelector(`.day[data-day="${day}"] .gift-shelf`)?.remove();
      shelfDays.delete(day);
      removed.push(day);
    }
    const order = getMembers().map((m) => m.user_id);
    for (const [day, list] of byDay) {
      const s = ensureSection(day);
      let shelf = s.el.querySelector(".gift-shelf");
      if (!shelf) {
        shelf = el("div", "gift-shelf");
        s.el.querySelector(".day-head").after(shelf);
      }
      list.sort((a, b) => order.indexOf(a.from_id) - order.indexOf(b.from_id));
      shelf.replaceChildren(...list.map((g) => {
        const mine = g.from_id === meId();
        const btn = el("button", "gift");
        btn.type = "button";
        const box = boxEl(g);
        if (!mine && !g.opened_at) box.classList.add("for-me");
        const label = mine
          ? tr("for {name}", { name: nameOf(g.to_id) }) + (g.opened_at ? tr(" · opened") : "")
          : tr("from {name}", { name: nameOf(g.from_id) });
        btn.setAttribute("aria-label", tr("{occasion} box {label}", { occasion: OCCASIONS[g.occasion].name, label }));
        btn.append(box, el("span", "gift-label", label));
        btn.addEventListener("click", () => tapBox(g.id));
        return btn;
      }));
      shelfDays.add(day);
    }
    onShelvesChanged?.([...byDay.keys(), ...removed]);
  }

  function tapBox(id) {
    const g = gifts.get(id);
    if (!g) return;
    if (g.from_id === meId() && !g.opened_at && g.day >= getToday()) return openComposer(g.day);
    openViewer(g);
  }

  function render() {
    renderShelves();
    const n = waitingForMe().length;
    $("gift-badge").hidden = !n;
    $("gift-badge").textContent = n ? String(n) : "";
    if ($("gift-plan").open) renderPlanner();
  }

  // ---------- planner: every box you can fill ----------
  function openPlanner() {
    renderPlanner();
    $("gift-plan").showModal();
  }

  function renderPlanner() {
    const body = $("gp-body");
    if (missing || !loaded) {
      const p = el("p", "muted");
      p.innerHTML = loaded
        ? tr("Almost there: run the <b>Gifts</b> part of <code>supabase/schema.sql</code> in the Supabase SQL Editor, then reopen Duo.")
        : tr("Loading…");
      return body.replaceChildren(p);
    }
    const them = other();
    if (!them) return body.replaceChildren(el("p", "muted", tr("There's nobody to give boxes to yet.")));
    const today = getToday();
    const out = [];

    const waiting = waitingForMe();
    if (waiting.length) {
      const sec = el("section", "gp-section");
      sec.append(el("h3", null, tr("Waiting for you")));
      const row = el("div", "gp-waiting");
      for (const g of waiting) {
        const btn = el("button", "gift");
        btn.type = "button";
        const box = boxEl(g);
        box.classList.add("for-me");
        btn.append(box, el("span", "gift-label", `${fmtDay(g.day)} · ${tr("from {name}", { name: nameOf(g.from_id) })}`));
        btn.addEventListener("click", () => openViewer(g));
        row.append(btn);
      }
      sec.append(row);
      out.push(sec);
    }

    out.push(el("p", "muted small-note",
      tr("Fill a box whenever you like. It appears on the board on its day, and {name} can open it from then on.", { name: them.display_name })));

    // the occasions coming up, soonest first
    const upcoming = [];
    const adventYear = today <= `${today.slice(0, 4)}-12-24` ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) + 1;
    upcoming.push({ type: "advent", day: `${adventYear}-12-01` });
    const theirs = birthdays.get(them.user_id);
    if (theirs) upcoming.push({ type: "birthday", day: nextDay(theirs, today) });
    if (anniversary) upcoming.push({ type: "anniversary", day: nextDay(anniversary, today) });
    const lastAdvent = `${adventYear}-12-24`;
    upcoming.sort((a, b) => (a.type === "advent" && today >= a.day ? today : a.day).localeCompare(
      b.type === "advent" && today >= b.day ? today : b.day));

    for (const o of upcoming) {
      const sec = el("section", "gp-section");
      if (o.type === "advent") {
        const days = Array.from({ length: 24 }, (_, i) => `${adventYear}-12-${String(i + 1).padStart(2, "0")}`)
          .filter((d) => occasionOf(d, meId(), them.user_id) === "advent");
        const ready = days.filter((d) => sentFor(d)).length;
        const head = el("div", "gp-head");
        head.append(el("h3", null, tr("🎄 Advent calendar {year}", { year: adventYear })), el("span", "muted", tr("{n} / {total} ready", { n: ready, total: days.length })));
        const grid = el("div", "gp-grid");
        for (const d of days) {
          const g = sentFor(d);
          const t = el("button", "gp-tile", String(dayNum(d)));
          t.type = "button";
          t.dataset.v = String(dayNum(d) % 3);
          t.classList.toggle("filled", !!g);
          t.classList.toggle("opened", !!g?.opened_at);
          t.classList.toggle("today", d === today);
          const past = d < today;
          t.disabled = past && !g?.opened_at;
          t.setAttribute("aria-label", `${fmtDay(d)}: ${tr(g?.opened_at ? "opened" : g ? "ready" : past ? "missed" : "empty")}`);
          t.addEventListener("click", () => (g?.opened_at ? openViewer(g) : openComposer(d)));
          grid.append(t);
        }
        sec.append(head, grid);
        if (today > lastAdvent) sec.append(el("p", "muted small-note", tr("That's all 24 for this year.")));
      } else {
        const g = sentFor(o.day);
        const info = OCCASIONS[o.type];
        const row = el("button", "gp-row");
        row.type = "button";
        const title = o.type === "birthday" ? tr("{name}'s birthday", { name: them.display_name }) : info.name;
        const text = el("span", "gp-row-text");
        text.append(el("b", null, `${info.emoji} ${title}`), el("span", "muted", fmtDay(o.day, true)));
        const state = el("span", "gp-row-state",
          g?.opened_at ? tr("Opened ✓") : g ? tr("Ready 🎁") : o.day === today ? tr("Today! Fill it") : tr("Fill it"));
        state.classList.toggle("ready", !!g);
        row.append(text, state);
        row.addEventListener("click", () => (g?.opened_at ? openViewer(g) : openComposer(o.day)));
        sec.append(row);
      }
      out.push(sec);
    }

    const mine = birthdays.get(meId());
    if (mine) {
      out.push(el("p", "muted small-note",
        tr("🎂 Your birthday is on {date}: that day it's {name}'s turn to give you one.", { date: fmtDay(nextDay(mine, today)), name: them.display_name })));
    }
    if (!theirs || !mine || !anniversary) {
      out.push(el("p", "muted small-note", tr("Birthdays and the anniversary are set in supabase/add-members.sql.")));
    }
    body.replaceChildren(...out);
  }

  // ---------- composer: fill a box ----------
  let draft = null; // { day, gift, item, note }
  // item: { kind, blob?, preview, path?, body?, aspect, duration, ext?, type? }

  function openComposer(day) {
    const them = other();
    if (!them) return;
    const occasion = occasionOf(day, meId(), them.user_id);
    if (!occasion) return toast(tr("There's no box to fill on that day."));
    const g = sentFor(day);
    if (g?.opened_at) return openViewer(g);
    const c = g && contents.get(g.id);
    draft = { day, occasion, gift: g ?? null, item: null, note: c?.note ?? "" };
    if (c?.kind) {
      draft.item = {
        kind: c.kind, path: c.media_path, body: c.body, aspect: c.aspect, duration: c.duration,
        preview: c.kind === "gif" || c.kind === "sticker" ? c.body : null,
      };
    }
    const info = OCCASIONS[occasion];
    $("gc-title").textContent = `${info.emoji} ${tr("Box for {date}", { date: fmtDay(day) })}`;
    $("gc-sub").textContent = day === getToday()
      ? tr("{name} can open it as soon as it's wrapped.", { name: them.display_name })
      : tr("It appears on the board on {date}, for {name} to open.", { date: fmtDay(day), name: them.display_name });
    $("gc-note").value = draft.note;
    $("gc-delete").hidden = !g;
    renderDraft();
    $("gift-compose").showModal();
  }

  function renderDraft() {
    const p = $("gc-preview");
    const it = draft?.item;
    $("gc-remove").hidden = !it;
    for (const b of $("gc-kinds").children) b.hidden = !!it;
    if (!it) {
      p.replaceChildren(el("span", "muted", tr("Pick something to hide inside, or just write a note.")));
    } else {
      p.replaceChildren(mediaEl(it.kind, it.preview, it.body, true, it.path));
      if (!it.preview && it.path) fillSrc(p, it.path);
    }
    updateSave();
  }
  function updateSave() {
    $("gc-save").disabled = !draft || (!draft.item && !$("gc-note").value.trim());
  }

  /** An <img>, <video> or <audio> for a box's contents. */
  function mediaEl(kind, src, body, small, path) {
    if (kind === "gif" || kind === "sticker") {
      const img = el("img", `gv-img ${kind}`);
      img.alt = kind === "gif" ? "GIF" : "Sticker";
      img.src = body ?? src;
      return img;
    }
    if (kind === "photo") {
      const img = el("img", `gv-img${isDrawingPath(path) || draft?.item?.ext === "png" && small ? " drawing" : ""}`);
      img.alt = "";
      if (src) img.src = src;
      else img.dataset.path = path;
      return img;
    }
    const m = el(kind === "video" ? "video" : "audio", `gv-${kind}`);
    m.controls = true;
    m.preload = "metadata";
    if (kind === "video") m.playsInline = true;
    if (src) m.src = src;
    else m.dataset.path = path;
    if (kind === "audio") {
      const wrap = el("div", "gv-audio-wrap");
      wrap.append(el("span", "gv-audio-icon", "🎙️"), m);
      return wrap;
    }
    return m;
  }

  async function fillSrc(root, path) {
    try {
      const url = (await photos.urls([path])).get(path);
      if (!url) return;
      for (const m of root.querySelectorAll("[data-path]")) {
        m.src = m.tagName === "VIDEO" ? url + "#t=0.1" : url;
        m.removeAttribute("data-path");
      }
    } catch {}
  }

  $("gc-kinds").addEventListener("click", async (e) => {
    const k = e.target.closest("[data-gk]")?.dataset.gk;
    if (!k || !draft) return;
    const d = draft;
    let got;
    try {
      got = k === "photo" ? await pick.photo()
        : k === "draw" ? await pick.drawing()
        : k === "gif" ? await pick.gif()
        : await pick.record(k);
    } catch (err) {
      return toast(err.message ?? String(err));
    }
    if (!got || draft !== d) return;
    if (d.item?.preview?.startsWith("blob:")) URL.revokeObjectURL(d.item.preview);
    d.item = { ...got, preview: got.blob ? URL.createObjectURL(got.blob) : got.body };
    renderDraft();
  });
  $("gc-remove").addEventListener("click", () => {
    if (!draft) return;
    if (draft.item?.preview?.startsWith("blob:")) URL.revokeObjectURL(draft.item.preview);
    draft.item = null;
    renderDraft();
  });
  $("gc-note").addEventListener("input", updateSave);
  $("gift-compose").addEventListener("close", () => {
    stopAll();
    if (draft?.item?.preview?.startsWith("blob:")) URL.revokeObjectURL(draft.item.preview);
    draft = null;
    $("gc-preview").replaceChildren();
  });

  $("gc-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = draft;
    if (!d) return;
    const note = $("gc-note").value.trim();
    if (!d.item && !note) return;
    const btn = $("gc-save");
    btn.disabled = true;
    btn.textContent = tr("Wrapping…");
    const old = d.gift && contents.get(d.gift.id);
    let uploaded = null;
    try {
      const it = d.item;
      let path = it?.path ?? null;
      if (it?.blob) path = uploaded = await photos.upload(meId(), it.blob, it.ext, it.type);
      const { error } = await sb.rpc("create_gift", {
        g_day: d.day,
        g_note: note || null,
        g_kind: it?.kind ?? null,
        g_body: it && (it.kind === "gif" || it.kind === "sticker") ? it.body : null,
        g_path: path,
        g_aspect: it?.aspect ? Math.round(it.aspect * 100) / 100 : null,
        g_duration: it?.duration ?? null,
      });
      if (error) throw error;
      if (old?.media_path && old.media_path !== path) photos.remove(old.media_path).catch(() => {});
      if ($("gift-compose").open && draft === d) $("gift-compose").close();
      toast(tr("🎁 Wrapped! It's ready for {date}.", { date: fmtDay(d.day) }));
      await load();
    } catch (err) {
      if (uploaded) photos.remove(uploaded).catch(() => {});
      toast(tr("Couldn't wrap it: ") + (err.message ?? err));
    } finally {
      btn.textContent = tr("Wrap it 🎁");
      updateSave();
    }
  });

  $("gc-delete").addEventListener("click", async () => {
    const d = draft;
    if (!d?.gift || !confirm(tr("Empty this box? What's inside will be deleted."))) return;
    const old = contents.get(d.gift.id);
    const { data, error } = await sb.from("gifts").delete().eq("id", d.gift.id).select();
    if (error || !data?.length) return toast(error ? error.message : tr("It's already been opened."));
    if (old?.media_path) photos.remove(old.media_path).catch(() => {});
    $("gift-compose").close();
    await load();
  });

  // ---------- viewer: opening a box, and looking inside ----------
  let viewing = null;

  function openViewer(g) {
    viewing = g.id;
    const mine = g.from_id === meId();
    const info = OCCASIONS[g.occasion];
    $("gv-title").textContent = mine
      ? `${info.emoji} ${tr("Your box for {name}", { name: nameOf(g.to_id) })} · ${fmtDay(g.day)}`
      : `${info.emoji} ${fmtDay(g.day)} · ${tr("from {name}", { name: nameOf(g.from_id) })}`;
    const stage = $("gv-stage");
    stage.classList.remove("opening", "revealed");
    if (!mine && !g.opened_at) {
      const btn = el("button", "gv-box");
      btn.type = "button";
      btn.setAttribute("aria-label", tr("Open it"));
      btn.append(boxEl(g, { big: true }));
      btn.addEventListener("click", () => unwrap(g, btn), { once: true });
      stage.replaceChildren(btn);
      $("gv-meta").textContent = tr("Tap to open");
    } else {
      showContents(g);
    }
    if (!$("gift-view").open) $("gift-view").showModal();
  }

  async function unwrap(g, btn) {
    btn.disabled = true;
    $("gv-meta").textContent = "";
    $("gv-stage").classList.add("opening");
    const started = Date.now();
    const { error } = await sb.rpc("open_gift", { gift_id: g.id });
    const { data: c, error: err2 } = error ? { data: null } : await sb.from("gift_contents").select("*").eq("gift_id", g.id).maybeSingle();
    if (error || err2 || !c) {
      $("gv-stage").classList.remove("opening");
      btn.disabled = false;
      btn.addEventListener("click", () => unwrap(g, btn), { once: true });
      $("gv-meta").textContent = tr("Tap to open");
      return toast(tr("Couldn't open it: ") + (error?.message ?? err2?.message ?? tr("try again in a moment")));
    }
    contents.set(g.id, c);
    const row = gifts.get(g.id);
    if (row) row.opened_at = new Date().toISOString();
    if (c.media_path) photos.urls([c.media_path]).catch(() => {}); // warm up the link meanwhile
    await new Promise((r) => setTimeout(r, Math.max(0, OPEN_MS - (Date.now() - started))));
    if (viewing !== g.id || !$("gift-view").open) return render();
    showContents(row ?? g);
    render();
    reloadSoon();
  }

  function showContents(g) {
    const stage = $("gv-stage");
    const c = contents.get(g.id);
    const mine = g.from_id === meId();
    const wrap = el("div", "gv-content");
    if (c?.kind) wrap.append(mediaEl(c.kind, null, c.body, false, c.media_path));
    if (c?.note) wrap.append(el("p", "gv-note", c.note));
    if (!c) wrap.append(el("p", "muted", tr("It's empty.")));
    stage.replaceChildren(wrap);
    stage.classList.add("revealed");
    if (c?.media_path) fillSrc(wrap, c.media_path);
    $("gv-meta").textContent = g.opened_at
      ? `${mine ? tr("{name} opened it", { name: nameOf(g.to_id) }) : tr("Opened")} ${fmtWhen(g.opened_at)}`
      : mine ? tr("{name} hasn't opened it yet|box", { name: nameOf(g.to_id) }) : "";
  }

  $("gv-close").addEventListener("click", () => $("gift-view").close());
  $("gift-view").addEventListener("close", () => {
    stopAll();
    viewing = null;
    $("gv-stage").replaceChildren();
  });
  $("gift-btn").addEventListener("click", openPlanner);

  // ---------- lifecycle ----------
  async function start() {
    await load();
    channel = sb.channel("gifts")
      .on("postgres_changes", { event: "*", schema: "public", table: "gifts" }, reloadSoon)
      .subscribe();
  }

  function stop() {
    if (channel) sb.removeChannel(channel);
    channel = null;
    clearTimeout(reloadTimer);
    for (const d of ["gift-plan", "gift-compose", "gift-view"]) if ($(d).open) $(d).close();
    gifts.clear();
    contents.clear();
    birthdays.clear();
    announced.clear();
    shelfDays.clear();
    anniversary = null;
    loaded = false;
    missing = false;
    $("gift-badge").hidden = true;
  }

  return { start, stop, load, hasShelf: (day) => shelfDays.has(day) };
}
