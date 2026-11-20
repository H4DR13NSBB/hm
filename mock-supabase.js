// =============================================================================
// Demo backend. Used automatically while config.js still has placeholders.
// Mimics only the parts of supabase-js that the app uses, entirely in the browser:
//   - tables   -> localStorage (shared by all tabs on this origin)
//   - photos   -> IndexedDB
//   - session  -> sessionStorage (per tab, so tab 1 = Alex, tab 2 = Sam)
//   - realtime -> BroadcastChannel between tabs
// It enforces the same rules as the real database: board items can only be
// added today, and only moved/edited/deleted by their author, today.
// =============================================================================

export const DEMO_USERS = [
  { id: "00000000-0000-4000-8000-00000000000a", email: "alex@demo", display_name: "Alex" },
  { id: "00000000-0000-4000-8000-00000000000b", email: "sam@demo",  display_name: "Sam" },
];

const SESSION_KEY = "duo-demo-session";
const LATENCY = 120; // ms, so loading states are visible
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Table name -> storage key, which columns an update may change, and (for the
// generic tables) which columns an insert accepts + their defaults.
const ENTRY_COLS = ["day", "time", "kind", "title", "place", "url", "confirmation", "notes", "lat", "lng"];
const EXPENSE_COLS = ["kind", "paid_by", "amount_cents", "currency", "note", "spent_on"];
const TABLES = {
  items:      { key: "duo-demo-items",      editable: ["x", "y", "w", "size", "body"] },
  lists: {
    key: "duo-demo-lists", editable: ["name"], by: "created_by",
    fields: ["name", "trip_id"], required: ["name"], defaults: { trip_id: null },
  },
  list_items: {
    key: "duo-demo-list-items", editable: ["body", "done", "done_at"], by: "added_by",
    fields: ["list_id", "body"], required: ["list_id", "body"], defaults: { done: false, done_at: null },
  },
  trips: {
    key: "duo-demo-trips", editable: ["name", "destination", "start_date", "end_date"], by: "created_by",
    fields: ["name", "destination", "start_date", "end_date"], required: ["name", "start_date", "end_date"],
    defaults: { destination: null },
  },
  trip_entries: {
    key: "duo-demo-trip-entries", editable: ENTRY_COLS, by: "created_by",
    fields: ["trip_id", ...ENTRY_COLS], required: ["trip_id", "title"],
    defaults: Object.fromEntries(ENTRY_COLS.map((c) => [c, null])),
  },
  trip_expenses: {
    key: "duo-demo-trip-expenses", editable: EXPENSE_COLS, by: "created_by",
    fields: ["trip_id", ...EXPENSE_COLS], required: ["trip_id", "paid_by", "amount_cents", "currency"],
    defaults: { kind: "expense", note: null },
  },
  postcards: {
    key: "duo-demo-postcards", editable: [], by: "from_id",
    fields: ["to_id", "stamp", "front_image", "front_text", "front_bg", "back_image", "back_text", "back_bg"],
    required: ["to_id", "stamp"],
    defaults: { front_image: null, front_text: null, front_bg: null, back_image: null, back_text: null, back_bg: null, read_at: null },
  },
};
const DAY = 86_400_000;

/** Days in the post: normal distribution (mean 8.5, sd 2.2), redrawn until it's 2..15. Same as schema.sql. */
function deliveryDays() {
  for (;;) {
    const z = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
    const d = Math.round(8.5 + 2.2 * z);
    if (d >= 2 && d <= 15) return d;
  }
}
const isDelivered = (c) => Date.parse(c.delivers_at) <= Date.now();
// on delete cascade
const CASCADE = {
  lists: [["list_items", "list_id"]],
  trips: [["trip_entries", "trip_id"], ["trip_expenses", "trip_id"], ["lists", "trip_id"]],
};

const wait = (ms = LATENCY) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const rows = (table) => store.get(TABLES[table].key, []);
const save = (table, data) => store.set(TABLES[table].key, data);
const nextId = (data) => data.reduce((m, r) => Math.max(m, r.id), 0) + 1;

function today() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function addDays(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- photos in IndexedDB ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("duo-demo", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("photos");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("photos", mode);
    const req = fn(tx.objectStore("photos"));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- first-run sample data ----------
function drawDemoPhoto(w, h, paint) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  paint(c.getContext("2d"), w, h);
  return new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
}

/** Writes sample rows immediately; returns a promise for the sample photos. */
function seed() {
  const [a, b] = DEMO_USERS;
  const ago = (mins) => new Date(Date.now() - mins * 60_000).toISOString();

  if (!localStorage.getItem(TABLES.lists.key)) {
    save("lists", [
      { id: 1, name: "Call topics", created_by: a.id, created_at: ago(3000) },
      { id: 2, name: "Groceries", created_by: b.id, created_at: ago(2000) },
    ]);
    const li = (id, list_id, by, body, done = false) => ({
      id, list_id, body, done, done_at: done ? ago(100) : null, added_by: by.id, created_at: ago(2000 - id * 10),
    });
    save("list_items", [
      li(1, 1, a, "Christmas plans: whose family first?"),
      li(2, 1, b, "Book the dentist"),
      li(3, 1, b, "Weekend hike, which trail?"),
      li(4, 1, a, "Mum's birthday present", true),
      li(5, 2, b, "Oat milk"),
      li(6, 2, a, "Coffee beans"),
    ]);
  }

  if (!localStorage.getItem(TABLES.trips.key)) seedTrips(a, b, ago);
  if (!localStorage.getItem(TABLES.postcards.key)) seedPostcards(a, b);

  if (localStorage.getItem(TABLES.items.key)) return Promise.resolve();
  const t = today();
  const item = (id, day, author, rest) => ({
    id, day, author_id: author.id, w: null, aspect: null, size: null, body: null, image_path: null,
    created_at: ago(1000 - id), updated_at: ago(1000 - id), ...rest,
  });
  save("items", [
    item(1, addDays(t, -2), b, { kind: "text", x: 300, y: 50, size: 52, body: "Movie night was perfect 🍿" }),
    item(2, addDays(t, -2), a, { kind: "text", x: 560, y: 190, size: 44, body: "Again this weekend?" }),
    item(3, addDays(t, -1), a, { kind: "photo", x: 70, y: 50, w: 380, aspect: 0.75, image_path: "demo/flowers.jpg" }),
    item(4, addDays(t, -1), b, { kind: "text", x: 520, y: 230, size: 48, body: "these are beautiful 🌷" }),
    item(5, t, b, { kind: "text", x: 60, y: 50, size: 54, body: "Good morning ☀️\ncoffee's on me today" }),
    item(6, t, b, { kind: "photo", x: 400, y: 230, w: 540, aspect: 1.5, image_path: "demo/sunset.jpg" }),
    item(7, t, a, { kind: "text", x: 70, y: 660, size: 46, body: "This is demo mode. Tap empty space to add, tap your own things to move them." }),
  ]);
  return seedPhotos();
}

function seedTrips(a, b, ago) {
  const t = today();
  const s = addDays(t, 24); // an upcoming trip...
  const z = addDays(t, -60); // ...and a past one
  save("trips", [
    { id: 1, name: "Lisbon", destination: "Lisbon, Portugal", start_date: s, end_date: addDays(s, 4), created_by: a.id, created_at: ago(5000) },
    { id: 2, name: "Zermatt weekend", destination: "Zermatt, Switzerland", start_date: z, end_date: addDays(z, 2), created_by: b.id, created_at: ago(90000) },
  ]);
  const e = (id, trip_id, day, by, kind, title, rest = {}) => ({
    ...TABLES.trip_entries.defaults, id, trip_id, day, kind, title, created_by: by.id, created_at: ago(4000 - id), ...rest,
  });
  save("trip_entries", [
    e(1, 1, s, a, "flight", "Flight ZRH → LIS", { time: "07:40", place: "Lisbon Airport", confirmation: "LX2084 · K7Q2PX", lat: 38.7742, lng: -9.1342 }),
    e(2, 1, s, b, "stay", "Check in: Casa do Alfama", { time: "15:00", place: "Alfama, Lisbon", confirmation: "BK-558213", lat: 38.7118, lng: -9.1300, notes: "Key box code arrives by email the day before." }),
    e(3, 1, addDays(s, 1), a, "activity", "Tram 28 + Castelo de São Jorge", { time: "10:00", place: "Castelo de São Jorge", lat: 38.7139, lng: -9.1335 }),
    e(4, 1, addDays(s, 1), b, "food", "Dinner at Time Out Market", { time: "20:00", place: "Mercado da Ribeira", lat: 38.7071, lng: -9.1458 }),
    e(5, 1, addDays(s, 2), a, "transport", "Train to Sintra", { time: "09:30", place: "Rossio Station", lat: 38.7142, lng: -9.1410 }),
    e(6, 1, null, b, "food", "Pastéis de Belém", { place: "R. de Belém 84-92, Lisbon", lat: 38.6975, lng: -9.2032, url: "https://www.google.com/maps/place/Past%C3%A9is+de+Bel%C3%A9m/@38.6975,-9.2032,17z" }),
    e(7, 1, null, a, "place", "LX Factory", { lat: 38.7037, lng: -9.1785 }),
    e(8, 1, null, b, "place", "Miradouro da Senhora do Monte", { notes: "Sunset spot", lat: 38.7192, lng: -9.1328 }),
    e(9, 1, null, a, "activity", "Beach day in Cascais", {}),
    e(10, 2, z, b, "stay", "Hotel Bella Vista", { place: "Zermatt", lat: 46.0207, lng: 7.7491 }),
  ]);
  save("trip_expenses", [
    { id: 1, trip_id: 1, kind: "expense", paid_by: a.id, amount_cents: 64000, currency: "CHF", note: "Flights", spent_on: addDays(t, -10), created_by: a.id, created_at: ago(14000) },
    { id: 2, trip_id: 1, kind: "expense", paid_by: b.id, amount_cents: 52000, currency: "USD", note: "Apartment", spent_on: addDays(t, -8), created_by: b.id, created_at: ago(11000) },
    { id: 3, trip_id: 1, kind: "expense", paid_by: b.id, amount_cents: 4000, currency: "CHF", note: "Sintra train tickets", spent_on: addDays(t, -2), created_by: b.id, created_at: ago(3000) },
    { id: 4, trip_id: 2, kind: "expense", paid_by: a.id, amount_cents: 38000, currency: "CHF", note: "Hotel", spent_on: z, created_by: a.id, created_at: ago(90000) },
    { id: 5, trip_id: 2, kind: "settlement", paid_by: b.id, amount_cents: 19000, currency: "CHF", note: null, spent_on: addDays(z, 3), created_by: b.id, created_at: ago(85000) },
  ]);
  // packing list for Lisbon (a normal list tied to the trip)
  const lists = rows("lists");
  const listId = nextId(lists);
  save("lists", [...lists, { id: listId, name: "Packing: Lisbon", trip_id: 1, created_by: a.id, created_at: ago(4000) }]);
  const items = rows("list_items");
  let id = nextId(items);
  const p = (body, by, done = false) => ({ id: id++, list_id: listId, body, done, done_at: done ? ago(50) : null, added_by: by.id, created_at: ago(3900 - id) });
  save("list_items", [...items, p("Passports", a), p("Plug adapter (type F)", b), p("Sunscreen", b, true), p("Camera + charger", a), p("Comfy walking shoes", b)]);
}

function seedPostcards(a, b) {
  const at = (days) => new Date(Date.now() + days * DAY).toISOString();
  const pc = (id, from, to, sent, arrives, rest) => ({
    ...TABLES.postcards.defaults, id, from_id: from.id, to_id: to.id, stamp: "heart",
    front_bg: "#ffd6a5", back_bg: "#fbf7ef", sent_at: at(sent), delivers_at: at(arrives), created_at: at(sent), ...rest,
  });
  save("postcards", [
    pc(1, b, a, -12, -3, {
      stamp: "alps", front_image: "demo/sunset.jpg", front_text: "Greetings from the lake!",
      back_text: "Alex!\nThe sunsets here are unreal, I keep thinking you'd love this. Swam every morning, ate far too much cheese.\n\nWish you were here ♡\nSam",
      read_at: at(-2.5),
    }),
    pc(2, a, b, -9, -1, {
      stamp: "tulip", front_text: "thinking of you 🌷", front_bg: "#ffadad",
      back_text: "Sam,\nJust a little card to say hi from the other side of town. Is that silly? Probably. Sending it anyway.\n\nx Alex",
    }),
    pc(3, b, a, -2, 5, { stamp: "snail", front_text: "a surprise 🐌", front_bg: "#caffbf", back_text: "No peeking!" }),
    pc(4, a, b, -1, 7, { stamp: "moon", front_text: "goodnight 🌙", front_bg: "#1f2a44", back_text: "Sleep well." }),
  ]);
}

async function seedPhotos() {
  const sunset = await drawDemoPhoto(900, 600, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#2b2d6e"); sky.addColorStop(0.55, "#e8687f"); sky.addColorStop(1, "#ffcf7a");
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.fillStyle = "#fff3c4"; g.beginPath(); g.arc(w * 0.62, h * 0.7, 90, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#1d2440"; g.fillRect(0, h * 0.78, w, h * 0.22);
  });
  const flowers = await drawDemoPhoto(600, 800, (g, w, h) => {
    g.fillStyle = "#cfe8d0"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "#4f8a52"; g.lineWidth = 10;
    for (const [x, y, c] of [[180, 300, "#e8687f"], [320, 220, "#f3a5b5"], [430, 340, "#d9506a"]]) {
      g.beginPath(); g.moveTo(x, y); g.lineTo(300, h); g.stroke();
      g.fillStyle = c;
      for (let i = 0; i < 6; i++) {
        g.beginPath(); g.arc(x + Math.cos(i) * 45, y + Math.sin(i) * 45, 42, 0, Math.PI * 2); g.fill();
      }
      g.fillStyle = "#ffd36b"; g.beginPath(); g.arc(x, y, 30, 0, Math.PI * 2); g.fill();
    }
  });
  await idb("readwrite", (s) => { s.put(sunset, "demo/sunset.jpg"); return s.put(flowers, "demo/flowers.jpg"); });
}

export function createMockClient() {
  const photosReady = seed().catch(() => {}); // table rows are written synchronously

  let session = null;
  try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch {}
  const authListeners = new Set();
  const realtimeHandlers = new Set(); // { table, cb }
  const bus = "BroadcastChannel" in window ? new BroadcastChannel("duo-demo") : null;

  const me = () => session?.user?.id;

  function setSession(s) {
    session = s;
    try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch {}
    for (const cb of authListeners) cb(s ? "SIGNED_IN" : "SIGNED_OUT", s);
  }

  function dispatch(payload) {
    for (const h of realtimeHandlers) if (h.table === payload.table) h.cb(payload);
  }
  function emit(table, eventType, row) {
    const payload = { table, eventType, new: eventType === "DELETE" ? {} : row, old: { id: row.id } };
    dispatch(payload);
    bus?.postMessage(payload);
  }
  if (bus) bus.onmessage = (e) => dispatch(e.data);

  const notSignedIn = { data: null, error: { message: "Not signed in" } };
  const fail = (message) => ({ data: null, error: { message } });

  function matches(row, filters) {
    return filters.every(([op, col, val]) =>
      op === "eq" ? row[col] === val :
      op === "in" ? val.includes(row[col]) :
      op === "gte" ? row[col] >= val : true);
  }

  function makeRow(table, id, p) {
    const now = new Date().toISOString();
    const def = TABLES[table];
    if (def.fields) { // generic tables
      const row = { id, created_at: now, [def.by]: me(), ...def.defaults };
      for (const f of def.fields) if (f in p) row[f] = p[f];
      for (const f of def.required) if (row[f] == null || (typeof row[f] === "string" && !row[f].trim())) return null;
      if (table === "list_items" && !rows("lists").some((l) => l.id === row.list_id)) return null;
      if (table === "postcards") {
        if (row.to_id === me() || !DEMO_USERS.some((u) => u.id === row.to_id)) return null;
        if (!row.front_image && !row.front_text?.trim()) return null;
        row.sent_at = now;
        row.delivers_at = new Date(Date.now() + deliveryDays() * DAY).toISOString();
        row.read_at = null;
      }
      return row;
    }
    if (table === "items") {
      if (p.kind === "text" && !p.body?.trim()) return null;
      return {
        id, day: today(), author_id: me(), kind: p.kind, x: p.x, y: p.y,
        w: p.w ?? null, aspect: p.aspect ?? null, size: p.size ?? null,
        body: p.body ?? null, image_path: p.image_path ?? null, created_at: now, updated_at: now,
      };
    }
    return null;
  }

  function deleteRows(table, pred) {
    const all = rows(table);
    const gone = all.filter(pred);
    if (!gone.length) return gone;
    save(table, all.filter((r) => !gone.includes(r)));
    for (const r of gone) emit(table, "DELETE", r);
    for (const [child, col] of CASCADE[table] ?? []) {
      const ids = new Set(gone.map((r) => r.id));
      deleteRows(child, (r) => ids.has(r[col]));
    }
    return gone;
  }

  // Which rows may this user update/delete? (mirrors the RLS policies)
  function mayChange(table, row) {
    if (table === "items") return row.author_id === me() && row.day === today();
    if (table === "postcards") return false; // once posted, it's out of your hands
    return true;
  }

  async function run(q) {
    await wait();
    if (!me()) return notSignedIn;
    const one = (data) => (q.single ? data[0] ?? null : data);

    if (q.table === "members") {
      return { data: one(DEMO_USERS.map((u) => ({ user_id: u.id, display_name: u.display_name }))), error: null };
    }
    if (q.table === "settings") return { data: one([{ timezone: TIMEZONE }]), error: null };
    if (!TABLES[q.table]) return fail(`Demo: unknown table ${q.table}`);

    const all = rows(q.table);

    if (q.op === "select") {
      let data = all.filter((r) => matches(r, q.filters));
      // like RLS: you see what you sent, and what was sent to you once it has arrived
      if (q.table === "postcards") data = data.filter((c) => c.from_id === me() || (c.to_id === me() && isDelivered(c)));
      if (q.order) {
        const [col, asc] = q.order;
        data.sort((x, y) => (x[col] < y[col] ? -1 : x[col] > y[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (q.limit) data = data.slice(0, q.limit);
      return { data: one(data), error: null };
    }

    if (q.op === "insert") {
      const payloads = Array.isArray(q.payload) ? q.payload : [q.payload];
      let id = nextId(all);
      const created = payloads.map((p) => makeRow(q.table, id++, p));
      if (created.some((r) => !r)) return fail("new row violates check constraint");
      save(q.table, [...all, ...created]);
      for (const row of created) emit(q.table, "INSERT", row);
      return { data: one(created), error: null };
    }

    // update / delete: like RLS, rows you may not touch are silently skipped
    const targets = all.filter((r) => matches(r, q.filters) && mayChange(q.table, r));

    if (q.op === "update") {
      for (const r of targets) {
        for (const k of TABLES[q.table].editable) if (k in q.payload) r[k] = q.payload[k];
        if (q.table === "items") r.updated_at = new Date().toISOString();
      }
      save(q.table, all);
      for (const r of targets) emit(q.table, "UPDATE", r);
      return { data: one(targets), error: null };
    }

    if (q.op === "delete") {
      const ids = new Set(targets.map((r) => r.id));
      const gone = deleteRows(q.table, (r) => ids.has(r.id));
      return { data: one(gone), error: null };
    }
    return fail("Demo: unsupported query");
  }

  function from(table) {
    const q = { table, op: "select", filters: [], order: null, limit: null, payload: null, single: false };
    const builder = {
      select() { return builder; }, // after insert/update/delete this means "return the rows"
      insert(row) { q.op = "insert"; q.payload = row; return builder; },
      update(patch) { q.op = "update"; q.payload = patch; return builder; },
      delete() { q.op = "delete"; return builder; },
      eq(col, val) { q.filters.push(["eq", col, val]); return builder; },
      in(col, vals) { q.filters.push(["in", col, vals]); return builder; },
      gte(col, val) { q.filters.push(["gte", col, val]); return builder; },
      order(col, { ascending = true } = {}) { q.order = [col, ascending]; return builder; },
      limit(n) { q.limit = n; return builder; },
      single() { q.single = true; return builder; },
      maybeSingle() { q.single = true; return builder; },
      then(resolve, reject) { return run(q).then(resolve, reject); },
    };
    return builder;
  }

  return {
    isDemo: true,

    auth: {
      onAuthStateChange(cb) {
        authListeners.add(cb);
        setTimeout(() => cb("INITIAL_SESSION", session), 0);
        return { data: { subscription: { unsubscribe: () => authListeners.delete(cb) } } };
      },
      async signInWithPassword({ email }) {
        await wait();
        const u = DEMO_USERS.find((x) => x.email === email.trim().toLowerCase());
        if (!u) return fail("Demo accounts: alex@demo or sam@demo (any password)");
        setSession({ user: { id: u.id, email: u.email } });
        return { data: { session }, error: null };
      },
      async signOut() {
        setSession(null);
        return { error: null };
      },
    },

    from,

    async rpc(name, args) {
      await wait();
      if (!me()) return notSignedIn;
      if (name === "board_days") {
        const days = [...new Set(rows("items").map((r) => r.day))]
          .filter((d) => d < args.before)
          .sort()
          .reverse()
          .slice(0, args.n ?? 7);
        return { data: days.map((day) => ({ day })), error: null };
      }
      if (name === "mail_in_transit") {
        return { data: rows("postcards").filter((c) => c.to_id === me() && !isDelivered(c)).length, error: null };
      }
      if (name === "mark_postcard_read") {
        const all = rows("postcards");
        const c = all.find((r) => r.id === args.card_id && r.to_id === me() && isDelivered(r) && !r.read_at);
        if (c) {
          c.read_at = new Date().toISOString();
          save("postcards", all);
          emit("postcards", "UPDATE", c);
        }
        return { data: null, error: null };
      }
      return fail(`Demo: unknown function ${name}`);
    },

    // Edge Functions don't exist in demo mode; callers fall back gracefully.
    functions: {
      async invoke(name) {
        await wait();
        return { data: null, error: { message: `Demo mode: the "${name}" function only runs on Supabase` } };
      },
    },

    storage: {
      from() {
        return {
          async upload(path, blob) {
            await wait(400);
            await idb("readwrite", (s) => s.put(blob, path));
            return { data: { path }, error: null };
          },
          async remove(paths) {
            await idb("readwrite", (s) => { paths.forEach((p) => s.delete(p)); });
            return { data: null, error: null };
          },
          async createSignedUrls(paths) {
            await photosReady;
            const data = await Promise.all(paths.map(async (path) => {
              const blob = await idb("readonly", (s) => s.get(path));
              return { path, signedUrl: blob ? URL.createObjectURL(blob) : null };
            }));
            return { data, error: null };
          },
        };
      },
    },

    channel() {
      const mine = [];
      const ch = {
        on(_type, filter, cb) {
          const h = { table: filter.table, cb };
          mine.push(h);
          realtimeHandlers.add(h);
          return ch;
        },
        subscribe() { return ch; },
        _off() { mine.forEach((h) => realtimeHandlers.delete(h)); },
      };
      return ch;
    },
    removeChannel(ch) { ch._off?.(); },

    /** Demo only: everything still in the post arrives right now. Returns how many. */
    async demoDeliverMail() {
      await wait();
      const all = rows("postcards");
      const moving = all.filter((c) => !isDelivered(c));
      const now = new Date(Date.now() - 1000).toISOString();
      moving.forEach((c) => { c.delivers_at = now; });
      save("postcards", all);
      moving.forEach((c) => emit("postcards", "UPDATE", c));
      return moving.length;
    },

    /** Wipe all demo data + photos and start fresh (the samples come back). */
    async resetDemo() {
      for (const t of Object.values(TABLES)) localStorage.removeItem(t.key);
      await idb("readwrite", (s) => s.clear());
      location.reload();
    },
  };
}
