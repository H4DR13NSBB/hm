import * as config from "./config.js";
import { createMockClient, DEMO_USERS } from "./mock-supabase.js";
import { createLists } from "./lists.js";
import { createTrips } from "./trips.js";
import { createMail } from "./mail.js";
import { createQuestions } from "./questions.js";
import { createGames } from "./games.js";
import { createSketch } from "./sketch.js";
import { paint, renderPNG } from "./drawing.js";
import { createRecorder, pickFile, togglePlay, wirePlayer, fmtDuration, stopAll } from "./media.js";
import { createGifts } from "./gifts.js";
import { createWords } from "./words.js";
import { createPush } from "./push.js";
import { tr, locale, lang, setLang, translatePage } from "./i18n.js";

const { SUPABASE_URL, SUPABASE_ANON_KEY } = config;
// Optional, so an older config.js without it still loads
const PHOTOS_URL = (config.PHOTOS_URL || "").replace(/\/+$/, "");

// No real Supabase keys yet? Run against the in-browser demo backend.
const DEMO = SUPABASE_URL.includes("YOUR_") || SUPABASE_ANON_KEY.includes("YOUR_");
const isLocal = ["localhost", "127.0.0.1", ""].includes(location.hostname) || location.hostname.startsWith("192.168.");

translatePage();

// ---------------------------------------------------------------------------
// Board geometry. Everything is stored in "units": the board is 1000 units
// wide, so a layout looks identical on every screen size.
// ---------------------------------------------------------------------------
const W = 1000;
const EDGE = 12;                 // keep new items this far from the sides
const TEXT_SIZE = 34;            // default note size (~13px on an iPhone)
const TEXT_MIN = 20, TEXT_MAX = 160;
const TEXT_W_MIN = 80;           // narrowest a note can be dragged
const PHOTO_W_LANDSCAPE = 560, PHOTO_W_PORTRAIT = 420, PHOTO_MIN = 160;
const TODAY_ROOM = 700;          // empty space kept below the lowest item on today's board
const DAYS_PER_PAGE = 7;         // how many past days to load at a time
const PHOTO_MAX_SIDE = 1600;     // px, longest side after resizing
const PHOTO_QUALITY = 0.82;      // JPEG quality
const DRAW_W = 800;              // board units the full drawing pad width maps to
const DRAW_MAX_SIDE = 1200;      // px, longest side of a saved drawing
const AUDIO_W = 520, AUDIO_AR = 4.2, AUDIO_MIN = 300; // voice notes are a pill
const VIDEO_W_LANDSCAPE = 560, VIDEO_W_PORTRAIT = 400;

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const round1 = (v) => Math.round(v * 10) / 10;

const views = ["login-view", "denied-view", "app-view"];
function show(view) {
  for (const v of views) $(v).hidden = v !== view;
}

// ---------------------------------------------------------------------------
// Home Screen app plumbing
// ---------------------------------------------------------------------------
// The service worker caches files, so it's only used on the real site.
// Locally (Live Server) every save should show up on reload.
if ("serviceWorker" in navigator) {
  if (isLocal) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
  } else {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

// Keep the app pinned to the *visible* area. iOS Safari doesn't shrink the page
// when the keyboard opens; it scrolls it instead, which hides the header.
const vv = window.visualViewport;
function fitToViewport() {
  if (!vv) return;
  const root = document.documentElement;
  root.style.setProperty("--app-height", `${vv.height}px`);
  root.style.setProperty("--app-top", `${vv.offsetTop}px`);
  root.classList.toggle("keyboard-open", window.innerHeight - vv.height > 120);
}
if (vv) {
  vv.addEventListener("resize", fitToViewport);
  vv.addEventListener("scroll", fitToViewport);
  fitToViewport();
}

function maybeShowInstallHint() {
  let dismissed = false;
  try { dismissed = localStorage.getItem("duo-install-hint") === "dismissed"; } catch {}
  $("install-hint").hidden = !(isIOS && !isStandalone && !dismissed);
}
$("install-hint-close").addEventListener("click", () => {
  $("install-hint").hidden = true;
  try { localStorage.setItem("duo-install-hint", "dismissed"); } catch {}
});

// ---------------------------------------------------------------------------
// Backend: real Supabase, or the demo one
// ---------------------------------------------------------------------------
let sb;
if (DEMO) {
  sb = createMockClient();
  $("demo-login").hidden = false;
  $("demo-banner").hidden = false;
  for (const u of DEMO_USERS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = tr("Sign in as {name}", { name: u.display_name });
    b.addEventListener("click", () => {
      $("login-email").value = u.display_name;
      $("login-password").value = "demo";
      $("login-form").requestSubmit();
    });
    $("demo-login-buttons").append(b);
  }
  $("demo-reset").addEventListener("click", () => {
    if (confirm(tr("Delete all demo notes and photos and start over?"))) sb.resetDemo();
  });
} else {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// ---------------------------------------------------------------------------
// Photo storage. Everything storage-specific lives here so it can be swapped
// (e.g. for Cloudflare R2) without touching the rest of the app.
// ---------------------------------------------------------------------------
const BUCKET = "photos";
const URL_TTL = 60 * 60; // signed URL lifetime, seconds
const urlCache = new Map(); // path -> { url, expires }

// Cloudflare R2 via the duo-photos Worker (cloudflare/photos-worker.js), when configured.
const useR2 = !DEMO && !!PHOTOS_URL;

async function r2(method, route, body, headers = {}) {
  const { data } = await sb.auth.getSession();
  const res = await fetch(PHOTOS_URL + route, {
    method,
    body,
    headers: { ...headers, Authorization: `Bearer ${data.session?.access_token}` },
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || tr("Photo storage error ({status})", { status: res.status }));
  return out;
}

const photos = {
  async upload(userId, blob, ext = "jpg", type = "image/jpeg") {
    // randomUUID needs https/localhost; fall back for phones testing over LAN http
    const id = crypto.randomUUID?.() ??
      [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const path = `${userId}/${id}.${ext}`;
    if (useR2) {
      await r2("PUT", `/o/${path}`, blob, { "Content-Type": type });
      return path;
    }
    const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
      contentType: type,
      cacheControl: "31536000",
    });
    if (error) throw error;
    return path;
  },

  async remove(path) {
    if (useR2) await r2("DELETE", `/o/${path}`);
    else await sb.storage.from(BUCKET).remove([path]);
    urlCache.delete(path);
  },

  /** Returns Map<path, url> for the given paths, using the cache where possible. */
  async urls(paths) {
    const now = Date.now();
    const result = new Map();
    const missing = [];
    for (const p of new Set(paths)) {
      const hit = urlCache.get(p);
      if (hit && hit.expires > now + 60_000) result.set(p, hit.url);
      else missing.push(p);
    }
    if (missing.length && useR2) {
      const { urls, expires } = await r2("POST", "/sign", JSON.stringify({ paths: missing }),
        { "Content-Type": "application/json" });
      for (const [p, u] of Object.entries(urls)) {
        urlCache.set(p, { url: u, expires: expires * 1000 });
        result.set(p, u);
      }
    } else if (missing.length) {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(missing, URL_TTL);
      if (error) throw error;
      for (const item of data) {
        if (!item.signedUrl) continue;
        urlCache.set(item.path, { url: item.signedUrl, expires: now + URL_TTL * 1000 });
        result.set(item.path, item.signedUrl);
      }
    }
    return result;
  },
};

/** Resize + re-encode as JPEG so iPhone photos (~3-5 MB) become ~300 KB. */
async function compressImage(file) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(tr("That file couldn't be read as an image.")));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = source.width, h = source.height;
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // transparent PNGs get a white background
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", PHOTO_QUALITY));
  if (!blob) throw new Error(tr("Couldn't process that image."));
  return { blob, aspect: canvas.width / canvas.height };
}

// ---------------------------------------------------------------------------
// Dates, in the board's shared timezone (midnight is the same for both people)
// ---------------------------------------------------------------------------
let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function zonedNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}
function todayStr() {
  const p = zonedNow();
  return `${p.year}-${p.month}-${p.day}`;
}
function msUntilMidnight() {
  const p = zonedNow();
  return ((23 - p.hour) * 3600 + (59 - p.minute) * 60 + (60 - p.second)) * 1000;
}
function addDays(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function formatDay(day) {
  return new Date(day + "T12:00:00Z").toLocaleDateString(locale, {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}
function formatLeft(ms) {
  const mins = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let me = null;                    // { id }
let memberList = [];              // [{ user_id, display_name }], sorted by name
const colorOf = new Map();        // user id -> CSS colour var
let channel = null;
let activeUserId;                 // undefined until the first auth event
let today = null;                 // "YYYY-MM-DD" in the board timezone

const items = new Map();          // id -> item row
const itemEls = new Map();        // id -> element
const sections = new Map();       // day -> { day, el, canvas, status, hint }
const pending = new Map();        // id -> unsaved patch (see saveItem)

let oldestDay = null;             // oldest day loaded so far
let reachedStart = false;         // no more history to load
let loadingMore = false;
let selectedId = null;
let drag = null;
let suppressClick = false;
let midnightTimer = 0, tickTimer = 0;

const board = $("board");

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
sb.auth.onAuthStateChange((_event, session) => {
  // Defer: calling Supabase inside this callback can deadlock.
  setTimeout(() => handleSession(session), 0);
});

async function handleSession(session) {
  const userId = session?.user?.id ?? null;
  if (userId === activeUserId) return; // token refresh etc.
  activeUserId = userId;
  teardown();

  if (!userId) {
    show("login-view");
    return;
  }

  const [membersRes, settingsRes] = await Promise.all([
    sb.from("members").select("user_id, display_name"),
    sb.from("settings").select("timezone").maybeSingle(),
  ]);
  const members = membersRes.data;
  if (membersRes.error || !members?.some((m) => m.user_id === userId)) {
    show("denied-view");
    return;
  }
  if (settingsRes.data?.timezone) timezone = settingsRes.data.timezone;

  // Same colours on both phones: assign by name order
  members.sort((a, b) => a.display_name.localeCompare(b.display_name));
  members.forEach((m, i) => colorOf.set(m.user_id, `var(--c${(i % 2) + 1})`));
  memberList = members;
  $("legend").replaceChildren(...members.map((m) => {
    const s = document.createElement("span");
    s.title = m.display_name;
    s.setAttribute("aria-label", m.display_name);
    s.classList.toggle("me", m.user_id === userId);
    s.style.setProperty("--c", colorOf.get(m.user_id));
    return s;
  }));

  me = { id: userId };
  show("app-view");
  maybeShowInstallHint();
  updateUnit();
  today = todayStr();
  ensureSection(today);
  scheduleFit(today);
  await loadMore();
  subscribe();
  scheduleMidnight();
  gifts.start();
  lists.start();
  trips.start();
  mail.start();
  questions.start();
  games.start();
  words.start();
  push.start();
}

function teardown() {
  stopAll();
  gifts.stop();
  lists.stop();
  trips.stop();
  mail.stop();
  questions.stop();
  games.stop();
  words.stop();
  push.stop();
  if ($("settings").open) $("settings").close();
  if (channel) sb.removeChannel(channel);
  channel = null;
  me = null;
  clearTimeout(midnightTimer);
  clearInterval(tickTimer);
  // park the floating bits before clearing the board
  $("app-view").append($("toolbar"), $("add-menu"), $("width-handle"));
  $("toolbar").hidden = $("add-menu").hidden = $("width-handle").hidden = true;
  items.clear();
  itemEls.clear();
  sections.clear();
  pending.clear();
  $("days").replaceChildren();
  oldestDay = null;
  reachedStart = false;
  selectedId = null;
  drag = null;
  $("board-end").hidden = true;
}

// You sign in with just a name. Supabase needs an email, so the name becomes a
// placeholder address that never receives mail ("Zoé" -> zoe@duo.example.com).
// Create the users in Supabase with exactly these addresses.
const LOGIN_DOMAIN = DEMO ? "demo" : "duo.example.com";
function loginEmail(name) {
  name = name.trim();
  if (name.includes("@")) return name;
  const slug = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9._-]+/g, "");
  return `${slug}@${LOGIN_DOMAIN}`;
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter ?? e.target.querySelector("[type=submit]");
  btn.disabled = true;
  $("login-error").textContent = "";
  const { error } = await sb.auth.signInWithPassword({
    email: loginEmail($("login-email").value),
    password: $("login-password").value,
  });
  btn.disabled = false;
  if (error) $("login-error").textContent = error.message === "Invalid login credentials"
    ? tr("Wrong name or password.") : error.message;
  else {
    $("login-password").value = "";
    document.activeElement?.blur(); // dismiss the keyboard
  }
});

document.querySelectorAll(".signout-btn").forEach((b) =>
  b.addEventListener("click", async () => {
    if (!confirm(tr("Sign out?"))) return;
    await push.forget(); // this phone stops getting the notifications
    sb.auth.signOut();
  })
);

// English / French: the button shows the language you'd switch to
document.querySelectorAll(".lang-btn").forEach((b) => {
  b.textContent = b.closest("#settings") ? (lang === "fr" ? "English" : "Français") : lang === "fr" ? "EN" : "FR";
  b.setAttribute("aria-label", lang === "fr" ? "Switch to English" : "Passer en français");
  b.addEventListener("click", () => setLang(lang === "fr" ? "en" : "fr"));
});

// ---------------------------------------------------------------------------
// Loading the board (newest day first, older days as you scroll down)
// ---------------------------------------------------------------------------
async function loadMore() {
  if (loadingMore || reachedStart || !me) return;
  loadingMore = true;
  try {
    const before = oldestDay ?? addDays(today, 1);
    const { data: dayRows, error } = await sb.rpc("board_days", { before, n: DAYS_PER_PAGE });
    if (error) throw error;
    const days = dayRows.map((r) => r.day);
    if (days.length < DAYS_PER_PAGE) reachedStart = true;
    if (days.length) {
      const { data: rows, error: err2 } = await sb.from("items").select("*").in("day", days).order("created_at");
      if (err2) throw err2;
      await preloadPhotos(rows);
      rows.forEach(putItem);
      oldestDay = days.at(-1);
    }
  } catch (err) {
    toast(tr("Couldn't load the board: ") + (err.message ?? err));
  } finally {
    loadingMore = false;
    $("board-end").hidden = !reachedStart;
    // Still near the bottom (e.g. a short history)? Keep going.
    requestAnimationFrame(() => {
      if (reachedStart || !me || !board.clientWidth) return; // board tab hidden
      const s = $("board-sentinel").getBoundingClientRect();
      if (s.top < board.getBoundingClientRect().bottom + 600) loadMore();
    });
  }
}

new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) loadMore();
}, { root: board, rootMargin: "600px" }).observe($("board-sentinel"));

/** Fetch photo URLs in one batch, but never hold up the board for more than 1.5s. */
async function preloadPhotos(rows) {
  const paths = rows.filter((r) => r.image_path).map((r) => r.image_path);
  if (!paths.length) return;
  await Promise.race([photos.urls(paths).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}

/** Coming back to the app: iOS pauses live updates in the background, so catch up. */
async function resync() {
  if (!me) return;
  const from = oldestDay && oldestDay < today ? oldestDay : today;
  const { data, error } = await sb.from("items").select("*").gte("day", from).order("created_at");
  if (error) return;
  const ids = new Set(data.map((r) => r.id));
  for (const id of [...items.keys()]) if (!ids.has(id) && !pending.has(id)) removeItem(id);
  await preloadPhotos(data);
  for (const r of data) if (!pending.has(r.id) && drag?.it.id !== r.id) putItem(r);
}

function subscribe() {
  channel = sb
    .channel("board")
    .on("postgres_changes", { event: "*", schema: "public", table: "items" }, (payload) => {
      if (payload.eventType === "DELETE") return removeItem(payload.old.id);
      const row = payload.new;
      if (pending.has(row.id) || drag?.it.id === row.id) return; // our own edit in flight
      if (oldestDay && row.day < oldestDay) return;               // not loaded that far back
      putItem(row);
    })
    .subscribe();
}

// ---------------------------------------------------------------------------
// Day sections
// ---------------------------------------------------------------------------
function ensureSection(day) {
  let s = sections.get(day);
  if (s) return s;

  const el = document.createElement("section");
  el.className = "day";
  el.dataset.day = day;
  const head = document.createElement("header");
  head.className = "day-head";
  const status = document.createElement("span");
  status.className = "day-status";
  const date = document.createElement("time");
  date.dateTime = day;
  date.textContent = formatDay(day);
  head.append(status, date);
  const canvas = document.createElement("div");
  canvas.className = "canvas";
  const hint = document.createElement("p");
  hint.className = "canvas-hint";
  hint.textContent = tr("Tap anywhere to leave a note or a photo");
  canvas.append(hint);
  el.append(head, canvas);

  // newest first
  const next = [...$("days").children].find((c) => c.dataset.day < day);
  $("days").insertBefore(el, next ?? null);

  s = { day, el, canvas, status, hint };
  sections.set(day, s);
  updateSectionState(s);
  return s;
}

function updateSectionState(s) {
  const isToday = s.day === today;
  s.el.classList.toggle("today", isToday);
  s.status.textContent = isToday ? tr("Today · {left} left", { left: formatLeft(msUntilMidnight()) }) : "";
  for (const el of s.canvas.querySelectorAll(".item[data-id]")) {
    const it = items.get(Number(el.dataset.id));
    el.classList.toggle("editable", !!it && isToday && it.author_id === me?.id);
  }
}

// Section height follows its content. Today always keeps empty room below.
const fitQueue = new Set();
let fitRaf = 0;
function scheduleFit(day) {
  fitQueue.add(day);
  if (!fitRaf) fitRaf = requestAnimationFrame(() => {
    fitRaf = 0;
    for (const d of fitQueue) fitSection(d);
    fitQueue.clear();
  });
}
function fitSection(day) {
  const s = sections.get(day);
  if (!s || !board.clientWidth) return; // board tab hidden: refit when shown
  const u = unit();
  let bottom = 0, count = 0;
  for (const el of s.canvas.querySelectorAll(".item")) {
    count++;
    bottom = Math.max(bottom, (el.offsetTop + el.offsetHeight) / u);
  }
  const isToday = day === today;
  if (!isToday && count === 0 && !gifts.hasShelf(day)) {
    s.el.remove();
    sections.delete(day);
    return;
  }
  s.hint.hidden = !(isToday && count === 0);
  const h = isToday ? Math.max(bottom + TODAY_ROOM, (board.clientHeight - 40) / u) : bottom + 50;
  s.canvas.style.setProperty("--h", Math.ceil(h));
}

function unit() {
  return board.clientWidth / W;
}
function updateUnit() {
  if (!board.clientWidth) return; // board tab hidden
  board.style.setProperty("--u", `${unit()}px`);
  for (const d of sections.keys()) scheduleFit(d);
  if (selectedId != null) requestAnimationFrame(showToolbar);
}
new ResizeObserver(updateUnit).observe(board);

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
function putItem(it) {
  items.set(it.id, it);
  renderItem(it);
  scheduleFit(it.day);
}

function renderItem(it) {
  const s = ensureSection(it.day);
  let el = itemEls.get(it.id);
  if (!el) {
    el = document.createElement("div");
    // GIFs and stickers look and behave like photos
    el.className = it.kind === "text" || it.kind === "photo" ? `item ${it.kind}`
      : isMedia(it) ? `item media ${it.kind}` : `item photo ${it.kind}`;
    el.dataset.id = it.id;
    if (isMedia(it)) {
      const m = document.createElement(it.kind);
      m.preload = it.kind === "video" ? "metadata" : "none";
      m.playsInline = true;
      const play = document.createElement("button");
      play.type = "button";
      play.className = "play-btn";
      play.setAttribute("aria-label", tr("Play"));
      const dur = document.createElement("span");
      dur.className = "dur";
      if (it.kind === "audio") {
        const bars = document.createElement("span");
        bars.className = "bars";
        el.append(play, bars, dur, m);
      } else {
        m.addEventListener("loadeddata", () => scheduleFit(it.day));
        el.append(m, play, dur);
      }
      wirePlayer(el, m, it.duration);
    } else if (it.kind !== "text") {
      const img = document.createElement("img");
      img.alt = it.kind === "photo" ? "Photo" : it.kind === "gif" ? "GIF" : "Sticker";
      img.decoding = "async";
      img.addEventListener("load", () => scheduleFit(it.day));
      el.append(img);
    }
    el.classList.toggle("bare", isBare(it));
    itemEls.set(it.id, el);
  }
  if (el.parentElement !== s.canvas) s.canvas.append(el);

  el.style.setProperty("--x", it.x);
  el.style.setProperty("--y", it.y);
  el.style.setProperty("--c", colorOf.get(it.author_id) ?? "var(--muted)");
  el.classList.toggle("editable", it.day === today && it.author_id === me?.id);

  if (it.kind === "text") {
    el.style.setProperty("--fs", it.size ?? TEXT_SIZE);
    if (it.w) el.style.setProperty("--w", it.w); else el.style.removeProperty("--w");
    el.classList.toggle("sized", !!it.w);
    if (el.dataset.body !== it.body) {
      el.dataset.body = it.body;
      el.replaceChildren(...linkify(it.body));
    }
  } else if (isMedia(it)) {
    el.style.setProperty("--w", it.w);
    el.style.setProperty("--ar", it.aspect);
    const m = el.querySelector(it.kind);
    if (m.dataset.path !== it.image_path) {
      m.dataset.path = it.image_path;
      if (it.duration) el.querySelector(".dur").textContent = fmtDuration(it.duration);
      photos.urls([it.image_path]).then((u) => {
        const src = u.get(it.image_path);
        // #t: iPhones then show the first frame instead of a black box
        if (src) m.src = it.kind === "video" ? src + "#t=0.1" : src;
      }).catch(() => {});
    }
  } else {
    el.style.setProperty("--w", it.w);
    el.style.setProperty("--ar", it.aspect);
    const img = el.querySelector("img");
    if (it.kind !== "photo") {
      if (img.getAttribute("src") !== it.body) img.src = it.body;
    } else if (img.dataset.path !== it.image_path) {
      img.dataset.path = it.image_path;
      photos.urls([it.image_path]).then((u) => {
        const src = u.get(it.image_path);
        if (src) img.src = src;
      }).catch(() => {});
    }
  }
}

// Text with web addresses turned into links (www.… gets https:// added)
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)\]}'"]+$/, ""); // trailing punctuation isn't part of the link
    if (m.index > last) out.push(text.slice(last, m.index));
    const a = document.createElement("a");
    a.href = /^www\./i.test(url) ? "https://" + url : url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = url;
    out.push(a);
    last = m.index + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Drawings are stored like photos, but as transparent PNGs
const isDrawing = (it) => it.kind === "photo" && /\.png$/.test(it.image_path ?? "");
// Drawings and stickers have no frame and don't open full screen
const isBare = (it) => isDrawing(it) || it.kind === "sticker";
// Voice notes and videos play when tapped
const isMedia = (it) => it.kind === "audio" || it.kind === "video";

function removeItem(id) {
  const it = items.get(id);
  if (selectedId === id) deselect();
  itemEls.get(id)?.querySelector("audio, video")?.pause();
  itemEls.get(id)?.remove();
  itemEls.delete(id);
  items.delete(id);
  if (it) scheduleFit(it.day);
}

// Optimistic save: update the screen now, send to the server (debounced for +/-).
function saveItem(it, patch, debounceMs = 0) {
  const p = pending.get(it.id) ?? { patch: {}, before: { ...it }, timer: 0 };
  Object.assign(p.patch, patch);
  Object.assign(it, patch);
  pending.set(it.id, p);
  renderItem(it);
  scheduleFit(it.day);
  if (selectedId === it.id) requestAnimationFrame(showToolbar);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => flush(it.id), debounceMs);
}
async function flush(id) {
  const p = pending.get(id);
  if (!p) return;
  const { data, error } = await sb.from("items").update(p.patch).eq("id", id).select();
  if (pending.get(id) === p) pending.delete(id);
  if (error || !data?.length) {
    const it = items.get(id);
    if (it) { Object.assign(it, p.before); renderItem(it); scheduleFit(it.day); }
    toast(error ? friendly(error) : tr("That day is locked now, so it can't be changed."));
  }
}

function friendly(error) {
  const msg = error?.message ?? String(error);
  return /row-level security|violates/i.test(msg) ? tr("That day is locked now, so it can't be changed.") : msg;
}

// ---------------------------------------------------------------------------
// Adding things
// ---------------------------------------------------------------------------
let addPos = null;           // where on today's board (units) the next item goes
let pendingPhotoPos = null;

function openAddMenu(pos) {
  const s = sections.get(today);
  if (!s) return;
  addPos = pos;
  const m = $("add-menu");
  s.canvas.append(m);
  m.hidden = false;
  const u = unit();
  m.style.left = clamp(pos.x * u - m.offsetWidth / 2, 6, s.canvas.clientWidth - m.offsetWidth - 6) + "px";
  m.style.top = Math.max(6, pos.y * u - m.offsetHeight / 2) + "px";
}
function closeAddMenu() {
  $("add-menu").hidden = true;
}

$("add-menu").addEventListener("click", (e) => {
  e.stopPropagation();
  const kind = e.target.closest("button")?.dataset.add;
  if (!kind || !addPos) return;
  closeAddMenu();
  if (kind === "text") {
    const pos = addPos;
    openEditor("", (body) => createText(pos, body));
  } else if (kind === "draw") {
    const pos = addPos;
    openDraw((list) => addDrawing(list, (w, h) => ({
      x: clamp(pos.x - w / 2, EDGE, W - w - EDGE),
      y: Math.max(EDGE, pos.y - h / 2),
    })));
  } else if (kind === "gif") {
    const pos = addPos;
    openGifs((url, ratio, gk) => addGif(pos, url, ratio, gk));
  } else if (kind === "audio" || kind === "video") {
    const pos = addPos;
    recorder.record(kind).then((rec) => rec && addMedia(pos, rec));
  } else {
    pendingPhotoPos = addPos;
    $("file-input").click();
  }
});

// The + button: add in the middle of whatever part of today is on screen
$("fab").addEventListener("click", () => {
  deselect();
  const s = sections.get(today);
  if (!s) return;
  const u = unit();
  const cr = s.canvas.getBoundingClientRect();
  const br = board.getBoundingClientRect();
  const top = Math.max(cr.top, br.top), bottom = Math.min(cr.bottom, br.bottom);
  if (bottom - top < 160) {
    board.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => openAddMenu({ x: W / 2, y: 260 }), 350);
  } else {
    openAddMenu({ x: W / 2, y: ((top + bottom) / 2 - cr.top) / u });
  }
});

async function createText(pos, body) {
  const x = clamp(pos.x - 20, EDGE, W - 240);
  const y = Math.max(EDGE, pos.y - TEXT_SIZE / 2);
  const { data, error } = await sb.from("items")
    .insert({ kind: "text", author_id: me.id, x: round1(x), y: round1(y), size: TEXT_SIZE, body })
    .select().single();
  if (error) return toast(friendly(error));
  putItem(data);
  return data;
}

$("file-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  const pos = pendingPhotoPos;
  pendingPhotoPos = null;
  if (!file || !pos) return;
  if (file.type && !file.type.startsWith("image/")) return toast(tr("Please pick an image."));

  // Placeholder while we resize + upload
  const s = sections.get(today);
  const ph = document.createElement("div");
  ph.className = "item photo uploading";
  ph.textContent = tr("Uploading…");
  ph.style.setProperty("--w", 360);
  ph.style.setProperty("--ar", 4 / 3);
  ph.style.setProperty("--x", clamp(pos.x - 180, EDGE, W - 360 - EDGE));
  ph.style.setProperty("--y", Math.max(EDGE, pos.y - 135));
  s?.canvas.append(ph);

  let path = null;
  try {
    const { blob, aspect } = await compressImage(file);
    const w = aspect >= 1 ? PHOTO_W_LANDSCAPE : PHOTO_W_PORTRAIT;
    const h = w / aspect;
    const x = clamp(pos.x - w / 2, EDGE, W - w - EDGE);
    const y = Math.max(EDGE, pos.y - h / 2);
    ph.style.setProperty("--w", w);
    ph.style.setProperty("--ar", aspect);
    ph.style.setProperty("--x", x);
    ph.style.setProperty("--y", y);

    path = await photos.upload(me.id, blob);
    const { data, error } = await sb.from("items")
      .insert({ kind: "photo", author_id: me.id, x: round1(x), y: round1(y), w, aspect: round1(aspect * 100) / 100, image_path: path })
      .select().single();
    if (error) throw error;
    putItem(data);
  } catch (err) {
    if (path) photos.remove(path).catch(() => {});
    toast(tr("Couldn't add the photo: ") + friendly(err));
  } finally {
    ph.remove();
    scheduleFit(today);
  }
});

/** A voice note or video from the recorder goes on today's board at `pos`. */
async function addMedia(pos, rec) {
  const video = rec.kind === "video";
  const aspect = video ? round1(clamp(rec.aspect ?? 9 / 16, 0.1, 10) * 100) / 100 : AUDIO_AR;
  const w = video ? (aspect >= 1 ? VIDEO_W_LANDSCAPE : VIDEO_W_PORTRAIT) : AUDIO_W;
  const h = w / aspect;
  const x = clamp(pos.x - w / 2, EDGE, W - w - EDGE);
  const y = Math.max(EDGE, pos.y - h / 2);

  const s = sections.get(today);
  const ph = document.createElement("div");
  ph.className = "item photo uploading";
  ph.textContent = tr("Uploading…");
  ph.style.setProperty("--w", w);
  ph.style.setProperty("--ar", aspect);
  ph.style.setProperty("--x", x);
  ph.style.setProperty("--y", y);
  s?.canvas.append(ph);

  let path = null;
  try {
    path = await photos.upload(me.id, rec.blob, rec.ext, rec.type);
    const { data, error } = await sb.from("items")
      .insert({ kind: rec.kind, author_id: me.id, x: round1(x), y: round1(y), w, aspect, image_path: path, duration: rec.duration })
      .select().single();
    if (error) throw error;
    putItem(data);
  } catch (err) {
    if (path) photos.remove(path).catch(() => {});
    toast(tr(video ? "Couldn't add the video: " : "Couldn't add the voice note: ") + friendly(err));
  } finally {
    ph.remove();
    scheduleFit(today);
  }
}

// ---------------------------------------------------------------------------
// Drawing pad. Points are stored as fractions of the pad width and brush sizes
// relative to a 400px-wide pad, so a drawing survives the pad being resized.
// Used for board drawings and for Draw & Guess; Save hands the strokes on.
// ---------------------------------------------------------------------------
const pad = $("draw-pad");
const padCtx = pad.getContext("2d");
let strokes = [];            // [{ color, size, pts: [[x, y], ...] }]
let stroke = null;           // the one being drawn
let drawDone = null;         // (strokes) => void, what Save does
let drawColor = null, drawSize = 14;

function openDraw(onSave, { prompt = "", saveLabel = tr("Add") } = {}) {
  drawDone = onSave;
  strokes = [];
  $("draw-prompt").textContent = prompt;
  $("draw-prompt").hidden = !prompt;
  $("draw-save").textContent = saveLabel;
  // The first two are the two of you (--c1, --c2); your own is picked to start with
  const colors = ["#ff7e27", "#fd5ff2", "#ff0000", "#ffff00", "#00b0f0", "#66ff33", "#000000", "#ffffff"];
  drawColor = colorOf.get(me.id) === "var(--c2)" ? colors[1] : colors[0];
  $("draw-colors").replaceChildren(...colors.map((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.color = c;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", c);
    b.style.setProperty("--sw", c);
    return b;
  }));
  markDrawTools();
  $("draw").showModal();
  sizePad();
}

function markDrawTools() {
  for (const b of $("draw-colors").children) b.setAttribute("aria-checked", String(b.dataset.color === drawColor));
  for (const b of $("draw").querySelectorAll("[data-size]")) {
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(Number(b.dataset.size) === drawSize));
  }
}

function sizePad() {
  const dpr = Math.min(devicePixelRatio || 1, 3);
  pad.width = Math.round(pad.clientWidth * dpr);
  pad.height = Math.round(pad.clientHeight * dpr);
  repaintPad();
}
window.addEventListener("resize", () => { if ($("draw").open) sizePad(); });

function repaintPad() {
  padCtx.clearRect(0, 0, pad.width, pad.height);
  paint(padCtx, pad.width, 0, 0, strokes);
}

function padPoint(e) {
  const r = pad.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.width];
}
pad.addEventListener("pointerdown", (e) => {
  if (e.button > 0 || stroke) return; // one finger at a time
  pad.setPointerCapture(e.pointerId);
  stroke = { color: drawColor, size: drawSize, pts: [padPoint(e)], pid: e.pointerId };
  strokes.push(stroke);
  paint(padCtx, pad.width, 0, 0, [stroke]);
});
pad.addEventListener("pointermove", (e) => {
  if (!stroke || e.pointerId !== stroke.pid) return;
  for (const ev of e.getCoalescedEvents?.() ?? [e]) stroke.pts.push(padPoint(ev));
  repaintPad();
});
const endStroke = (e) => { if (stroke?.pid === e.pointerId) stroke = null; };
pad.addEventListener("pointerup", endStroke);
pad.addEventListener("pointercancel", endStroke);

$("draw").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.color) drawColor = b.dataset.color;
  else if (b.dataset.size) drawSize = Number(b.dataset.size);
  else if (b.id === "draw-undo") strokes.pop();
  else if (b.id === "draw-clear") strokes = [];
  else return;
  markDrawTools();
  repaintPad();
});

$("draw-save").addEventListener("click", () => {
  const done = drawDone, list = strokes;
  $("draw").close();
  if (list.length && done) done(list);
});

/**
 * Puts a drawing on today's board as a transparent PNG.
 * `place(w, h)` returns its top-left, in board units. Resolves to the item, or null.
 */
async function addDrawing(list, place) {
  const png = await renderPNG(list, DRAW_MAX_SIDE, pad.width || Infinity);
  if (!png.blob) {
    toast(tr("Couldn't save the drawing."));
    return null;
  }
  const aspect = round1(png.width / png.height * 100) / 100;
  const w = round1(clamp(png.bw * DRAW_W, 50, W - 2 * EDGE));
  const { x, y } = place(w, w / aspect);
  let path = null;
  try {
    path = await photos.upload(me.id, png.blob, "png", "image/png");
    const { data, error } = await sb.from("items")
      .insert({ kind: "photo", author_id: me.id, x: round1(x), y: round1(y), w, aspect, image_path: path })
      .select().single();
    if (error) throw error;
    putItem(data);
    return data;
  } catch (err) {
    if (path) photos.remove(path).catch(() => {});
    toast(tr("Couldn't add the drawing: ") + friendly(err));
    return null;
  }
}

/** Board units below the lowest thing on today's board. */
function bottomOfToday() {
  const u = unit();
  let bottom = 0;
  for (const it of items.values()) {
    if (it.day !== today) continue;
    const h = itemEls.get(it.id)?.offsetHeight;
    bottom = Math.max(bottom, it.y + (h && u ? h / u : it.w && it.aspect ? it.w / it.aspect : TEXT_SIZE * 2));
  }
  return bottom;
}

/** Draw & Guess: a finished drawing goes under today's board, with a caption note. */
async function pinToBoard(list, caption) {
  // show the board first: items can only be measured while it's visible
  showTab("board");
  updateUnit();
  await new Promise((r) => requestAnimationFrame(r));
  const top = bottomOfToday() + 40;
  const item = await addDrawing(list, (w) => ({ x: (W - w) / 2, y: top }));
  if (!item) return false;
  // under the drawing, but not so far right that a long caption wraps
  if (caption) await createText({ x: Math.min(item.x, 120) + 20, y: item.y + item.w / item.aspect + 12 + TEXT_SIZE / 2 }, caption);
  scheduleFit(today);
  itemEls.get(item.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}

/** Word of the day: a note under today's board. */
async function pinNote(body) {
  showTab("board");
  updateUnit();
  await new Promise((r) => requestAnimationFrame(r));
  const item = await createText({ x: 40, y: bottomOfToday() + 40 + TEXT_SIZE / 2 }, body);
  if (!item) return false;
  scheduleFit(today);
  itemEls.get(item.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}

// ---------------------------------------------------------------------------
// GIFs & stickers, searched on GIPHY through the photos Worker (it holds the
// API key). The board item just keeps GIPHY's link.
// ---------------------------------------------------------------------------
const GIF_W = { landscape: 480, portrait: 360, sticker: 320 };
let gifType = "gifs";        // or "stickers"
let gifDone = null;          // (url, aspect ratio, "gif" | "sticker") => void, what picking one does
let gifNext = 0;             // offset of the next page, null = no more
let gifSeq = 0, gifLoading = false, gifTimer = 0;

function openGifs(onPick) {
  gifDone = onPick;
  $("gif-q").value = "";
  markGifType();
  $("gif-picker").showModal();
  loadGifs(true);
}

function markGifType() {
  for (const b of $("gif-types").children) b.setAttribute("aria-selected", String(b.dataset.type === gifType));
  $("gif-q").placeholder = gifType === "stickers" ? tr("Search stickers") : tr("Search GIFs");
  $("gif-grid").classList.toggle("stickers", gifType === "stickers");
}

async function loadGifs(fresh) {
  const grid = $("gif-grid");
  if (fresh) {
    gifNext = 0;
    gifLoading = false;
    grid.replaceChildren();
    grid.scrollTop = 0;
  }
  if (gifNext == null || gifLoading) return;
  const seq = ++gifSeq;
  gifLoading = true;
  $("gif-status").textContent = tr("Loading…");
  try {
    if (!PHOTOS_URL) throw new Error("GIF search needs the photos Worker (PHOTOS_URL in config.js).");
    const q = new URLSearchParams({ type: gifType, q: $("gif-q").value.trim(), offset: gifNext });
    const { results, next } = await r2("GET", `/gifs?${q}`);
    if (seq !== gifSeq) return; // a newer search started meanwhile
    gifNext = next;
    grid.append(...results.map((r) => {
      const b = document.createElement("button");
      b.type = "button";
      Object.assign(b.dataset, { url: r.url, w: r.w, h: r.h });
      const img = document.createElement("img");
      img.src = r.preview;
      img.alt = r.title;
      img.loading = "lazy";
      b.append(img);
      return b;
    }));
    $("gif-status").textContent = grid.children.length ? "" : tr("Nothing found.");
  } catch (err) {
    if (seq === gifSeq) $("gif-status").textContent = err.message ?? String(err);
  } finally {
    if (seq === gifSeq) gifLoading = false;
  }
}

$("gif-q").addEventListener("input", () => {
  clearTimeout(gifTimer);
  gifTimer = setTimeout(() => loadGifs(true), 350);
});
$("gif-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } // just hide the keyboard
});
$("gif-types").addEventListener("click", (e) => {
  const type = e.target.closest("[data-type]")?.dataset.type;
  if (!type || type === gifType) return;
  gifType = type;
  markGifType();
  loadGifs(true);
});
$("gif-grid").addEventListener("scroll", (e) => {
  const g = e.target;
  if (g.scrollTop + g.clientHeight > g.scrollHeight - 300) loadGifs(false);
});
$("gif-grid").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-url]");
  if (!b) return;
  const done = gifDone;
  gifDone = null;
  $("gif-picker").close();
  done?.(b.dataset.url, Number(b.dataset.w) / Number(b.dataset.h), gifType === "stickers" ? "sticker" : "gif");
});

async function addGif(pos, url, ratio, kind) {
  const aspect = clamp(round1(ratio * 100) / 100, 0.1, 10);
  const w = kind === "sticker" ? GIF_W.sticker : aspect >= 1 ? GIF_W.landscape : GIF_W.portrait;
  const x = clamp(pos.x - w / 2, EDGE, W - w - EDGE);
  const y = Math.max(EDGE, pos.y - w / aspect / 2);
  const { data, error } = await sb.from("items")
    .insert({ kind, author_id: me.id, x: round1(x), y: round1(y), w, aspect, body: url })
    .select().single();
  if (error) return toast(tr(kind === "gif" ? "Couldn't add the GIF: " : "Couldn't add the sticker: ") + friendly(error));
  putItem(data);
}

// ---------------------------------------------------------------------------
// Selecting, moving, resizing, editing, deleting your own items (today only)
// ---------------------------------------------------------------------------
function select(id) {
  deselect();
  const el = itemEls.get(id);
  if (!el) return;
  selectedId = id;
  el.classList.add("selected");
  showToolbar();
}
function deselect() {
  if (selectedId != null) itemEls.get(selectedId)?.classList.remove("selected");
  selectedId = null;
  $("toolbar").hidden = $("width-handle").hidden = true;
}
function showToolbar() {
  const it = items.get(selectedId);
  const el = itemEls.get(selectedId);
  const s = it && sections.get(it.day);
  if (!it || !el || !s) return deselect();
  const tb = $("toolbar");
  tb.querySelector('[data-act="edit"]').hidden = it.kind !== "text";
  tb.querySelector('[data-act="view"]').hidden = it.kind === "text" || isBare(it) || isMedia(it);
  s.canvas.append(tb);
  tb.hidden = false;
  const above = el.offsetTop - tb.offsetHeight - 12;
  tb.style.top = (above < 0 ? el.offsetTop + el.offsetHeight + 12 : above) + "px";
  tb.style.left = clamp(el.offsetLeft, 6, s.canvas.clientWidth - tb.offsetWidth - 6) + "px";
  placeWidthHandle(it, el, s.canvas);
}
// Notes get a handle on their right edge to drag their width.
function placeWidthHandle(it, el, canvas) {
  const h = $("width-handle");
  h.hidden = it.kind !== "text";
  if (h.hidden) return;
  canvas.append(h);
  h.style.left = el.offsetLeft + el.offsetWidth + "px";
  h.style.top = el.offsetTop + el.offsetHeight / 2 + "px";
}

board.addEventListener("click", (e) => {
  if (suppressClick) { suppressClick = false; e.preventDefault(); return; } // also stops a dragged link opening
  if (e.target.closest("#toolbar, #add-menu, #width-handle, .gift-shelf")) return;
  if (e.target.closest(".item a[href]")) return; // links open; tap the rest of the note to select it

  const itemEl = e.target.closest(".item[data-id]");
  if (itemEl) {
    const it = items.get(Number(itemEl.dataset.id));
    if (!it) return;
    closeAddMenu();
    // voice notes and videos: tap to play (your own: the play button, so the rest still selects)
    if (isMedia(it) && (e.target.closest(".play-btn") || !itemEl.classList.contains("editable"))) {
      togglePlay(itemEl.querySelector(it.kind));
      return;
    }
    if (itemEl.classList.contains("editable")) {
      if (selectedId !== it.id) select(it.id);
    } else {
      deselect();
      if (it.kind !== "text" && !isBare(it)) openLightbox(itemEl.querySelector("img")?.src);
    }
    return;
  }

  // Tapping empty space first dismisses whatever is open
  if (selectedId != null || !$("add-menu").hidden) {
    deselect();
    closeAddMenu();
    return;
  }
  const canvas = e.target.closest(".day.today .canvas");
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  const u = unit();
  openAddMenu({ x: (e.clientX - r.left) / u, y: (e.clientY - r.top) / u });
});

// Drag: only a selected item moves, so scrolling over items still works.
board.addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".item.selected");
  if (!el || e.button > 0) return;
  const it = items.get(Number(el.dataset.id));
  if (!it) return;
  drag = { it, el, pid: e.pointerId, sx: e.clientX, sy: e.clientY, st: board.scrollTop, ox: it.x, oy: it.y, x: it.x, y: it.y, moved: false };
  el.setPointerCapture(e.pointerId);
});
board.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pid) return;
  const u = unit();
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy + (board.scrollTop - drag.st);
  if (!drag.moved && Math.hypot(dx, dy) < 6) return;
  if (!drag.moved) {
    drag.moved = true;
    drag.el.classList.add("dragging");
    $("toolbar").hidden = $("width-handle").hidden = true;
  }
  drag.x = clamp(drag.ox + dx / u, 0, W - drag.el.offsetWidth / u);
  drag.y = Math.max(0, drag.oy + dy / u);
  drag.el.style.setProperty("--x", drag.x);
  drag.el.style.setProperty("--y", drag.y);
  // nudge-scroll when dragging near the top/bottom edge
  const br = board.getBoundingClientRect();
  if (e.clientY > br.bottom - 56) board.scrollTop += 14;
  else if (e.clientY < br.top + 56) board.scrollTop -= 14;
  scheduleFit(drag.it.day);
});
function endDrag(e, cancelled) {
  if (!drag || e.pointerId !== drag.pid) return;
  const d = drag;
  drag = null;
  d.el.classList.remove("dragging");
  if (!d.moved) return;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 60);
  if (cancelled) {
    renderItem(d.it);
    requestAnimationFrame(showToolbar);
    return;
  }
  saveItem(d.it, { x: round1(d.x), y: round1(d.y) });
}
board.addEventListener("pointerup", (e) => endDrag(e, false));
board.addEventListener("pointercancel", (e) => endDrag(e, true));

let widthDrag = null;
$("width-handle").addEventListener("pointerdown", (e) => {
  const it = items.get(selectedId);
  const el = itemEls.get(selectedId);
  if (!it || !el || e.button > 0) return;
  e.stopPropagation();
  e.preventDefault();
  widthDrag = { it, el, pid: e.pointerId, left: el.getBoundingClientRect().left, w: null };
  e.currentTarget.setPointerCapture(e.pointerId);
  $("toolbar").hidden = true;
});
$("width-handle").addEventListener("pointermove", (e) => {
  const d = widthDrag;
  if (!d || e.pointerId !== d.pid) return;
  const u = unit();
  d.w = clamp((e.clientX - d.left) / u, TEXT_W_MIN, W - d.it.x);
  d.el.style.setProperty("--w", d.w);
  d.el.classList.add("sized");
  placeWidthHandle(d.it, d.el, d.el.parentElement);
  scheduleFit(d.it.day);
});
function endWidthDrag(e) {
  const d = widthDrag;
  if (!d || e.pointerId !== d.pid) return;
  widthDrag = null;
  if (d.w == null) return showToolbar();
  saveItem(d.it, { w: round1(d.w) });
}
$("width-handle").addEventListener("pointerup", endWidthDrag);
$("width-handle").addEventListener("pointercancel", endWidthDrag);
$("width-handle").addEventListener("click", (e) => e.stopPropagation());

$("toolbar").addEventListener("click", async (e) => {
  e.stopPropagation();
  const act = e.target.closest("button")?.dataset.act;
  const it = items.get(selectedId);
  if (!act || !it) return;

  if (act === "edit") {
    openEditor(it.body, (body) => saveItem(it, { body }));
  } else if (act === "view") {
    openLightbox(itemEls.get(it.id)?.querySelector("img")?.src);
  } else if (act === "bigger" || act === "smaller") {
    const f = act === "bigger" ? 1.15 : 1 / 1.15;
    if (it.kind === "text") {
      saveItem(it, { size: round1(clamp((it.size ?? TEXT_SIZE) * f, TEXT_MIN, TEXT_MAX)) }, 500);
    } else {
      const w = round1(clamp(it.w * f, isBare(it) ? 50 : it.kind === "audio" ? AUDIO_MIN : PHOTO_MIN, W - 2 * EDGE));
      saveItem(it, { w, x: round1(clamp(it.x, 0, W - w)) }, 500);
    }
  } else if (act === "delete") {
    const what = isDrawing(it) ? "drawing" : { text: "note", photo: "photo", gif: "GIF", sticker: "sticker", audio: "voice note", video: "video" }[it.kind];
    if (!confirm(tr(`Delete this ${what}?`))) return;
    deselect();
    const { data, error } = await sb.from("items").delete().eq("id", it.id).select();
    if (error || !data?.length) return toast(error ? friendly(error) : tr("That day is locked now, so it can't be changed."));
    if (it.image_path) photos.remove(it.image_path).catch(() => {});
    removeItem(it.id);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { deselect(); closeAddMenu(); }
});

// ---------------------------------------------------------------------------
// Note editor
// ---------------------------------------------------------------------------
let editorSave = null;
function openEditor(initial, onSave) {
  $("editor-text").value = initial ?? "";
  editorSave = onSave;
  $("editor").showModal();
  $("editor-text").focus();
}
$("editor-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = $("editor-text").value.trim();
  const save = editorSave;
  editorSave = null;
  $("editor").close();
  if (value && save) save(value);
});
$("editor-cancel").addEventListener("click", () => {
  editorSave = null;
  $("editor").close();
});

// ---------------------------------------------------------------------------
// Midnight: today's section locks and a fresh one appears on top
// ---------------------------------------------------------------------------
function scheduleMidnight() {
  clearTimeout(midnightTimer);
  clearInterval(tickTimer);
  midnightTimer = setTimeout(checkDay, msUntilMidnight() + 500);
  tickTimer = setInterval(() => {
    checkDay();
    const s = sections.get(today);
    if (s) updateSectionState(s);
  }, 30_000);
}

function checkDay() {
  if (!me) return;
  const now = todayStr();
  if (now === today) return;
  const prev = today;
  today = now;
  deselect();
  closeAddMenu();
  if ($("editor").open) { editorSave = null; $("editor").close(); }
  if ($("draw").open) $("draw").close();
  if ($("gif-picker").open) $("gif-picker").close();
  for (const s of sections.values()) updateSectionState(s);
  ensureSection(today);
  scheduleFit(prev);
  scheduleFit(today);
  words.render();
  toast(tr("Midnight! Yesterday is locked in. A fresh day begins ✨"));
  scheduleMidnight();
  gifts.load(); // today's boxes appear
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !me) return;
  checkDay();
  const s = sections.get(today);
  if (s) updateSectionState(s);
  resync();
  gifts.load();
  lists.load();
  trips.load();
  mail.load();
  questions.load();
  games.load();
});
window.addEventListener("online", () => {
  if (!me) return;
  resync();
  gifts.load();
  lists.load();
  trips.load();
  mail.load();
  questions.load();
  games.load();
});

// ---------------------------------------------------------------------------
// Tabs: Board / Lists / Trips / Questions / Games / Mail
// ---------------------------------------------------------------------------
const TABS = ["board", "lists", "trips", "questions", "games", "mail"];

function showTab(name) {
  if (!TABS.includes(name)) name = "board";
  for (const t of TABS) $(`pane-${t}`).hidden = t !== name;
  for (const b of $("tabbar").querySelectorAll("[data-tab]")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === name));
  }
  deselect();
  closeAddMenu();
  if (name === "trips") trips?.onShow();
  if (name === "mail") mail?.onShow();
  try { localStorage.setItem("duo-tab", name); } catch {}
}
$("tabbar").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]")?.dataset.tab;
  if (tab) showTab(tab);
});
const lists = createLists({ sb, getMe: () => me, colorOf, toast, openEditor });
// Google Maps short links -> full URL (a browser can't follow the redirect itself)
async function resolveMapsLink(url) {
  if (useR2) return (await r2("POST", "/resolve", JSON.stringify({ url }), { "Content-Type": "application/json" })).url;
  const { data, error } = await sb.functions.invoke("resolve-maps-link", { body: { url } });
  if (error) throw error;
  return data.url;
}
const trips = createTrips({ sb, getMe: () => me, getMembers: () => memberList, colorOf, toast, resolveMapsLink });
const questions = createQuestions({ sb, getMe: () => me, getMembers: () => memberList, colorOf, toast, openEditor });
const sketch = createSketch({
  sb, getMe: () => me, getMembers: () => memberList, colorOf, toast, openDraw, pinToBoard,
  onChange: () => games.render(),
});
const games = createGames({ sb, getMe: () => me, getMembers: () => memberList, colorOf, toast, sketch });
const words = createWords({ sb, getMe: () => me, getToday: () => today, toast, pinNote });
const mail = createMail({ sb, getMe: () => me, getMembers: () => memberList, toast, photos, compressImage });
const push = createPush({
  sb, getMe: () => me, toast, demo: DEMO, isIOS, isStandalone,
  publicKey: isLocal ? "" : config.PUSH_PUBLIC_KEY || "", // no service worker locally
  callWorker: useR2 ? (route, body) => r2("POST", route, JSON.stringify(body), { "Content-Type": "application/json" }) : null,
});
$("settings-btn").addEventListener("click", () => {
  push.render();
  $("settings").showModal();
});
const recorder = createRecorder();
// What a gift box can hold. Each resolves to the thing picked, or null.
// (Cancelling the drawing pad or GIF picker just leaves the box as it was.)
const giftPickers = {
  async photo() {
    const file = await pickFile("image/*");
    if (!file) return null;
    if (file.type && !file.type.startsWith("image/")) throw new Error(tr("Please pick an image."));
    const { blob, aspect } = await compressImage(file);
    return { kind: "photo", blob, aspect, ext: "jpg", type: "image/jpeg" };
  },
  drawing() {
    return new Promise((resolve) => openDraw(async (list) => {
      const png = await renderPNG(list, DRAW_MAX_SIDE, pad.width || Infinity);
      resolve(png.blob ? { kind: "photo", blob: png.blob, aspect: png.width / png.height, ext: "png", type: "image/png" } : null);
    }, { saveLabel: tr("Use") }));
  },
  gif() {
    return new Promise((resolve) => openGifs((url, ratio, kind) =>
      resolve({ kind, body: url, aspect: clamp(ratio, 0.1, 10) })));
  },
  record: (kind) => recorder.record(kind),
};
const gifts = createGifts({
  sb, getMe: () => me, getMembers: () => memberList, colorOf, toast, photos,
  getToday: () => today, ensureSection, pick: giftPickers,
  onShelvesChanged: (days) => days.forEach(scheduleFit),
});

let savedTab = "board";
try { savedTab = localStorage.getItem("duo-tab") ?? "board"; } catch {}
// Opened from a notification: go to its tab
const linkedTab = new URLSearchParams(location.search).get("tab");
if (linkedTab) {
  savedTab = linkedTab;
  history.replaceState(null, "", location.pathname);
}
showTab(savedTab);
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type === "open-tab") showTab(e.data.tab);
});

// Any "Cancel" button in a form sheet closes its dialog
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => b.closest("dialog")?.close())
);

// ---------------------------------------------------------------------------
// Little helpers
// ---------------------------------------------------------------------------
let toastTimer = 0;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function openLightbox(src) {
  if (!src) return;
  $("lightbox-img").src = src;
  $("lightbox").showModal();
}
$("lightbox-close").addEventListener("click", () => $("lightbox").close());
$("lightbox").addEventListener("click", (e) => {
  if (e.target === $("lightbox")) $("lightbox").close(); // tap the black area
});
