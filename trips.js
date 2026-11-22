// =============================================================================
// Trips tab: trip cards -> Plan (day-by-day), Ideas, Map, Packing, Money.
// Both people can edit everything; changes sync live.
// =============================================================================

import { tr, locale } from "./i18n.js";

const $ = (id) => document.getElementById(id);

export const KINDS = {
  flight:    { icon: "✈️", label: tr("Flight") },
  stay:      { icon: "🏨", label: tr("Stay") },
  activity:  { icon: "🎟", label: tr("Activity") },
  food:      { icon: "🍽", label: tr("Food") },
  train:     { icon: "🚆", label: tr("Train") },
  transport: { icon: "🚌", label: tr("Transport") },
  place:     { icon: "📍", label: tr("Place") },
  other:     { icon: "📝", label: tr("Other") },
};
const CURRENCIES = ["USD", "CHF"];
const SEGMENTS = ["plan", "ideas", "map", "packing", "money"];
// Card gradients to pick from, as hues: rose, coral, amber, lime, green, teal, blue, purple
const HUES = [345, 15, 35, 75, 130, 175, 215, 270];
// Older trips without a picked colour keep the one derived from their id
const hueOf = (t) => t.hue ?? (t.id * 67) % 360;
const LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
const LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";

// ---------- small helpers ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const localToday = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
function addDays(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const fmt = (day, opts) => new Date(day + "T12:00:00Z").toLocaleDateString(locale, { timeZone: "UTC", ...opts });
const fmtDay = (day) => fmt(day, { weekday: "short", day: "numeric", month: "short" });
function fmtRange(a, b) {
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  return `${fmt(a, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) })} – ${fmt(b, { day: "numeric", month: "short", year: "numeric" })}`;
}
const tripDates = (t) => (t.start_date ? fmtRange(t.start_date, t.end_date) : "");
function tripDays(t) {
  if (!t.start_date) return []; // trip idea, no dates yet
  const n = Math.min(daysBetween(t.start_date, t.end_date), 90);
  return Array.from({ length: n + 1 }, (_, i) => addDays(t.start_date, i));
}
function countdown(t) {
  const today = localToday();
  if (t.start_date > today) {
    const n = daysBetween(today, t.start_date);
    return n === 1 ? tr("Tomorrow") : tr("In {n} days", { n });
  }
  if (t.end_date >= today) return tr("Now ✈️");
  return "";
}
const money = (cents, cur) =>
  new Intl.NumberFormat(locale, { style: "currency", currency: cur }).format(Math.round(cents) / 100);
const byTime = (a, b) => (a.time ?? "99").localeCompare(b.time ?? "99") || a.created_at.localeCompare(b.created_at);
function normalizeUrl(s) {
  s = (s ?? "").trim();
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : "https://" + s;
}

// ---------- Google Maps links & geocoding ----------
function coordsFromUrl(url) {
  const m = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) // exact place position
    || url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)                    // map centre
    || url.match(/\/search\/(-?\d+\.\d+),\+?\s*(-?\d+\.\d+)/);     // dropped pin
  return m ? { lat: +m[1], lng: +m[2] } : null;
}
/** What can be read from a full Google Maps URL: name, coordinates, search text. */
export function infoFromMapsUrl(url) {
  const out = {};
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/maps\/place\/([^/]+)/);
    if (m) out.title = decodeURIComponent(m[1].replace(/\+/g, " "));
    Object.assign(out, coordsFromUrl(url) ?? {});
    const q = u.searchParams.get("q") || u.searchParams.get("query");
    if (q) {
      const qc = q.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/);
      if (qc && out.lat == null) { out.lat = +qc[1]; out.lng = +qc[2]; }
      else if (!qc) out.query = q;
    }
  } catch {}
  return out;
}
/** Split pasted share text ("Name\nAddress\nhttps://...") into its parts. */
export function parseSharedText(text) {
  const url = text.match(/https?:\/\/\S+/)?.[0].replace(/[)\]>,.]+$/, "") ?? null;
  const lines = (url ? text.replace(url, "") : text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return { url, title: lines[0] ?? null, place: lines[1] ?? null };
}

// OpenStreetMap's free geocoder allows ~1 request/second: queue them.
let geoQueue = Promise.resolve();
function geocode(query, near) {
  const run = async () => {
    const tryQ = async (q) => {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`,
        { headers: { "Accept-Language": "en" } });
      if (!r.ok) return null;
      const [hit] = await r.json();
      return hit ? { lat: +hit.lat, lng: +hit.lon, label: hit.display_name } : null;
    };
    let hit = near ? await tryQ(`${query}, ${near}`) : null;
    if (!hit) {
      if (near) await new Promise((r) => setTimeout(r, 1100));
      hit = await tryQ(query);
    }
    return hit;
  };
  const p = geoQueue.then(run, run);
  geoQueue = p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1100)));
  return p.catch(() => null);
}
/** Street address at a point ("84 Rua de Belém, Lisbon"), or null. */
function reverseGeocode(lat, lng) {
  const run = async () => {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`,
      { headers: { "Accept-Language": "en" } });
    if (!r.ok) return null;
    const { address: a } = await r.json();
    if (!a) return null;
    const street = [a.house_number, a.road].filter(Boolean).join(" ");
    const town = a.city || a.town || a.village || a.suburb;
    return [street, town].filter(Boolean).join(", ") || null;
  };
  const p = geoQueue.then(run, run);
  geoQueue = p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1100)));
  return p.catch(() => null);
}

// =============================================================================
export function createTrips({ sb, getMe, getMembers, colorOf, toast, resolveMapsLink }) {
  const trips = new Map();
  const entries = new Map();
  const expenses = new Map();
  const packLists = new Map();  // trip id -> list row
  const packItems = new Map();  // list_items row id -> row
  let currentId = null;
  let segment = "plan";
  let channel = null;
  let map = null, mapLayer = null, mapFittedFor = null, leafletPromise = null;

  let savedSeg = null;
  try { savedSeg = localStorage.getItem("duo-trip-seg"); } catch {}
  if (SEGMENTS.includes(savedSeg)) segment = savedSeg;

  // ---------- lifecycle ----------
  async function start() {
    await load();
    let savedTrip = null;
    try { savedTrip = Number(localStorage.getItem("duo-trip")); } catch {}
    if (trips.has(savedTrip)) { currentId = savedTrip; render(); }
    const on = (table, fn) => ["postgres_changes", { event: "*", schema: "public", table }, fn];
    channel = sb.channel("trips")
      .on(...on("trips", (p) => applyRow(trips, p)))
      .on(...on("trip_entries", (p) => applyRow(entries, p)))
      .on(...on("trip_expenses", (p) => applyRow(expenses, p)))
      .on(...on("lists", (p) => {
        if (p.eventType === "DELETE") {
          for (const [tid, l] of packLists) if (l.id === p.old.id) packLists.delete(tid);
        } else if (p.new.trip_id != null) packLists.set(p.new.trip_id, p.new);
        else return;
        render();
      }))
      .on(...on("list_items", (p) => {
        if (p.eventType === "DELETE") { if (!packItems.delete(p.old.id)) return; }
        else if (isPackList(p.new.list_id)) packItems.set(p.new.id, p.new);
        else return;
        render();
      }))
      .subscribe();
  }

  function stop() {
    if (channel) sb.removeChannel(channel);
    channel = null;
    for (const m of [trips, entries, expenses, packLists, packItems]) m.clear();
    currentId = null;
    mapFittedFor = null;
    render();
  }

  async function load() {
    const res = await Promise.all([
      sb.from("trips").select("*").order("start_date"),
      sb.from("trip_entries").select("*").order("created_at"),
      sb.from("trip_expenses").select("*").order("created_at"),
      sb.from("lists").select("*").order("created_at"),
      sb.from("list_items").select("*").order("created_at"),
    ]);
    const bad = res.find((r) => r.error);
    if (bad) return toast(tr("Couldn't load trips: ") + bad.error.message);
    const [t, e, x, l, li] = res.map((r) => r.data);
    for (const m of [trips, entries, expenses, packLists, packItems]) m.clear();
    t.forEach((r) => trips.set(r.id, r));
    e.forEach((r) => entries.set(r.id, r));
    x.forEach((r) => expenses.set(r.id, r));
    l.filter((r) => r.trip_id != null).forEach((r) => packLists.set(r.trip_id, r));
    li.filter((r) => isPackList(r.list_id)).forEach((r) => packItems.set(r.id, r));
    render();
  }

  function applyRow(m, p) {
    if (p.eventType === "DELETE") m.delete(p.old.id);
    else m.set(p.new.id, p.new);
    render();
  }

  const isPackList = (listId) => [...packLists.values()].some((l) => l.id === listId);
  const entriesOf = (tid) => [...entries.values()].filter((e) => e.trip_id === tid);
  const memberName = (id) => getMembers().find((m) => m.user_id === id)?.display_name ?? tr("Someone");

  /** Called when the Trips tab becomes visible (the map needs a resize nudge). */
  function onShow() {
    if (map && segment === "map") setTimeout(() => map.invalidateSize(), 0);
  }

  // ---------- rendering ----------
  function render() {
    const t = trips.get(currentId);
    $("trips-home").hidden = !!t;
    $("trip-detail").hidden = !t;
    if (t) renderDetail(t);
    else renderHome();
  }

  function renderHome() {
    currentId = null;
    const today = localToday();
    const all = [...trips.values()];
    const upcoming = all.filter((t) => t.end_date && t.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date));
    const past = all.filter((t) => t.end_date && t.end_date < today).sort((a, b) => b.start_date.localeCompare(a.start_date));
    const ideas = all.filter((t) => !t.start_date).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const out = upcoming.map(card);
    if (ideas.length) out.push(el("h3", "trips-subhead", tr("Trip ideas")), ...ideas.map(card));
    if (past.length) out.push(el("h3", "trips-subhead", tr("Past trips")), ...past.map(card));
    $("trip-cards").replaceChildren(...out);
    $("trips-empty").hidden = all.length > 0;
  }

  function card(t) {
    const b = el("button", "trip-card");
    b.type = "button";
    b.style.setProperty("--hue", hueOf(t));
    const badge = countdown(t);
    const top = el("div", "trip-card-top");
    top.append(el("span", "trip-card-name", t.name));
    if (badge) top.append(el("span", "trip-badge", badge));
    b.append(top, el("div", "trip-card-sub", [t.destination, tripDates(t)].filter(Boolean).join(" · ")));
    b.addEventListener("click", () => openTrip(t.id));
    return b;
  }

  function openTrip(id) {
    currentId = id;
    try { localStorage.setItem("duo-trip", String(id)); } catch {}
    render();
    $("trip-body").scrollTop = 0;
  }

  function renderDetail(t) {
    $("trip-name").textContent = t.name;
    $("trip-sub").textContent = [t.destination, tripDates(t), countdown(t)].filter(Boolean).join(" · ");
    for (const b of $("trip-segments").querySelectorAll("[data-seg]")) {
      b.setAttribute("aria-selected", String(b.dataset.seg === segment));
    }
    $("trip-body").hidden = segment === "map";
    $("trip-map-wrap").hidden = segment !== "map";
    $("pack-add").hidden = segment !== "packing";
    $("idea-paste").hidden = segment !== "ideas";

    const body = $("trip-body");
    if (segment === "plan") body.replaceChildren(...renderPlan(t));
    else if (segment === "ideas") body.replaceChildren(...renderIdeas(t));
    else if (segment === "packing") body.replaceChildren(...renderPacking(t));
    else if (segment === "money") body.replaceChildren(...renderMoney(t));
    else if (segment === "map") renderMap(t);
  }

  // ----- Plan -----
  function renderPlan(t) {
    const days = tripDays(t);
    const mine = entriesOf(t.id);
    const out = days.map((d, i) => {
      const sec = el("section", "plan-day");
      const head = el("div", "plan-day-head");
      head.append(el("h3", null, tr("Day {n}", { n: i + 1 })), el("span", "muted", fmtDay(d)), addButton(tr("Add to this day"), () => openEntry({ trip_id: t.id, day: d, kind: "activity" })));
      sec.append(head);
      const list = mine.filter((e) => e.day === d).sort(byTime);
      if (!list.length) sec.append(el("p", "plan-empty muted", tr("Nothing planned yet")));
      list.forEach((e) => sec.append(entryCard(e)));
      return sec;
    });
    if (!days.length) out.push(el("p", "muted center pad", tr("No dates yet. Edit the trip to set them, or collect ideas in the meantime.")));
    const outside = mine.filter((e) => e.day && !days.includes(e.day)).sort((a, b) => a.day.localeCompare(b.day) || byTime(a, b));
    if (outside.length) {
      const sec = el("section", "plan-day");
      sec.append(el("h3", "plan-outside", tr("Outside the trip dates")), ...outside.map((e) => entryCard(e, true)));
      out.push(sec);
    }
    return out;
  }

  // ----- Ideas -----
  function renderIdeas(t) {
    const ideas = entriesOf(t.id).filter((e) => !e.day).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const head = el("div", "seg-head");
    head.append(el("p", "muted", tr("Places and things you might do. Open one and pick a day to move it into the plan.")));
    const add = el("button", "primary small", tr("+ Add idea"));
    add.type = "button";
    add.addEventListener("click", () => openEntry({ trip_id: t.id, day: null, kind: "place" }));
    head.append(add);
    const out = [head];
    if (!ideas.length) out.push(el("p", "muted center pad", tr("No ideas yet. Paste a Google Maps link above, or add one by hand.")));
    ideas.forEach((e) => out.push(entryCard(e)));
    return out;
  }

  function entryCard(e, showDay = false) {
    const c = el("div", "entry-card");
    c.tabIndex = 0;
    c.setAttribute("role", "button");
    c.append(el("span", "entry-icon", KINDS[e.kind]?.icon ?? "📝"));
    const main = el("div", "entry-main");
    const title = el("div", "entry-title");
    if (e.time) title.append(el("span", "entry-time", e.time.slice(0, 5)));
    title.append(document.createTextNode(e.title));
    main.append(title);
    const sub = [showDay && e.day ? fmtDay(e.day) : null, e.place, e.confirmation ? tr("Ref {x}", { x: e.confirmation }) : null].filter(Boolean);
    if (sub.length) main.append(el("div", "entry-sub", sub.join(" · ")));
    if (e.notes) main.append(el("div", "entry-notes", e.notes));
    if (e.lat == null) main.append(el("div", "entry-nopin", tr("Not on the map")));
    c.append(main);
    if (e.url) {
      const a = el("a", "entry-link", "↗");
      a.href = e.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.setAttribute("aria-label", tr("Open link"));
      a.addEventListener("click", (ev) => ev.stopPropagation());
      c.append(a);
    }
    const open = () => openEntry(e);
    c.addEventListener("click", open);
    c.addEventListener("keydown", (ev) => { if (ev.key === "Enter") open(); });
    return c;
  }

  function addButton(label, onClick) {
    const b = el("button", "icon-btn small add-btn", "+");
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.addEventListener("click", onClick);
    return b;
  }

  // ----- Map -----
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    leafletPromise ??= new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = LEAFLET_CSS;
      document.head.append(css);
      const s = document.createElement("script");
      s.src = LEAFLET_JS;
      s.onload = resolve;
      s.onerror = () => { leafletPromise = null; reject(new Error(tr("Couldn't load the map"))); };
      document.head.append(s);
    });
    return leafletPromise;
  }

  async function renderMap(t) {
    const pinned = entriesOf(t.id).filter((e) => e.lat != null && e.lng != null);
    const missing = entriesOf(t.id).length - pinned.length;
    $("trip-map-note").textContent = !pinned.length
      ? tr("Nothing on the map yet. Add places in Plan or Ideas.")
      : missing ? tr(missing > 1 ? "{n} items without a location" : "1 item without a location", { n: missing }) : "";
    $("trip-map-note").hidden = !$("trip-map-note").textContent;

    try { await loadLeaflet(); } catch (err) { return toast(err.message); }
    if (currentId !== t.id || segment !== "map") return;
    const L = window.L;
    if (!map) {
      map = L.map("trip-map", { zoomControl: true, attributionControl: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      mapLayer = L.layerGroup().addTo(map);
    }
    map.invalidateSize();
    mapLayer.clearLayers();
    const days = tripDays(t);
    for (const e of pinned) {
      const dayIdx = e.day ? days.indexOf(e.day) : -1;
      const icon = L.divIcon({
        className: "pin" + (e.day ? "" : " idea"),
        html: `<span>${KINDS[e.kind]?.icon ?? "📍"}</span>${dayIdx >= 0 ? `<b>${dayIdx + 1}</b>` : ""}`,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
      });
      const popup = el("div", "pin-popup");
      popup.append(el("strong", null, e.title), el("div", "muted", e.day ? `${tr("Day {n}", { n: dayIdx + 1 })} · ${fmtDay(e.day)}${e.time ? " · " + e.time.slice(0, 5) : ""}` : tr("Idea")));
      const edit = el("button", "ghost small", tr("Open"));
      edit.type = "button";
      edit.addEventListener("click", () => openEntry(e));
      popup.append(edit);
      L.marker([e.lat, e.lng], { icon, title: e.title }).bindPopup(popup).addTo(mapLayer);
    }
    if (mapFittedFor !== t.id) {
      mapFittedFor = t.id;
      if (pinned.length) map.fitBounds(L.latLngBounds(pinned.map((e) => [e.lat, e.lng])), { padding: [40, 40], maxZoom: 15 });
      else map.setView([30, 0], 2);
    }
  }

  // ----- Packing -----
  function renderPacking(t) {
    const list = packLists.get(t.id);
    const items = list ? [...packItems.values()].filter((i) => i.list_id === list.id) : [];
    const open = items.filter((i) => !i.done).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const done = items.filter((i) => i.done).sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (!items.length) return [el("p", "muted center pad", tr("Nothing on the packing list yet. Add things below."))];
    const ul = el("ul", "entries");
    ul.append(...open.map(packRow), ...done.map(packRow));
    const out = [ul];
    if (done.length) out.push(el("p", "muted small-note", tr("{n} of {total} packed", { n: done.length, total: items.length })));
    return out;
  }

  function packRow(it) {
    const li = el("li", "entry" + (it.done ? " done" : ""));
    li.style.setProperty("--c", colorOf.get(it.added_by) ?? "var(--muted)");
    const check = el("button", "check");
    check.type = "button";
    check.setAttribute("aria-label", it.done ? tr("Mark as not packed") : tr("Mark as packed"));
    check.innerHTML = "<span>✓</span>";
    check.addEventListener("click", async () => {
      const done = !it.done;
      Object.assign(it, { done, done_at: done ? new Date().toISOString() : null });
      render();
      const { error } = await sb.from("list_items").update({ done: it.done, done_at: it.done_at }).eq("id", it.id);
      if (error) { toast(tr("Couldn't save: ") + error.message); load(); }
    });
    const text = el("span", "entry-text static", it.body);
    const del = el("button", "entry-del");
    del.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    del.type = "button";
    del.setAttribute("aria-label", tr("Delete"));
    del.addEventListener("click", async () => {
      packItems.delete(it.id);
      render();
      const { error } = await sb.from("list_items").delete().eq("id", it.id);
      if (error) { toast(tr("Couldn't delete: ") + error.message); load(); }
    });
    li.append(check, text, del);
    return li;
  }

  $("pack-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = trips.get(currentId);
    const input = $("pack-add-input");
    const body = input.value.trim();
    if (!t || !body) return;
    input.value = "";
    let list = packLists.get(t.id);
    if (!list) {
      const { data, error } = await sb.from("lists")
        .insert({ name: tr("Packing: {name}", { name: t.name }).slice(0, 60), trip_id: t.id, created_by: getMe().id })
        .select().single();
      if (error) { input.value = body; return toast(tr("Couldn't create the packing list: ") + error.message); }
      list = data;
      packLists.set(t.id, list);
    }
    const { data, error } = await sb.from("list_items")
      .insert({ list_id: list.id, body, added_by: getMe().id }).select().single();
    if (error) { input.value = body; return toast(tr("Couldn't add: ") + error.message); }
    packItems.set(data.id, data);
    render();
  });

  // ----- Money -----
  function balances(t) {
    const [a, b] = getMembers();
    const rows = [...expenses.values()].filter((x) => x.trip_id === t.id);
    return CURRENCIES.map((cur) => {
      let owedToA = 0, total = 0, count = 0;
      for (const x of rows.filter((r) => r.currency === cur)) {
        count++;
        const sign = x.paid_by === a?.user_id ? 1 : -1;
        if (x.kind === "settlement") owedToA += sign * x.amount_cents;
        else { owedToA += (sign * x.amount_cents) / 2; total += x.amount_cents; }
      }
      return { cur, owedToA, total, count, a, b };
    }).filter((r) => r.count > 0);
  }

  function renderMoney(t) {
    const out = [];
    const sums = balances(t);
    const box = el("div", "money-summary");
    if (!sums.length) box.append(el("p", "muted", tr("No expenses yet. Everything is split 50/50.")));
    for (const s of sums) {
      const row = el("div", "money-line");
      const left = el("div");
      const square = Math.abs(s.owedToA) < 1;
      const [debtor, creditor] = s.owedToA > 0 ? [s.b, s.a] : [s.a, s.b];
      left.append(
        el("div", "money-balance", square ? tr("{cur}: all square ✓", { cur: s.cur }) : tr("{a} owes {b} {amount}", { a: debtor?.display_name ?? "?", b: creditor?.display_name ?? "?", amount: money(Math.abs(s.owedToA), s.cur) })),
        el("div", "muted", tr("Total spent {amount}", { amount: money(s.total, s.cur) })),
      );
      row.append(left);
      if (!square && debtor && creditor) {
        const settle = el("button", "small", tr("Settle up"));
        settle.type = "button";
        settle.addEventListener("click", () => openExpense({
          trip_id: t.id, kind: "settlement", paid_by: debtor.user_id,
          amount_cents: Math.round(Math.abs(s.owedToA)), currency: s.cur, note: null,
        }));
        row.append(settle);
      }
      box.append(row);
    }
    out.push(box);

    const add = el("button", "primary small add-expense", tr("+ Add expense"));
    add.type = "button";
    add.addEventListener("click", () => openExpense({ trip_id: t.id }));
    out.push(add);

    const rows = [...expenses.values()].filter((x) => x.trip_id === t.id)
      .sort((x, y) => y.spent_on.localeCompare(x.spent_on) || y.created_at.localeCompare(x.created_at));
    for (const x of rows) {
      const r = el("div", "expense-row");
      r.tabIndex = 0;
      r.setAttribute("role", "button");
      r.style.setProperty("--c", colorOf.get(x.paid_by) ?? "var(--muted)");
      const left = el("div", "expense-main");
      const settle = x.kind === "settlement";
      left.append(
        el("div", "expense-title", settle ? tr("💸 {name} paid back", { name: memberName(x.paid_by) }) : (x.note || tr("Expense"))),
        el("div", "muted", `${settle ? "" : tr("{name} paid", { name: memberName(x.paid_by) }) + " · "}${fmtDay(x.spent_on)}`),
      );
      r.append(left, el("div", "expense-amount", money(x.amount_cents, x.currency)));
      r.addEventListener("click", () => openExpense(x));
      out.push(r);
    }
    return out;
  }

  // ---------- segment switching / header buttons ----------
  $("trip-segments").addEventListener("click", (e) => {
    const s = e.target.closest("[data-seg]")?.dataset.seg;
    if (!s) return;
    segment = s;
    try { localStorage.setItem("duo-trip-seg", s); } catch {}
    render();
    $("trip-body").scrollTop = 0;
  });
  $("trip-back").addEventListener("click", () => {
    currentId = null;
    try { localStorage.removeItem("duo-trip"); } catch {}
    render();
  });
  $("trip-new").addEventListener("click", () => openTripDialog(null));
  $("trip-edit").addEventListener("click", () => openTripDialog(trips.get(currentId)));

  // ---------- trip dialog ----------
  let editingTrip = null;
  let pickedHue = HUES[0];
  $("trip-hues").replaceChildren(...HUES.map((h) => {
    const b = el("button");
    b.type = "button";
    b.dataset.hue = h;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", `Hue ${h}`);
    b.style.setProperty("--hue", h);
    b.addEventListener("click", () => markHue(h));
    return b;
  }));
  function markHue(h) {
    pickedHue = h;
    for (const b of $("trip-hues").children) b.setAttribute("aria-checked", String(Number(b.dataset.hue) === h));
  }
  function openTripDialog(t) {
    editingTrip = t;
    // A new trip gets the next colour along, so two in a row don't match
    markHue(t ? hueOf(t) : HUES[trips.size % HUES.length]);
    const f = $("trip-form").elements;
    f.tname.value = t?.name ?? "";
    f.tdest.value = t?.destination ?? "";
    f.tstart.value = t?.start_date ?? "";
    f.tend.value = t?.end_date ?? "";
    $("trip-delete").hidden = !t;
    $("trip-dialog-title").textContent = t ? tr("Edit trip") : tr("New trip");
    $("trip-dialog").showModal();
  }
  $("trip-form").elements.tstart.addEventListener("change", (e) => {
    const end = $("trip-form").elements.tend;
    if (!end.value || end.value < e.target.value) end.value = e.target.value;
  });
  $("trip-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const row = {
      name: f.tname.value.trim(),
      destination: f.tdest.value.trim() || null,
      // One date alone means a one-day trip; none means a trip idea
      start_date: f.tstart.value || f.tend.value || null,
      end_date: f.tend.value || f.tstart.value || null,
      hue: pickedHue,
    };
    if (!row.name) return;
    if (row.end_date < row.start_date) return toast(tr("The trip ends before it starts."));
    if (row.start_date && daysBetween(row.start_date, row.end_date) > 90) return toast(tr("Trips can be at most 90 days long."));
    $("trip-dialog").close();
    if (editingTrip) {
      const { data, error } = await sb.from("trips").update(row).eq("id", editingTrip.id).select().single();
      if (error) return toast(tr("Couldn't save: ") + error.message);
      trips.set(data.id, data);
      render();
    } else {
      const { data, error } = await sb.from("trips").insert({ ...row, created_by: getMe().id }).select().single();
      if (error) return toast(tr("Couldn't create the trip: ") + error.message);
      trips.set(data.id, data);
      segment = "plan";
      openTrip(data.id);
    }
  });
  $("trip-delete").addEventListener("click", async () => {
    const t = editingTrip;
    if (!t || !confirm(tr('Delete "{name}" with its whole plan, ideas, packing list and expenses?', { name: t.name }))) return;
    $("trip-dialog").close();
    const { error } = await sb.from("trips").delete().eq("id", t.id);
    if (error) return toast(tr("Couldn't delete: ") + error.message);
    trips.delete(t.id);
    for (const [id, e] of entries) if (e.trip_id === t.id) entries.delete(id);
    for (const [id, x] of expenses) if (x.trip_id === t.id) expenses.delete(id);
    packLists.delete(t.id);
    currentId = null;
    render();
  });

  // ---------- entry dialog (plan items + ideas) ----------
  let editingEntry = null;
  let draftPin = { lat: null, lng: null, label: "" };

  function openEntry(e) {
    editingEntry = e.id ? e : null;
    draftPin = { lat: e.lat ?? null, lng: e.lng ?? null, label: "" };
    const t = trips.get(e.trip_id);
    const f = $("entry-form").elements;
    f.ekind.value = e.kind ?? "activity";
    f.etitle.value = e.title ?? "";
    const days = tripDays(t);
    f.eday.replaceChildren(new Option(tr("💡 Idea (no day yet)"), ""), ...days.map((d, i) => new Option(`${tr("Day {n}", { n: i + 1 })} · ${fmtDay(d)}`, d)));
    if (e.day && !days.includes(e.day)) f.eday.append(new Option(fmtDay(e.day), e.day));
    f.eday.value = e.day ?? "";
    f.etime.value = e.time?.slice(0, 5) ?? "";
    f.eplace.value = e.place ?? "";
    f.eurl.value = e.url ?? "";
    f.econf.value = e.confirmation ?? "";
    f.enotes.value = e.notes ?? "";
    $("entry-delete").hidden = !editingEntry;
    $("entry-dialog-title").textContent = editingEntry ? tr("Edit") : e.day ? tr("Add to the plan") : tr("Add an idea");
    updatePinStatus();
    $("entry-dialog").showModal();
  }

  function updatePinStatus(msg) {
    const s = $("entry-pin");
    if (msg) s.textContent = msg;
    else if (draftPin.lat != null) s.textContent = `📍 ${tr("On the map")}${draftPin.label ? ": " + draftPin.label.split(",").slice(0, 3).join(",") : ""}`;
    else s.textContent = tr("Not on the map yet. Type a place and tap Find.");
    $("entry-unpin").hidden = draftPin.lat == null;
  }

  $("entry-find").addEventListener("click", async () => {
    const f = $("entry-form").elements;
    const q = f.eplace.value.trim() || f.etitle.value.trim();
    if (!q) return updatePinStatus(tr("Type a place or a title first."));
    updatePinStatus(tr("Searching…"));
    const hit = await geocode(q, trips.get(currentId)?.destination);
    if (!hit) return updatePinStatus(tr("Couldn't find that. Try adding the city, or a full address."));
    draftPin = hit;
    updatePinStatus();
  });
  $("entry-unpin").addEventListener("click", () => {
    draftPin = { lat: null, lng: null, label: "" };
    updatePinStatus();
  });

  $("entry-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const row = {
      kind: f.ekind.value,
      title: f.etitle.value.trim(),
      day: f.eday.value || null,
      time: f.etime.value || null,
      place: f.eplace.value.trim() || null,
      url: normalizeUrl(f.eurl.value),
      confirmation: f.econf.value.trim() || null,
      notes: f.enotes.value.trim() || null,
      lat: draftPin.lat,
      lng: draftPin.lng,
    };
    if (!row.title) return;
    $("entry-dialog").close();
    const tripId = editingEntry?.trip_id ?? currentId;
    const { data, error } = editingEntry
      ? await sb.from("trip_entries").update(row).eq("id", editingEntry.id).select().single()
      : await sb.from("trip_entries").insert({ ...row, trip_id: tripId, created_by: getMe().id }).select().single();
    if (error) return toast(tr("Couldn't save: ") + error.message);
    entries.set(data.id, data);
    render();
    // Has a place but no pin? Try to find it quietly in the background.
    if (data.lat == null && data.place) {
      const hit = await geocode(data.place, trips.get(tripId)?.destination);
      if (hit && entries.get(data.id)?.lat == null) {
        const res = await sb.from("trip_entries").update({ lat: hit.lat, lng: hit.lng }).eq("id", data.id).select().single();
        if (!res.error) { entries.set(data.id, res.data); render(); }
      }
    }
  });

  $("entry-delete").addEventListener("click", async () => {
    const e = editingEntry;
    if (!e || !confirm(tr('Delete "{x}"?', { x: e.title }))) return;
    $("entry-dialog").close();
    const { error } = await sb.from("trip_entries").delete().eq("id", e.id);
    if (error) return toast(tr("Couldn't delete: ") + error.message);
    entries.delete(e.id);
    render();
  });

  // ---------- paste a Google Maps link (Ideas) ----------
  async function lookupShared(text) {
    const t = trips.get(currentId);
    if (!t) return;
    const shared = parseSharedText(text);
    if (!shared.url && !shared.title) return;
    $("idea-paste-btn").disabled = true;
    $("idea-paste-btn").textContent = tr("Looking up…");
    try {
      let info = shared.url ? infoFromMapsUrl(shared.url) : {};
      let host = "";
      try { host = new URL(shared.url).hostname; } catch {}
      if (/goo\.gl$/i.test(host)) {
        // short link: expanded server side (photos Worker, or Supabase function)
        const full = await resolveMapsLink(shared.url).catch(() => null);
        if (full) info = infoFromMapsUrl(full);
      }
      const title = shared.title ?? info.title ?? info.query ?? "";
      const draft = {
        trip_id: t.id, day: null, kind: "place", title,
        place: shared.place ?? (info.query && info.query !== title ? info.query : null),
        url: shared.url, lat: info.lat ?? null, lng: info.lng ?? null,
      };
      if (draft.lat == null && (draft.place || draft.title)) {
        const hit = await geocode(draft.place || draft.title, t.destination);
        if (hit) { draft.lat = hit.lat; draft.lng = hit.lng; }
      }
      // Google's links carry only the name and pin: fill in the street address
      if (draft.lat != null && !draft.place) draft.place = await reverseGeocode(draft.lat, draft.lng);
      $("idea-paste-input").value = "";
      openEntry(draft);
      if (!title) updatePinStatus(tr("Couldn't read the place name from that link. Type it in and tap Find."));
    } finally {
      $("idea-paste-btn").disabled = false;
      $("idea-paste-btn").textContent = tr("Look up");
    }
  }
  $("idea-paste").addEventListener("submit", (e) => {
    e.preventDefault();
    lookupShared($("idea-paste-input").value);
  });
  // Pasting a link looks it up straight away
  $("idea-paste-input").addEventListener("paste", () => {
    setTimeout(() => {
      const v = $("idea-paste-input").value;
      if (/https?:\/\//.test(v)) lookupShared(v);
    }, 0);
  });

  // ---------- expense dialog ----------
  let editingExpense = null;
  function openExpense(x) {
    editingExpense = x.id ? x : null;
    const t = trips.get(x.trip_id);
    const f = $("expense-form").elements;
    const members = getMembers();
    f.xpaid.replaceChildren(...members.map((m) => new Option(m.display_name, m.user_id)));
    f.xpaid.value = x.paid_by ?? getMe().id;
    f.xnote.value = x.note ?? "";
    f.xamount.value = x.amount_cents ? (x.amount_cents / 100).toFixed(2) : "";
    f.xcur.value = x.currency ?? "CHF";
    const today = localToday();
    f.xdate.value = x.spent_on ?? (today >= t.start_date && today <= t.end_date ? today : today);
    f.xsettle.checked = x.kind === "settlement";
    $("expense-delete").hidden = !editingExpense;
    $("expense-dialog-title").textContent = editingExpense ? tr("Edit expense") : x.kind === "settlement" ? tr("Settle up") : tr("Add expense");
    $("expense-dialog").showModal();
  }
  $("expense-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const amount = Math.round(parseFloat(f.xamount.value.replace(",", ".")) * 100);
    if (!(amount > 0)) return toast(tr("Enter an amount."));
    const row = {
      kind: f.xsettle.checked ? "settlement" : "expense",
      paid_by: f.xpaid.value,
      amount_cents: amount,
      currency: f.xcur.value,
      note: f.xnote.value.trim() || null,
      spent_on: f.xdate.value || localToday(),
    };
    $("expense-dialog").close();
    const { data, error } = editingExpense
      ? await sb.from("trip_expenses").update(row).eq("id", editingExpense.id).select().single()
      : await sb.from("trip_expenses").insert({ ...row, trip_id: currentId, created_by: getMe().id }).select().single();
    if (error) return toast(tr("Couldn't save: ") + error.message);
    expenses.set(data.id, data);
    render();
  });
  $("expense-delete").addEventListener("click", async () => {
    const x = editingExpense;
    if (!x || !confirm(tr("Delete this expense?"))) return;
    $("expense-dialog").close();
    const { error } = await sb.from("trip_expenses").delete().eq("id", x.id);
    if (error) return toast(tr("Couldn't delete: ") + error.message);
    expenses.delete(x.id);
    render();
  });

  return { start, stop, load, onShow };
}
