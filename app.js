import * as config from "./config.js";
import { createMockClient, DEMO_USERS } from "./mock-supabase.js";
import { createLists } from "./lists.js";
import { createTrips } from "./trips.js";
import { createMail } from "./mail.js";

const { SUPABASE_URL, SUPABASE_ANON_KEY } = config;
// Optional, so an older config.js without it still loads
const PHOTOS_URL = (config.PHOTOS_URL || "").replace(/\/+$/, "");

// No real Supabase keys yet? Run against the in-browser demo backend.
const DEMO = SUPABASE_URL.includes("YOUR_") || SUPABASE_ANON_KEY.includes("YOUR_");
const isLocal = ["localhost", "127.0.0.1", ""].includes(location.hostname) || location.hostname.startsWith("192.168.");

// ---------------------------------------------------------------------------
// Board geometry. Everything is stored in "units": the board is 1000 units
// wide, so a layout looks identical on every screen size.
// ---------------------------------------------------------------------------
const W = 1000;
const EDGE = 12;                 // keep new items this far from the sides
const TEXT_SIZE = 46;            // default note size (~18px on an iPhone)
const TEXT_MIN = 20, TEXT_MAX = 160;
const PHOTO_W_LANDSCAPE = 560, PHOTO_W_PORTRAIT = 420, PHOTO_MIN = 160;
const TODAY_ROOM = 700;          // empty space kept below the lowest item on today's board
const DAYS_PER_PAGE = 7;         // how many past days to load at a time
const PHOTO_MAX_SIDE = 1600;     // px, longest side after resizing
const PHOTO_QUALITY = 0.82;      // JPEG quality

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
    b.textContent = `Sign in as ${u.display_name}`;
    b.addEventListener("click", () => {
      $("login-email").value = u.display_name;
      $("login-password").value = "demo";
      $("login-form").requestSubmit();
    });
    $("demo-login-buttons").append(b);
  }
  $("demo-reset").addEventListener("click", () => {
    if (confirm("Delete all demo notes and photos and start over?")) sb.resetDemo();
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
  if (!res.ok) throw new Error(out.error || `Photo storage error (${res.status})`);
  return out;
}

const photos = {
  async upload(userId, blob) {
    // randomUUID needs https/localhost; fall back for phones testing over LAN http
    const id = crypto.randomUUID?.() ??
      [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const path = `${userId}/${id}.jpg`;
    if (useR2) {
      await r2("PUT", `/o/${path}`, blob, { "Content-Type": "image/jpeg" });
      return path;
    }
    const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
      contentType: "image/jpeg",
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
      img.onerror = () => reject(new Error("That file couldn't be read as an image."));
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
  if (!blob) throw new Error("Couldn't process that image.");
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
  return new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", {
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
    s.textContent = m.display_name + (m.user_id === userId ? " (you)" : "");
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
  lists.start();
  trips.start();
  mail.start();
}

function teardown() {
  lists.stop();
  trips.stop();
  mail.stop();
  if (channel) sb.removeChannel(channel);
  channel = null;
  me = null;
  clearTimeout(midnightTimer);
  clearInterval(tickTimer);
  // park the floating bits before clearing the board
  $("app-view").append($("toolbar"), $("add-menu"));
  $("toolbar").hidden = $("add-menu").hidden = true;
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
    ? "Wrong name or password." : error.message;
  else {
    $("login-password").value = "";
    document.activeElement?.blur(); // dismiss the keyboard
  }
});

document.querySelectorAll(".signout-btn").forEach((b) =>
  b.addEventListener("click", () => {
    if (confirm("Sign out?")) sb.auth.signOut();
  })
);

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
    toast("Couldn't load the board: " + (err.message ?? err));
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
  hint.textContent = "Tap anywhere to leave a note or a photo";
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
  s.status.textContent = isToday ? `Today · ${formatLeft(msUntilMidnight())} left` : "";
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
  if (!isToday && count === 0) {
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
    el.className = `item ${it.kind}`;
    el.dataset.id = it.id;
    if (it.kind === "photo") {
      const img = document.createElement("img");
      img.alt = "Photo";
      img.decoding = "async";
      img.addEventListener("load", () => scheduleFit(it.day));
      el.append(img);
    }
    itemEls.set(it.id, el);
  }
  if (el.parentElement !== s.canvas) s.canvas.append(el);

  el.style.setProperty("--x", it.x);
  el.style.setProperty("--y", it.y);
  el.style.setProperty("--c", colorOf.get(it.author_id) ?? "var(--muted)");
  el.classList.toggle("editable", it.day === today && it.author_id === me?.id);

  if (it.kind === "text") {
    el.style.setProperty("--fs", it.size ?? TEXT_SIZE);
    if (el.textContent !== it.body) el.textContent = it.body;
  } else {
    el.style.setProperty("--w", it.w);
    el.style.setProperty("--ar", it.aspect);
    const img = el.querySelector("img");
    if (img.dataset.path !== it.image_path) {
      img.dataset.path = it.image_path;
      photos.urls([it.image_path]).then((u) => {
        const src = u.get(it.image_path);
        if (src) img.src = src;
      }).catch(() => {});
    }
  }
}

function removeItem(id) {
  const it = items.get(id);
  if (selectedId === id) deselect();
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
    toast(error ? friendly(error) : "That day is locked now, so it can't be changed.");
  }
}

function friendly(error) {
  const msg = error?.message ?? String(error);
  return /row-level security|violates/i.test(msg) ? "That day is locked now, so it can't be changed." : msg;
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
}

$("file-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  const pos = pendingPhotoPos;
  pendingPhotoPos = null;
  if (!file || !pos) return;
  if (file.type && !file.type.startsWith("image/")) return toast("Please pick an image.");

  // Placeholder while we resize + upload
  const s = sections.get(today);
  const ph = document.createElement("div");
  ph.className = "item photo uploading";
  ph.textContent = "Uploading…";
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
    toast("Couldn't add the photo: " + friendly(err));
  } finally {
    ph.remove();
    scheduleFit(today);
  }
});

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
  $("toolbar").hidden = true;
}
function showToolbar() {
  const it = items.get(selectedId);
  const el = itemEls.get(selectedId);
  const s = it && sections.get(it.day);
  if (!it || !el || !s) return deselect();
  const tb = $("toolbar");
  tb.querySelector('[data-act="edit"]').hidden = it.kind !== "text";
  tb.querySelector('[data-act="view"]').hidden = it.kind !== "photo";
  s.canvas.append(tb);
  tb.hidden = false;
  const above = el.offsetTop - tb.offsetHeight - 12;
  tb.style.top = (above < 0 ? el.offsetTop + el.offsetHeight + 12 : above) + "px";
  tb.style.left = clamp(el.offsetLeft, 6, s.canvas.clientWidth - tb.offsetWidth - 6) + "px";
}

board.addEventListener("click", (e) => {
  if (suppressClick) { suppressClick = false; return; }
  if (e.target.closest("#toolbar, #add-menu")) return;

  const itemEl = e.target.closest(".item[data-id]");
  if (itemEl) {
    const it = items.get(Number(itemEl.dataset.id));
    if (!it) return;
    closeAddMenu();
    if (itemEl.classList.contains("editable")) {
      if (selectedId !== it.id) select(it.id);
    } else {
      deselect();
      if (it.kind === "photo") openLightbox(itemEl.querySelector("img")?.src);
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
    $("toolbar").hidden = true;
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
      const w = round1(clamp(it.w * f, PHOTO_MIN, W - 2 * EDGE));
      saveItem(it, { w, x: round1(clamp(it.x, 0, W - w)) }, 500);
    }
  } else if (act === "delete") {
    if (!confirm(it.kind === "photo" ? "Delete this photo?" : "Delete this note?")) return;
    deselect();
    const { data, error } = await sb.from("items").delete().eq("id", it.id).select();
    if (error || !data?.length) return toast(error ? friendly(error) : "That day is locked now, so it can't be changed.");
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
  for (const s of sections.values()) updateSectionState(s);
  ensureSection(today);
  scheduleFit(prev);
  scheduleFit(today);
  toast("Midnight! Yesterday is locked in. A fresh day begins ✨");
  scheduleMidnight();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !me) return;
  checkDay();
  const s = sections.get(today);
  if (s) updateSectionState(s);
  resync();
  lists.load();
  trips.load();
  mail.load();
});
window.addEventListener("online", () => {
  if (!me) return;
  resync();
  lists.load();
  trips.load();
  mail.load();
});

// ---------------------------------------------------------------------------
// Tabs: Board / Lists / Trips / Mail
// ---------------------------------------------------------------------------
const TABS = ["board", "lists", "trips", "mail"];

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
const trips = createTrips({ sb, getMe: () => me, getMembers: () => memberList, colorOf, toast });
const mail = createMail({ sb, getMe: () => me, getMembers: () => memberList, toast, photos, compressImage });

let savedTab = "board";
try { savedTab = localStorage.getItem("duo-tab") ?? "board"; } catch {}
showTab(savedTab);

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
