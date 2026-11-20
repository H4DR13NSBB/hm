// =============================================================================
// Draw & Guess (part of the Games tab). One of you picks a word and draws it
// on the drawing pad; the other watches it being drawn again, stroke by stroke,
// and guesses. Each drawing is one row in `sketches`, holding the pen strokes
// rather than an image, so either of you can put it on today's board later.
// =============================================================================

import { paintFitted, packStrokes } from "./drawing.js";
import { tr } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const HINT_AFTER = 3;        // wrong guesses before the first letter is shown
const MAX_STROKES_JSON = 180_000;
const DONE_SHOWN = 30;       // finished drawings listed

const WORDS = [
  "cat", "dog", "fish", "bird", "snail", "octopus", "giraffe", "elephant", "penguin", "snake", "spider",
  "butterfly", "turtle", "rabbit", "horse", "cow", "pig", "owl", "shark", "whale", "crab", "bee", "frog",
  "apple", "banana", "pizza", "ice cream", "cake", "burger", "croissant", "cheese", "carrot", "pineapple",
  "cherry", "egg", "coffee", "fondue", "watermelon", "popcorn", "sushi", "taco", "lemon", "strawberry",
  "house", "castle", "bridge", "lighthouse", "tent", "igloo", "windmill", "church", "skyscraper",
  "car", "bicycle", "train", "plane", "boat", "rocket", "helicopter", "tractor", "scooter", "hot air balloon",
  "sun", "moon", "star", "cloud", "rainbow", "snowman", "mountain", "volcano", "island", "tree", "flower",
  "cactus", "mushroom", "palm tree", "lightning", "waterfall", "beach", "wave",
  "guitar", "piano", "drum", "trumpet", "headphones", "camera", "phone", "laptop", "television", "clock",
  "glasses", "hat", "shoe", "sock", "umbrella", "backpack", "suitcase", "key", "lamp", "chair", "bed",
  "toothbrush", "scissors", "pencil", "book", "envelope", "candle", "balloon", "gift", "crown", "ring",
  "kite", "ball", "dice", "puzzle", "robot", "ghost", "dragon", "unicorn", "mermaid", "pirate", "alien",
  "skiing", "swimming", "dancing", "sleeping", "cooking", "reading", "camping", "fishing", "hiking",
  "heart", "kiss", "hug", "selfie", "wedding", "birthday", "honeymoon", "breakfast in bed", "picnic",
  "cuckoo clock", "cow bell", "chocolate", "passport", "map", "anchor", "compass", "treasure", "snowflake",
];

/** Lowercase letters and digits only, without accents. */
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const isRight = (guess, word) => {
  const g = norm(guess), w = norm(word);
  return !!g && (g === w || g === w + "s" || g + "s" === w);
};

/**
 * @param deps.sb          Supabase (or demo) client
 * @param deps.getMe       () => { id } of the signed-in user
 * @param deps.getMembers  () => [{ user_id, display_name }]
 * @param deps.colorOf     Map user id -> CSS colour
 * @param deps.toast       (message) => void
 * @param deps.openDraw    (onSave(strokes), { prompt, saveLabel }) => void, the drawing pad
 * @param deps.pinToBoard  (strokes, caption) => Promise<boolean>
 * @param deps.onChange    () => void, when the "your turn" count may have changed
 */
export function createSketch({ sb, getMe, getMembers, colorOf, toast, openDraw, pinToBoard, onChange }) {
  const rows = new Map();  // id -> sketches row
  let channel = null;
  let missing = false;     // table not created yet (schema.sql not re-run)
  let openId = null;       // round shown in the dialog
  let replay = 0;          // animation frame of the running replay
  let offered = [];        // words on offer in the picker

  // ---------- lifecycle ----------
  async function start() {
    await load();
    channel = sb
      .channel("sketches")
      .on("postgres_changes", { event: "*", schema: "public", table: "sketches" }, (p) => {
        if (p.eventType === "DELETE") rows.delete(p.old.id);
        else rows.set(p.new.id, p.new);
        render();
      })
      .subscribe();
  }

  function stop() {
    if (channel) sb.removeChannel(channel);
    channel = null;
    rows.clear();
    if ($("sk-round").open) $("sk-round").close();
    render();
  }

  async function load() {
    const { data, error } = await sb.from("sketches").select("*").order("id");
    missing = !!error && /does not exist|schema cache|unknown table/i.test(error.message);
    if (error && !missing) toast(tr("Couldn't load drawings: ") + error.message);
    if (!error) {
      rows.clear();
      data.forEach((r) => rows.set(r.id, r));
    }
    render();
  }

  // ---------- helpers ----------
  const meId = () => getMe()?.id;
  const other = () => getMembers().find((m) => m.user_id !== meId());
  const nameOf = (id) => getMembers().find((m) => m.user_id === id)?.display_name ?? "?";
  const newest = () => [...rows.values()].sort((a, b) => b.id - a.id);
  const toGuess = () => newest().filter((r) => r.status === "guessing" && r.guesser_id === meId());
  const myTurns = () => (missing ? 0 : toGuess().length);
  const tries = (r) => r.guesses.length;

  // ---------- the list ----------
  function render() {
    onChange();
    $("sk-missing").hidden = !missing;
    $("sk-body").hidden = missing;
    if (missing || !meId()) return;

    $("sk-other").textContent = other()?.display_name ?? "";
    $("sk-draw").disabled = !other();

    // score: drawings each of you guessed
    $("sk-score").replaceChildren(...getMembers().map((m) => {
      const s = document.createElement("span");
      s.className = "g-score-person";
      s.style.setProperty("--c", colorOf.get(m.user_id));
      s.innerHTML = "<b></b><span></span>";
      s.querySelector("b").textContent = newest().filter((r) => r.status === "guessed" && r.guesser_id === m.user_id).length;
      s.querySelector("span").textContent = tr("{name} guessed", { name: m.display_name });
      return s;
    }));

    const todo = toGuess();
    const sent = newest().filter((r) => r.status === "guessing" && r.drawer_id === meId());
    const done = newest().filter((r) => r.status !== "guessing").slice(0, DONE_SHOWN);
    section("sk-todo", todo, tr("To guess"));
    section("sk-sent", sent, tr("Waiting for {name}", { name: other()?.display_name ?? "" }));
    section("sk-done", done, tr("Done"));
    $("sk-empty").hidden = rows.size > 0;

    if ($("sk-round").open) {
      const r = rows.get(openId);
      if (r) renderRound(r, false); else $("sk-round").close();
    }
  }

  function section(id, list, title) {
    const wrap = $(id);
    wrap.hidden = !list.length;
    const h = document.createElement("h3");
    h.className = "sk-h";
    h.textContent = title;
    const grid = document.createElement("div");
    grid.className = "sk-grid";
    grid.append(...list.map(card));
    wrap.replaceChildren(h, grid);
  }

  function card(r) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sk-card";
    b.style.setProperty("--c", colorOf.get(r.drawer_id) ?? "var(--muted)");
    const label = document.createElement("span");
    label.className = "sk-card-label";
    if (r.status === "guessing" && r.guesser_id === meId()) {
      // no peeking: the drawing appears as it's drawn, once you open it
      b.classList.add("wrapped");
      const gift = document.createElement("span");
      gift.className = "sk-gift";
      gift.textContent = "🎁";
      label.textContent = tr("From {name}", { name: nameOf(r.drawer_id) });
      b.append(gift, label);
    } else {
      const c = document.createElement("canvas");
      c.width = 300;
      c.height = 225;
      paintFitted(c, r.strokes);
      label.textContent = r.status === "guessing"
        ? `${r.word} · ${tries(r) ? tr(tries(r) > 1 ? "{n} guesses so far" : "1 guess so far", { n: tries(r) }) : tr("not opened yet")}`
        : r.word;
      b.append(c, label);
      if (r.status !== "guessing") {
        const sub = document.createElement("small");
        sub.className = "muted";
        sub.textContent = r.status === "guessed" ? tr("✓ in {n}", { n: tries(r) }) : tr("gave up");
        label.append(" ", sub);
      }
    }
    b.addEventListener("click", () => openRound(r.id));
    return b;
  }

  // ---------- one drawing ----------
  function openRound(id) {
    openId = id;
    $("sk-guess-input").value = "";
    renderRound(rows.get(id), true);
    $("sk-round").showModal();
  }

  function renderRound(r, animate) {
    const guessing = r.status === "guessing";
    const iGuess = r.guesser_id === meId();
    $("sk-r-title").textContent = iGuess
      ? tr("{name} drew…", { name: nameOf(r.drawer_id) })
      : tr("You drew “{word}”", { word: r.word });

    // the word: blanks while guessing, with the first letter as a hint after a few tries
    const blanks = $("sk-r-word");
    blanks.replaceChildren();
    if (guessing && iGuess) {
      const hint = tries(r) >= HINT_AFTER;
      let first = true;
      for (const ch of r.word) {
        const s = document.createElement("span");
        if (/\s/.test(ch)) s.className = "gap";
        else if (!/[\p{L}\p{N}]/u.test(ch)) s.textContent = ch;
        else {
          s.className = "blank";
          if (hint && first) s.textContent = ch.toUpperCase();
          first = false;
        }
        blanks.append(s);
      }
      blanks.setAttribute("aria-label", tr("{n} letters", { n: norm(r.word).length }));
    } else {
      blanks.textContent = r.word;
      blanks.removeAttribute("aria-label");
    }

    let status;
    if (r.status === "guessed") {
      status = iGuess
        ? tr(tries(r) === 1 ? "You got it in 1 guess 🎉" : "You got it in {n} guesses 🎉", { n: tries(r) })
        : tr(tries(r) === 1 ? "{name} got it in 1 guess 🎉" : "{name} got it in {n} guesses 🎉", { name: nameOf(r.guesser_id), n: tries(r) });
    } else if (r.status === "gave_up") {
      status = iGuess ? tr("You gave up") : tr("{name} gave up", { name: nameOf(r.guesser_id) });
    } else if (iGuess) {
      status = tr("{n} letters", { n: norm(r.word).length }) + (tries(r) >= HINT_AFTER ? tr(" · here's the first one") : "");
    } else {
      status = tr(tries(r) ? "{name} is guessing…" : "{name} hasn't opened it yet", { name: nameOf(r.guesser_id) });
    }
    $("sk-r-status").textContent = status;

    // wrong guesses, newest first
    const wrong = r.guesses.filter((g) => !isRight(g, r.word)).reverse();
    $("sk-r-guesses").replaceChildren(...wrong.map((g) => {
      const s = document.createElement("span");
      s.className = "sk-chip";
      s.textContent = g;
      return s;
    }));

    $("sk-guess").hidden = !(guessing && iGuess);
    $("sk-giveup").hidden = !(guessing && iGuess);
    $("sk-pin").hidden = guessing;
    $("sk-pin").disabled = !!r.pinned;
    $("sk-pin").textContent = r.pinned ? tr("📌 On the board") : tr("📌 Put on today's board");

    sizeCanvas();
    if (animate) play(r);
    else if (!replay) paintFitted($("sk-canvas"), r.strokes);
  }

  function sizeCanvas() {
    const c = $("sk-canvas");
    const dpr = Math.min(devicePixelRatio || 1, 3);
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (w && (c.width !== w || c.height !== h)) { c.width = w; c.height = h; }
  }

  /** Draws it again stroke by stroke, the way it was drawn. */
  function play(r) {
    cancelAnimationFrame(replay);
    const total = r.strokes.reduce((n, st) => n + st.pts.length, 0);
    const ms = Math.min(Math.max(total * 12, 1500), 8000);
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.ceil(total * Math.min(1, (t - t0) / ms));
      paintFitted($("sk-canvas"), r.strokes, k);
      replay = k < total && $("sk-round").open ? requestAnimationFrame(step) : 0;
    };
    replay = requestAnimationFrame(step);
  }

  async function update(r, patch) {
    const before = { ...r };
    Object.assign(r, patch);
    render();
    const { error } = await sb.from("sketches").update(patch).eq("id", r.id);
    if (error) {
      Object.assign(r, before);
      render();
      toast(tr("Couldn't save: ") + error.message);
      return false;
    }
    return true;
  }

  $("sk-guess").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = rows.get(openId);
    const guess = $("sk-guess-input").value.trim().slice(0, 40);
    if (!r || r.status !== "guessing" || !guess) return;
    $("sk-guess-input").value = "";
    const right = isRight(guess, r.word);
    if (!right && r.guesses.some((g) => norm(g) === norm(guess))) return toast(tr("You tried that one already."));
    if (navigator.vibrate) navigator.vibrate(right ? [20, 60, 20] : 10);
    if (!right) $("sk-guess-input").focus();
    await update(r, {
      guesses: [...r.guesses, guess],
      ...(right && { status: "guessed", finished_at: new Date().toISOString() }),
    });
  });

  $("sk-giveup").addEventListener("click", () => {
    const r = rows.get(openId);
    if (r && confirm(tr("Give up and see the word?"))) {
      update(r, { status: "gave_up", finished_at: new Date().toISOString() });
    }
  });

  $("sk-replay").addEventListener("click", () => {
    const r = rows.get(openId);
    if (r) play(r);
  });

  $("sk-pin").addEventListener("click", async () => {
    const r = rows.get(openId);
    if (!r || r.pinned) return;
    $("sk-round").close();
    const how = r.status === "guessed" ? tr(", guessed by {name} in {n}", { name: nameOf(r.guesser_id), n: tries(r) }) : "";
    if (!await pinToBoard(r.strokes, `🖍️ ${r.word}, ${tr("drawn by {name}", { name: nameOf(r.drawer_id) })}${how}`)) return;
    toast(tr("It's on today's board 📌"));
    update(r, { pinned: true });
  });

  $("sk-round").addEventListener("close", () => {
    cancelAnimationFrame(replay);
    replay = 0;
    openId = null;
  });
  $("sk-r-close").addEventListener("click", () => $("sk-round").close());

  // ---------- drawing one ----------
  function offerWords() {
    const pool = WORDS.filter((w) => !offered.includes(w));
    offered = [];
    while (offered.length < 3) {
      const w = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      offered.push(w);
    }
    $("sk-words").replaceChildren(...offered.map((w) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = w;
      b.addEventListener("click", () => draw(w));
      return b;
    }));
  }

  function draw(word) {
    $("sk-pick").close();
    const to = other();
    if (!to) return;
    openDraw((strokes) => send(word, strokes, to.user_id), {
      prompt: tr("Draw “{word}” for {name}. No letters!", { word, name: to.display_name }),
      saveLabel: tr("Send"),
    });
  }

  async function send(word, strokes, guesserId) {
    const packed = packStrokes(strokes);
    if (JSON.stringify(packed).length > MAX_STROKES_JSON) return toast(tr("That drawing is too detailed to send. Try a simpler one."));
    const { data, error } = await sb.from("sketches")
      .insert({ word, strokes: packed, guesser_id: guesserId })
      .select().single();
    if (error) return toast(tr("Couldn't send: ") + error.message);
    rows.set(data.id, data);
    render();
    toast(tr("Sent to {name} ✉️", { name: nameOf(guesserId) }));
  }

  $("sk-draw").addEventListener("click", () => {
    offerWords();
    $("sk-own-word").value = "";
    $("sk-pick").showModal();
  });
  $("sk-more").addEventListener("click", offerWords);
  $("sk-own").addEventListener("submit", (e) => {
    e.preventDefault();
    const w = $("sk-own-word").value.trim().replace(/\s+/g, " ").slice(0, 40);
    if (norm(w)) draw(w);
  });

  return { start, stop, load, myTurns };
}
