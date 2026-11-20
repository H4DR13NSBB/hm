// =============================================================================
// Word of the day (top of the Games tab): a French word and its translation.
// You both get the same word each day (picked from the date), unless you
// already know it. "I knew this one" sets it aside and rolls another.
// Known words are kept per person on this device. Saving adds the word to a
// shared "French words" list in the Lists tab; pinning puts it on today's board.
// =============================================================================

import { WORDS } from "./words-data.js";
import { tr } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const LIST_NAME = "French words";

/** FNV-1a, so the day's word is the same on both phones. */
function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * @param deps.sb          Supabase (or demo) client
 * @param deps.getMe       () => { id } of the signed-in user
 * @param deps.getToday    () => "YYYY-MM-DD" in the couple's timezone
 * @param deps.toast       (message) => void
 * @param deps.pinNote     (text) => Promise<boolean>, puts a note on today's board
 */
export function createWords({ sb, getMe, getToday, toast, pinNote }) {
  // { day, idx, known: [idx], saved: [idx] }
  let state = null;

  const key = () => `duo-word-${getMe()?.id}`;
  function loadState() {
    state = null;
    try { state = JSON.parse(localStorage.getItem(key())); } catch {}
    state = { day: null, idx: null, known: [], saved: [], ...state };
  }
  function saveState() {
    try { localStorage.setItem(key(), JSON.stringify(state)); } catch {}
  }

  const isKnown = (i) => state.known.includes(i);
  const unknownCount = () => WORDS.length - state.known.length;

  /** Today's shared pick, or the next word after it you don't know yet. */
  function dailyIdx(day) {
    const start = hash(day) % WORDS.length;
    for (let s = 0; s < WORDS.length; s++) {
      const i = (start + s) % WORDS.length;
      if (!isKnown(i)) return i;
    }
    return null;
  }

  function randomIdx() {
    const left = WORDS.map((_, i) => i).filter((i) => !isKnown(i) && i !== state.idx);
    return left.length ? left[Math.floor(Math.random() * left.length)] : null;
  }

  // ---------- lifecycle ----------
  function start() {
    loadState();
    render();
  }

  function stop() {
    state = null;
    render();
  }

  // ---------- rendering ----------
  function current() {
    const day = getToday();
    if (state.day !== day || (state.idx != null && isKnown(state.idx))) {
      state.day = day;
      state.idx = dailyIdx(day);
      saveState();
    }
    return state.idx;
  }

  function render(animate = false) {
    $("wd").hidden = !state;
    if (!state) return;
    const i = current();
    const done = i == null;
    $("wd-fr").textContent = done ? "Bravo !" : WORDS[i][0];
    $("wd-en").textContent = done ? tr("You know all {n} words 🎉", { n: WORDS.length }) : WORDS[i][1];
    $("wd-known").textContent = state.known.length ? tr("{n} known", { n: state.known.length }) : "";
    $("wd-speak").hidden = done || !("speechSynthesis" in window);
    $("wd-knew").hidden = $("wd-save").hidden = $("wd-pin").hidden = done;
    const saved = !done && state.saved.includes(i);
    $("wd-save").disabled = saved;
    $("wd-save").textContent = saved ? tr("✓ Saved") : tr("＋ Save");
    if (animate) {
      const w = $("wd-word");
      w.classList.remove("roll");
      void w.offsetWidth; // restart the animation
      w.classList.add("roll");
    }
  }

  // ---------- actions ----------
  function knew() {
    const i = current();
    if (i == null) return;
    state.known.push(i);
    state.idx = randomIdx();
    saveState();
    render(true);
    if (navigator.vibrate) navigator.vibrate(10);
  }

  async function save() {
    const i = current();
    if (i == null) return;
    const body = `${WORDS[i][0]} — ${WORDS[i][1]}`;
    $("wd-save").disabled = true;
    try {
      const { data: found, error: e1 } = await sb.from("lists").select("*").eq("name", LIST_NAME);
      if (e1) throw e1;
      let list = found.find((l) => l.trip_id == null);
      if (!list) {
        const { data, error } = await sb.from("lists")
          .insert({ name: LIST_NAME, created_by: getMe().id }).select().single();
        if (error) throw error;
        list = data;
      }
      const { data: there, error: e2 } = await sb.from("list_items").select("*").eq("list_id", list.id);
      if (e2) throw e2;
      if (!there.some((it) => it.body === body)) {
        const { error } = await sb.from("list_items").insert({ list_id: list.id, body, added_by: getMe().id });
        if (error) throw error;
      }
      state.saved.push(i);
      saveState();
      toast(tr('Saved to "{name}" in Lists', { name: LIST_NAME }));
    } catch (err) {
      toast(tr("Couldn't save the word: ") + err.message);
    }
    render();
  }

  async function pin() {
    const i = current();
    if (i == null) return;
    if (await pinNote(`🇫🇷 ${WORDS[i][0]} = ${WORDS[i][1]}`)) toast(tr("It's on today's board 📌"));
  }

  function speak() {
    const i = current();
    if (i == null) return;
    speechSynthesis.cancel();
    // say "l'eau", not "l'eau (f)"
    const u = new SpeechSynthesisUtterance(WORDS[i][0].replace(/\s*\(.*?\)/g, ""));
    u.lang = "fr-FR";
    u.rate = 0.85;
    speechSynthesis.speak(u);
  }

  $("wd-knew").addEventListener("click", knew);
  $("wd-save").addEventListener("click", save);
  $("wd-pin").addEventListener("click", pin);
  $("wd-speak").addEventListener("click", speak);

  // the day can turn over while the app is open
  return { start, stop, render: () => state && render() };
}
