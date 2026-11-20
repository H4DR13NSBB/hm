// =============================================================================
// Mail tab: send each other postcards.
// A postcard has a front and a back (photo and/or text on each), a stamp, and
// takes 2 to 15 days to arrive. The delivery date is picked by the database
// (see postcard_post() in schema.sql), so nobody can choose it or peek early:
// the recipient simply can't read the row until it has arrived.
// =============================================================================

import { tr, locale } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const DAY = 86_400_000;
const POLL_MS = 60_000; // arrivals aren't a database event, so check now and then

export const STAMPS = [
  { id: "heart",  emoji: "💌", label: tr("Love"),       value: "1.20", color: "#d9506a" },
  { id: "alps",   emoji: "🏔️", label: tr("Alpine"),     value: "1.00", color: "#4b7bb5" },
  { id: "snail",  emoji: "🐌", label: tr("Snail mail"), value: "0.50", color: "#6f9a4f" },
  { id: "tulip",  emoji: "🌷", label: tr("Spring"),     value: "0.90", color: "#c9628e" },
  { id: "sun",    emoji: "🌞", label: tr("Summer"),     value: "1.10", color: "#e39a2d" },
  { id: "moon",   emoji: "🌙", label: tr("Night post"), value: "1.40", color: "#3b3f7a" },
  { id: "coffee", emoji: "☕", label: tr("Café"),       value: "0.80", color: "#8a5a3c" },
  { id: "wave",   emoji: "🌊", label: tr("Seaside"),    value: "1.30", color: "#2a8fa3" },
  { id: "cat",    emoji: "🐈", label: tr("Cat post"),   value: "2.00", color: "#8467bf" },
];
const STAMP_COLORS = [...new Set(STAMPS.map((s) => s.color))];
const CUSTOM_KEY = "duo-mail-stamp"; // last home-made stamp (not the picture), to reuse next time
const SWATCHES =["#ffd6a5", "#fdffb6", "#caffbf", "#9bf6ff", "#bdb2ff", "#ffadad", "#fbf7ef", "#1f2a44"];
const FRONT_BG = SWATCHES[0];
const BACK_BG = "#fbf7ef";
const LIMITS = { front: 200, back: 500 };

// ---------- small helpers ----------
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
function inkFor(hex) {
  const n = parseInt((hex || BACK_BG).slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#2a2420" : "#fbf7ef";
}
function fmtDate(ts) {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(locale, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}
function since(ts) {
  const d = Math.floor((Date.now() - Date.parse(ts)) / DAY);
  return d <= 0 ? tr("today") : d === 1 ? tr("yesterday") : tr("{n} days ago", { n: d });
}
const daysInPost = (c) => Math.max(1, Math.round((Date.parse(c.delivers_at) - Date.parse(c.sent_at)) / DAY));

// ---------- drawing a postcard ----------
function imgEl(ref, cls = "pc-img") {
  const img = el("img", cls);
  img.alt = "";
  img.decoding = "async";
  if (/^(blob|data):/.test(ref)) img.src = ref; // unsent draft
  else img.dataset.path = ref;                   // stored photo, signed URL fetched later
  return img;
}

/** spec = a preset id, or a home-made { emoji, label, value, color, img } */
function stampEl(spec) {
  const s = spec && typeof spec === "object" ? spec : STAMPS.find((x) => x.id === spec) ?? STAMPS[0];
  const stamp = el("div", "stamp");
  stamp.style.setProperty("--sc", s.color || STAMPS[0].color);
  const art = el("div", "stamp-art");
  if (s.img) { art.classList.add("has-img"); art.append(imgEl(s.img, "stamp-img")); }
  else if (s.emoji) art.append(el("span", "stamp-emoji", s.emoji));
  if (s.value) art.append(el("span", "stamp-value", s.value));
  if (s.label) art.append(el("span", "stamp-label", s.label));
  stamp.append(art);
  return stamp;
}

function postmarkEl(ts) {
  const d = new Date(ts);
  const day = d.toLocaleDateString(locale, { day: "numeric", month: "short" }).toUpperCase();
  const wrap = el("div", "pc-postmark");
  const waves = [30, 45, 60, 75].map((y) => `<path d="M104 ${y}q12 -7 24 0t24 0t24 0t24 0t24 0t24 0"/>`).join("");
  wrap.innerHTML = `<svg viewBox="0 0 260 110" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round">
      <circle cx="55" cy="55" r="46"/><circle cx="55" cy="55" r="37" stroke-width="1.6"/>${waves}
    </g>
    <g fill="currentColor" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="800">
      <text x="55" y="41" font-size="11" letter-spacing="2">DUO POST</text>
      <text x="55" y="62" font-size="17">${day}</text>
      <text x="55" y="79" font-size="12">${d.getFullYear()}</text>
    </g></svg>`;
  return wrap;
}

function sizeTier(len, tiers) {
  for (const [max, name] of tiers) if (len <= max) return name;
  return tiers.at(-1)[1];
}

function fillFront(face, side, { hint = false } = {}) {
  const bg = side.bg || FRONT_BG;
  face.style.setProperty("--pc-bg", bg);
  face.style.setProperty("--pc-ink", inkFor(bg));
  const parts = [];
  const text = (side.text ?? "").trim();
  if (side.img) parts.push(imgEl(side.img));
  if (text && side.img) parts.push(el("div", "pc-caption", text));
  if (text && !side.img) {
    parts.push(el("div", "pc-big " + sizeTier(text.length, [[14, "xl"], [40, "l"], [100, "m"], [Infinity, "s"]]), text));
  }
  if (!parts.length && hint) parts.push(el("div", "pc-hint", tr("Add a photo or write something big")));
  face.replaceChildren(...parts);
}

function fillBack(face, side, { stamp, toName, postmark, hint = false }) {
  const bg = side.bg || BACK_BG;
  const ink = inkFor(bg);
  face.style.setProperty("--pc-bg", bg);
  face.style.setProperty("--pc-ink", ink);
  face.style.setProperty("--pc-line", ink === "#2a2420" ? "rgba(42,36,32,.28)" : "rgba(251,247,239,.35)");

  const msg = el("div", "pc-msg");
  const text = (side.text ?? "").trim();
  if (side.img) msg.append(imgEl(side.img));
  if (text) {
    const t = el("div", "pc-msg-text", text);
    t.classList.add(sizeTier(text.length + (side.img ? 150 : 0), [[120, "l"], [260, "m"], [Infinity, "s"]]));
    msg.append(t);
  }
  if (side.img && !text) msg.classList.add("only-img");
  if (!side.img && !text && hint) msg.append(el("div", "pc-msg-text hint", tr("Write your message here…")));

  const stampWrap = el("div", "pc-stamp");
  stampWrap.append(stampEl(stamp));
  const addr = el("div", "pc-addr");
  addr.append(el("span", "", toName), el("span", "", tr("Duo mailbox")), el("span"));

  face.replaceChildren(el("div", "pc-back-title", tr("POST CARD")), msg, el("div", "pc-divider"), stampWrap, addr);
  if (postmark) face.append(postmarkEl(postmark));
}

/** m = { front: {img,text,bg}, back: {img,text,bg}, stamp, toName, postmark } */
function cardEl(m, { frontOnly = false, hint = false } = {}) {
  const card = el("div", "postcard");
  const inner = el("div", "pc-inner");
  const front = el("div", "pc-face pc-front");
  fillFront(front, m.front, { hint });
  inner.append(front);
  if (!frontOnly) {
    const back = el("div", "pc-face pc-back");
    fillBack(back, m.back, { ...m, hint });
    inner.append(back);
  }
  card.append(inner);
  return card;
}

/**
 * @param deps.sb             Supabase (or demo) client
 * @param deps.getMe          () => { id } of the signed-in user
 * @param deps.getMembers     () => [{ user_id, display_name }]
 * @param deps.toast          (message) => void
 * @param deps.photos         photo storage helper from app.js (upload / remove / urls)
 * @param deps.compressImage  (file) => { blob, aspect }
 */
export function createMail({ sb, getMe, getMembers, toast, photos, compressImage }) {
  const cards = new Map();      // id -> postcards row (only ones we're allowed to see)
  const announced = new Set();  // inbox ids we've already told the user about
  let channel = null, pollTimer = 0;
  let inTransit = 0;            // postcards on their way to me (count only)
  let loaded = false;
  let seg = "inbox";
  let draft = null;

  try { if (localStorage.getItem("duo-mail-seg") === "sent") seg = "sent"; } catch {}

  const meId = () => getMe()?.id;
  const nameOf = (id) => getMembers().find((m) => m.user_id === id)?.display_name ?? tr("Someone");
  const recipient = () => getMembers().find((m) => m.user_id !== meId());
  const delivered = (c) => Date.parse(c.delivers_at) <= Date.now();
  const visible = (c) => c.from_id === meId() || (c.to_id === meId() && delivered(c));
  const inbox = () => [...cards.values()].filter((c) => c.to_id === meId() && delivered(c))
    .sort((a, b) => b.delivers_at.localeCompare(a.delivers_at));
  const sent = () => [...cards.values()].filter((c) => c.from_id === meId())
    .sort((a, b) => b.sent_at.localeCompare(a.sent_at));

  const model = (c) => ({
    front: { img: c.front_image, text: c.front_text, bg: c.front_bg },
    back: { img: c.back_image, text: c.back_text, bg: c.back_bg },
    stamp: c.stamp !== "custom" ? c.stamp
      : { emoji: c.stamp_emoji, label: c.stamp_label, value: c.stamp_value, color: c.stamp_color, img: c.stamp_image },
    toName: nameOf(c.to_id), postmark: c.sent_at,
  });

  async function loadImages(root) {
    const imgs = [...root.querySelectorAll("img[data-path]")];
    if (!imgs.length) return;
    try {
      const urls = await photos.urls(imgs.map((i) => i.dataset.path));
      for (const i of imgs) { const u = urls.get(i.dataset.path); if (u) i.src = u; }
    } catch {}
  }

  // ---------- lifecycle ----------
  async function start() {
    await load();
    channel = sb.channel("mail")
      .on("postgres_changes", { event: "*", schema: "public", table: "postcards" }, (p) => {
        if (p.eventType === "DELETE") cards.delete(p.old.id);
        else if (visible(p.new)) cards.set(p.new.id, p.new);
        else return;
        announce();
        render();
      })
      .subscribe();
    pollTimer = setInterval(load, POLL_MS);
  }

  function stop() {
    if (channel) sb.removeChannel(channel);
    channel = null;
    clearInterval(pollTimer);
    cards.clear();
    announced.clear();
    inTransit = 0;
    loaded = false;
    discardDraft();
    if ($("pc-compose").open) $("pc-compose").close();
    if ($("pc-viewer").open) $("pc-viewer").close();
    render();
  }

  async function load() {
    if (!meId()) return;
    const [c, t] = await Promise.all([
      sb.from("postcards").select("*").order("sent_at", { ascending: false }),
      sb.rpc("mail_in_transit"),
    ]);
    if (c.error) {
      if (!loaded) toast(tr("Couldn't load the mailbox: ") + c.error.message);
      return;
    }
    cards.clear();
    c.data.filter(visible).forEach((r) => cards.set(r.id, r));
    inTransit = t.error ? 0 : Number(t.data) || 0;
    announce();
    loaded = true;
    render();
  }

  /** "You've got mail" for postcards that landed while the app was open. */
  function announce() {
    const fresh = inbox().filter((c) => !announced.has(c.id));
    fresh.forEach((c) => announced.add(c.id));
    if (!loaded) return; // first load: the badge says enough
    const unread = fresh.filter((c) => !c.read_at);
    if (unread.length === 1) toast(tr("📬 A postcard from {name} just arrived!", { name: nameOf(unread[0].from_id) }));
    else if (unread.length > 1) toast(tr("📬 {n} postcards just arrived!", { n: unread.length }));
  }

  // ---------- mailbox ----------
  function render() {
    const unread = inbox().filter((c) => !c.read_at).length;
    $("mail-badge").textContent = unread;
    $("mail-badge").hidden = !unread;

    for (const b of $("mail-segs").querySelectorAll("[data-mseg]")) {
      b.setAttribute("aria-selected", String(b.dataset.mseg === seg));
      if (b.dataset.mseg === "inbox") b.textContent = unread ? `${tr("Inbox")} (${unread})` : tr("Inbox");
    }

    const showTransit = seg === "inbox" && inTransit > 0;
    $("mail-transit").hidden = !showTransit;
    if (showTransit) {
      const from = recipient()?.display_name ?? "someone";
      $("mail-transit-text").textContent = inTransit === 1
        ? tr("A postcard from {name} is somewhere in the post…", { name: from })
        : tr("{n} postcards from {name} are somewhere in the post…", { n: inTransit, name: from });
    }

    const list = seg === "inbox" ? inbox() : sent();
    $("mail-list").replaceChildren(...list.map(itemEl));
    $("mail-list").hidden = !list.length;
    $("mail-empty").hidden = !!list.length;
    $("mail-empty-icon").textContent = seg === "inbox" ? "📭" : "✉️";
    $("mail-empty-text").textContent = seg === "inbox"
      ? (meId() ? tr("Your mailbox is empty. Postcards from {name} land here.", { name: recipient()?.display_name ?? tr("your person") }) : "")
      : tr("You haven't posted anything yet. Tap Write a postcard.");
    $("mail-demo").hidden = !sb.isDemo || !meId();
  }

  function itemEl(c) {
    const isInbox = c.to_id === meId();
    const b = el("button", "mail-item");
    b.type = "button";
    b.style.setProperty("--tilt", `${(((c.id * 37) % 7) - 3) * 0.6}deg`);

    const thumb = el("div", "mail-thumb");
    const card = cardEl(model(c), { frontOnly: true });
    thumb.append(card);
    loadImages(card);

    const meta = el("div", "mail-meta");
    if (isInbox) {
      if (!c.read_at) { b.classList.add("unread"); thumb.append(el("span", "mail-new", tr("New"))); }
      meta.append(el("b", "", tr("From {name}", { name: nameOf(c.from_id) })), el("span", "muted", tr("Arrived {date}", { date: fmtDate(c.delivers_at) })));
    } else if (!delivered(c)) {
      card.classList.add("in-transit");
      thumb.append(el("span", "pc-ribbon", tr("🚚 In the post")));
      meta.append(el("b", "", tr("To {name}", { name: nameOf(c.to_id) })), el("span", "muted", tr("Posted {when}", { when: since(c.sent_at) })));
    } else {
      meta.append(el("b", "", tr("To {name}", { name: nameOf(c.to_id) })),
        el("span", "muted", `${tr("Arrived {date}", { date: fmtDate(c.delivers_at) })} · ${c.read_at ? tr("read ✓") : tr("not opened yet|card")}`));
    }
    b.append(thumb, meta);
    b.addEventListener("click", () => openViewer(c));
    return b;
  }

  $("mail-segs").addEventListener("click", (e) => {
    const s = e.target.closest("[data-mseg]")?.dataset.mseg;
    if (!s || s === seg) return;
    seg = s;
    try { localStorage.setItem("duo-mail-seg", s); } catch {}
    render();
  });

  $("mail-demo").addEventListener("click", async () => {
    const n = await sb.demoDeliverMail?.();
    toast(n ? tr(n > 1 ? "Delivered {n} postcards (demo)" : "Delivered 1 postcard (demo)", { n }) : tr("Nothing in the post right now."));
    load();
  });

  // ---------- reading a postcard ----------
  function openViewer(c) {
    const card = cardEl(model(c));
    card.classList.add("flippable");
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", tr("Flip the postcard"));
    card.addEventListener("click", () => card.classList.toggle("flipped"));
    $("pc-viewer-card").replaceChildren(card);
    loadImages(card);

    const isInbox = c.to_id === meId();
    const n = daysInPost(c);
    $("pc-viewer-meta").textContent = isInbox
      ? tr(n > 1 ? "From {name} · posted {sent} · arrived {arrived} ({n} days in the post)" : "From {name} · posted {sent} · arrived {arrived} (1 day in the post)",
        { name: nameOf(c.from_id), sent: fmtDate(c.sent_at), arrived: fmtDate(c.delivers_at), n })
      : delivered(c)
        ? tr(n > 1 ? "To {name} · arrived {arrived} after {n} days" : "To {name} · arrived {arrived} after 1 day",
          { name: nameOf(c.to_id), arrived: fmtDate(c.delivers_at), n }) + " · " + (c.read_at ? tr("read ✓") : tr("not opened yet|card"))
        : tr("To {name} · posted {sent} · still in the post 🚚", { name: nameOf(c.to_id), sent: fmtDate(c.sent_at) });
    $("pc-viewer").showModal();
    if (isInbox && !c.read_at) markRead(c);
  }

  async function markRead(c) {
    c.read_at = new Date().toISOString();
    render();
    const { error } = await sb.rpc("mark_postcard_read", { card_id: c.id });
    if (error) { c.read_at = null; render(); }
  }

  $("pc-viewer-close").addEventListener("click", () => $("pc-viewer").close());
  $("pc-viewer").addEventListener("click", (e) => {
    if (e.target === $("pc-viewer") || e.target.classList.contains("viewer-body")) $("pc-viewer").close();
  });

  // ---------- writing a postcard ----------
  function lastCustom() {
    const c = { emoji: "", label: "", value: "", color: STAMP_COLORS[0], blob: null, img: null };
    try {
      const saved = JSON.parse(localStorage.getItem(CUSTOM_KEY) || "{}");
      for (const k of ["emoji", "label", "value", "color"]) if (typeof saved[k] === "string") c[k] = saved[k];
    } catch {}
    return c;
  }
  function saveCustom() {
    const { emoji, label, value, color } = draft.custom;
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify({ emoji, label, value, color })); } catch {}
  }

  const newDraft = () => ({
    side: "front",
    stamp: STAMPS[0].id,
    custom: lastCustom(),
    front: { blob: null, img: null, text: "", bg: FRONT_BG },
    back: { blob: null, img: null, text: "", bg: BACK_BG },
  });
  let previewCard = null;
  let fileFor = "side"; // the photo picker is shared: "side" or "stamp"

  /** What goes on the card: a preset id, or the home-made stamp */
  const draftStamp = () => draft.stamp === "custom" ? draft.custom : draft.stamp;
  const customIsBlank = () => { const c = draft.custom; return !c.img && !c.emoji.trim() && !c.label.trim() && !c.value.trim(); };
  const ownTile = () => customIsBlank() ? { emoji: "＋", label: tr("Your own"), color: draft.custom.color } : draft.custom;

  function discardDraft() {
    if (!draft) return;
    for (const s of [draft.front, draft.back, draft.custom]) if (s.img) URL.revokeObjectURL(s.img);
    draft = null;
  }
  const draftIsEmpty = () => !draft || [draft.front, draft.back].every((s) => !s.blob && !s.text.trim());

  $("mail-write").addEventListener("click", () => {
    const to = recipient();
    if (!to) return toast(tr("There's nobody to send a postcard to yet."));
    draft ??= newDraft();
    $("pc-compose-title").textContent = tr("Postcard to {name}", { name: to.display_name });
    previewCard = cardEl({ ...draft, toName: to.display_name }, { hint: true });
    previewCard.classList.add("flippable");
    previewCard.classList.toggle("flipped", draft.side === "back");
    previewCard.addEventListener("click", () => setSide(draft.side === "front" ? "back" : "front"));
    $("pc-preview").replaceChildren(previewCard);
    renderStamps();
    renderSide();
    $("pc-compose").showModal();
  });

  function refreshPreview() {
    if (!previewCard || !draft) return;
    fillFront(previewCard.querySelector(".pc-front"), draft.front, { hint: true });
    fillBack(previewCard.querySelector(".pc-back"), draft.back,
      { stamp: draftStamp(), toName: recipient()?.display_name ?? "", hint: true });
  }

  function setSide(side) {
    draft.side = side;
    previewCard.classList.toggle("flipped", side === "back");
    renderSide();
  }

  function renderSide() {
    const s = draft[draft.side];
    for (const b of $("pc-sides").querySelectorAll("[data-side]")) {
      b.setAttribute("aria-selected", String(b.dataset.side === draft.side));
    }
    const ta = $("pc-text");
    ta.value = s.text;
    ta.maxLength = LIMITS[draft.side];
    ta.placeholder = draft.side === "front"
      ? tr("Big words for the front, or a caption for your photo…")
      : tr("Dear {name},", { name: recipient()?.display_name ?? tr("you") }) + "\n…";
    $("pc-photo").textContent = s.blob ? tr("📷 Change photo") : tr("📷 Add photo");
    $("pc-photo-remove").hidden = !s.blob;
    $("pc-swatches").replaceChildren(...SWATCHES.map((c) => {
      const b = el("button", "swatch");
      b.type = "button";
      b.style.setProperty("--sw", c);
      b.setAttribute("aria-label", `Background ${c}`);
      b.setAttribute("aria-pressed", String(c === s.bg));
      b.addEventListener("click", () => { s.bg = c; renderSide(); refreshPreview(); });
      return b;
    }));
  }

  function renderStamps() {
    const opt = (id, label, spec) => {
      const b = el("button", "stamp-opt");
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.setAttribute("aria-pressed", String(id === draft.stamp));
      b.append(stampEl(spec));
      b.addEventListener("click", () => {
        draft.stamp = id;
        renderStamps();
        refreshPreview();
        if (draft.side !== "back") setSide("back"); // show where the stamp goes
      });
      return b;
    };
    $("pc-stamps").replaceChildren(opt("custom", tr("Make your own stamp"), ownTile()),
      ...STAMPS.map((st) => opt(st.id, tr("{name} stamp", { name: st.label }), st.id)));
    renderStampEditor();
  }

  function renderStampEditor() {
    const c = draft.custom;
    $("pc-stamp-edit").hidden = draft.stamp !== "custom";
    $("pc-st-emoji").value = c.emoji;
    $("pc-st-label").value = c.label;
    $("pc-st-value").value = c.value;
    $("pc-st-photo").textContent = c.img ? tr("🖼️ Change picture") : tr("🖼️ Use a picture");
    $("pc-st-photo-remove").hidden = !c.img;
    $("pc-st-colors").replaceChildren(...STAMP_COLORS.map((col) => {
      const b = el("button", "swatch");
      b.type = "button";
      b.style.setProperty("--sw", col);
      b.setAttribute("aria-label", `Stamp colour ${col}`);
      b.setAttribute("aria-pressed", String(col === c.color));
      b.addEventListener("click", () => { c.color = col; saveCustom(); renderStamps(); refreshPreview(); });
      return b;
    }));
  }

  // typing only refreshes the stamps, so the input keeps focus
  for (const [id, key] of [["pc-st-emoji", "emoji"], ["pc-st-label", "label"], ["pc-st-value", "value"]]) {
    $(id).addEventListener("input", (e) => {
      if (!draft) return;
      draft.custom[key] = e.target.value;
      saveCustom();
      $("pc-stamps").firstElementChild.replaceChildren(stampEl(ownTile()));
      refreshPreview();
    });
  }

  $("pc-st-photo").addEventListener("click", () => { fileFor = "stamp"; $("pc-file").click(); });
  $("pc-st-photo-remove").addEventListener("click", () => {
    const c = draft.custom;
    if (c.img) URL.revokeObjectURL(c.img);
    c.blob = c.img = null;
    renderStamps();
    refreshPreview();
  });

  $("pc-sides").addEventListener("click", (e) => {
    const side = e.target.closest("[data-side]")?.dataset.side;
    if (side && draft) setSide(side);
  });

  $("pc-text").addEventListener("input", (e) => {
    if (!draft) return;
    draft[draft.side].text = e.target.value;
    refreshPreview();
  });

  $("pc-photo").addEventListener("click", () => { fileFor = "side"; $("pc-file").click(); });
  $("pc-photo-remove").addEventListener("click", () => {
    const s = draft[draft.side];
    if (s.img) URL.revokeObjectURL(s.img);
    s.blob = s.img = null;
    renderSide();
    refreshPreview();
  });
  $("pc-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !draft) return;
    if (file.type && !file.type.startsWith("image/")) return toast(tr("Please pick an image."));
    const forStamp = fileFor === "stamp";
    const s = forStamp ? draft.custom : draft[draft.side];
    try {
      const { blob } = await compressImage(file);
      if (s.img) URL.revokeObjectURL(s.img);
      s.blob = blob;
      s.img = URL.createObjectURL(blob);
      if (forStamp) renderStamps(); else renderSide();
      refreshPreview();
    } catch (err) {
      toast(err.message ?? tr("Couldn't read that image."));
    }
  });

  $("pc-cancel").addEventListener("click", () => $("pc-compose").close()); // keeps the draft
  $("pc-discard").addEventListener("click", () => {
    if (!draftIsEmpty() && !confirm(tr("Throw this postcard away?"))) return;
    discardDraft();
    $("pc-compose").close();
  });

  $("pc-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const to = recipient();
    if (!draft || !to) return;
    const { front, back } = draft;
    if (!front.blob && !front.text.trim()) {
      setSide("front");
      return toast(tr("The front is empty: add a photo or some words."));
    }
    const custom = draft.stamp === "custom" ? draft.custom : null;
    if (custom && customIsBlank()) {
      setSide("back");
      return toast(tr("Your stamp is blank: give it an emoji, some text or a picture."));
    }
    if (!confirm(tr("Post this to {name}?\nIt will take somewhere between 2 and 15 days to arrive, and once it's in the post you can't get it back.", { name: to.display_name }))) return;

    const btn = $("pc-send");
    btn.disabled = true;
    btn.textContent = tr("Posting…");
    const uploaded = [];
    try {
      const up = async (s) => {
        if (!s.blob) return null;
        const path = await photos.upload(meId(), s.blob);
        uploaded.push(path);
        return path;
      };
      const front_image = await up(front);
      const back_image = await up(back);
      const stamp_image = custom ? await up(custom) : null;
      const { data, error } = await sb.from("postcards").insert({
        to_id: to.user_id,
        stamp: draft.stamp,
        ...(custom && {
          stamp_emoji: custom.emoji.trim() || null, stamp_label: custom.label.trim() || null,
          stamp_value: custom.value.trim() || null, stamp_color: custom.color, stamp_image,
        }),
        front_image, front_text: front.text.trim() || null, front_bg: front.bg,
        back_image, back_text: back.text.trim() || null, back_bg: back.bg,
      }).select().single();
      if (error) throw error;
      cards.set(data.id, data);
      discardDraft();
      $("pc-compose").close();
      seg = "sent";
      render();
      toast(tr("Posted! It's on its way to {name} 📮", { name: to.display_name }));
    } catch (err) {
      uploaded.forEach((p) => photos.remove(p).catch(() => {}));
      toast(tr("Couldn't post it: ") + (err.message ?? err));
    } finally {
      btn.disabled = false;
      btn.textContent = tr("Post it 📮");
    }
  });

  return { start, stop, load, onShow: render };
}
