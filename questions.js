// =============================================================================
// Questions tab: conversation cards in six depths (the Wavelength deck).
// Pick depths, then take turns answering out loud. Swipe right = answered,
// left = skip. Answered and saved-for-later marks are shared by both of you,
// so a new round only draws questions you haven't answered together yet.
// =============================================================================

import { DEPTHS, BUILT_IN } from "./questions-data.js";
import { tr } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const DEPTHS_KEY = "duo-q-depths";
const SWIPE = 90; // px of drag that counts as a swipe
const depthOf = new Map(DEPTHS.map((d) => [d.id, d]));

/**
 * @param deps.sb          Supabase (or demo) client
 * @param deps.getMe       () => { id } of the signed-in user
 * @param deps.getMembers  () => [{ user_id, display_name }]
 * @param deps.colorOf     Map user id -> CSS colour
 * @param deps.toast       (message) => void
 * @param deps.openEditor  (initialText, onSave) => void
 */
export function createQuestions({ sb, getMe, getMembers, colorOf, toast, openEditor }) {
  const custom = new Map();  // id -> questions row
  const marks = new Map();   // question_key -> question_marks row
  let channel = null;
  let missing = false;       // tables not created yet (schema.sql not re-run)

  let selected = new Set(["surface", "current", "undertow"]);
  try {
    const saved = JSON.parse(localStorage.getItem(DEPTHS_KEY));
    if (Array.isArray(saved) && saved.length) selected = new Set(saved.filter((d) => depthOf.has(d)));
  } catch {}

  // the round being played
  let deck = [], index = 0, history = [], drag = null;
  let libSeg = "answered";

  // ---------- lifecycle ----------
  async function start() {
    await load();
    channel = sb
      .channel("questions")
      .on("postgres_changes", { event: "*", schema: "public", table: "questions" }, (p) => {
        if (p.eventType === "DELETE") custom.delete(p.old.id);
        else custom.set(p.new.id, p.new);
        render();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "question_marks" }, (p) => {
        if (p.eventType === "DELETE") {
          for (const [k, m] of marks) if (m.id === p.old.id) marks.delete(k);
        } else {
          marks.set(p.new.question_key, p.new);
        }
        render();
      })
      .subscribe();
  }

  function stop() {
    if (channel) sb.removeChannel(channel);
    channel = null;
    custom.clear();
    marks.clear();
    showView("home");
    render();
  }

  async function load() {
    const [q, m] = await Promise.all([
      sb.from("questions").select("*").order("created_at"),
      sb.from("question_marks").select("*"),
    ]);
    const err = q.error ?? m.error;
    missing = !!err && /does not exist|schema cache|unknown table/i.test(err.message);
    if (err && !missing) toast(tr("Couldn't load questions: ") + err.message);
    if (err) return render();
    custom.clear();
    marks.clear();
    q.data.forEach((r) => custom.set(r.id, r));
    m.data.forEach((r) => marks.set(r.question_key, r));
    render();
  }

  // ---------- the pool ----------
  const customQ = (r) => ({ key: "c" + r.id, depth: r.depth, text: r.body, row: r });
  const allQuestions = () => [...BUILT_IN, ...[...custom.values()].map(customQ)];
  const statusOf = (q) => marks.get(q.key)?.status ?? null;
  const fresh = () => $("q-fresh").checked;

  function pool() {
    return allQuestions().filter((q) => selected.has(q.depth) && !(fresh() && statusOf(q) === "answered"));
  }
  const withStatus = (status) => allQuestions()
    .filter((q) => statusOf(q) === status)
    .sort((a, b) => marks.get(b.key).marked_at.localeCompare(marks.get(a.key).marked_at));

  // ---------- rendering ----------
  function dotsHTML(depth) {
    return Array.from({ length: 5 }, (_, i) => `<i class="${i < depth ? "on" : ""}"></i>`).join("");
  }

  function render() {
    $("q-missing").hidden = !missing;
    $("q-setup").hidden = missing;
    if (missing) return;

    const all = allQuestions();
    $("q-depths").replaceChildren(...DEPTHS.map((d) => {
      const inDepth = all.filter((q) => q.depth === d.id);
      const left = inDepth.filter((q) => statusOf(q) !== "answered").length;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "q-depth";
      b.style.setProperty("--dc", d.color);
      b.setAttribute("aria-pressed", String(selected.has(d.id)));
      b.innerHTML = `<span class="q-depth-head"><b></b><span class="q-dots">${dotsHTML(d.depth)}</span></span>
        <span class="q-depth-blurb"></span><span class="q-depth-count"></span>`;
      b.querySelector("b").textContent = d.name;
      b.querySelector(".q-depth-blurb").textContent = d.blurb;
      b.querySelector(".q-depth-count").textContent =
        left === inDepth.length ? tr("{n} questions", { n: left }) : tr("{n} of {total} left", { n: left, total: inDepth.length });
      b.addEventListener("click", () => {
        if (selected.has(d.id)) selected.delete(d.id); else selected.add(d.id);
        try { localStorage.setItem(DEPTHS_KEY, JSON.stringify([...selected])); } catch {}
        render();
      });
      return b;
    }));

    const n = pool().length;
    $("q-start").disabled = n === 0;
    $("q-start").textContent = !selected.size ? tr("Pick at least one depth")
      : n ? tr(n > 1 ? "Start · {n} questions" : "Start · 1 question", { n }) : tr("You've answered all of these 🎉");
    $("q-saved-count").textContent = withStatus("saved").length;
    $("q-answered-count").textContent = withStatus("answered").length;
    $("q-ours-count").textContent = custom.size;
    if ($("q-library").open) renderLibrary();
  }

  function showView(name) {
    $("q-home").hidden = name !== "home";
    $("q-play").hidden = name !== "play";
    $("q-done").hidden = name !== "done";
  }

  // ---------- playing a round ----------
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function play(questions) {
    deck = shuffle(questions);
    index = 0;
    history = [];
    showView("play");
    renderCard();
  }

  function renderCard() {
    $("q-undo").disabled = history.length === 0;
    $("q-progress-fill").style.width = `${(index / deck.length) * 100}%`;
    $("q-progress-text").textContent = `${index} / ${deck.length}`;
    if (index >= deck.length) return finish();
    const q = deck[index];
    const d = depthOf.get(q.depth);
    const card = $("q-card");
    card.style.setProperty("--dc", d.color);
    card.style.transform = "";
    card.classList.remove("flying", "settling");
    $("q-card-depth").textContent = d.name;
    $("q-card-dots").innerHTML = dotsHTML(d.depth);
    $("q-card-text").textContent = q.text;
    const st = statusOf(q);
    $("q-card-note").textContent = st === "saved" ? tr("🔖 Saved for later") : st === "answered" ? tr("✓ Answered before") : "";
    $("q-save").setAttribute("aria-pressed", String(st === "saved"));
    $("q-stamp-yes").style.opacity = $("q-stamp-no").style.opacity = 0;
  }

  function finish() {
    showView("done");
    const count = (a) => history.filter((h) => h.action === a).length;
    const parts = [tr("{n} answered", { n: count("answered") }), tr("{n} skipped", { n: count("skip") })];
    if (count("saved")) parts.push(tr("{n} saved for later", { n: count("saved") }));
    $("q-done-summary").textContent = parts.join(" · ");
    $("q-again").hidden = count("skip") === 0;
  }

  async function act(action) {
    if (index >= deck.length) return;
    const q = deck[index];
    history.push({ q, action, prev: marks.get(q.key) ? { ...marks.get(q.key) } : null });
    index++;
    const dir = action === "answered" ? 1 : action === "skip" ? -1 : 0;
    const card = $("q-card");
    card.classList.add("flying");
    card.style.transform = dir ? `translateX(${dir * 120}%) rotate(${dir * 14}deg)` : "translateY(-30px) scale(.92)";
    card.style.opacity = "0";
    setTimeout(() => { card.style.opacity = ""; renderCard(); }, 200);
    if (action !== "skip") await setMark(q.key, action);
  }

  async function undo() {
    const last = history.pop();
    if (!last) return;
    index--;
    renderCard();
    if (last.action === "skip") return;
    if (last.prev) await setMark(last.q.key, last.prev.status, last.prev.marked_at);
    else await clearMark(last.q.key);
    renderCard();
  }

  // ---------- marks (shared) ----------
  async function setMark(key, status, markedAt = new Date().toISOString()) {
    const existing = marks.get(key);
    if (existing?.status === status) return;
    const before = existing ? { ...existing } : null;
    const patch = { status, marked_at: markedAt };
    let res;
    if (existing) {
      Object.assign(existing, patch);
      render();
      res = await sb.from("question_marks").update(patch).eq("id", existing.id);
    } else {
      res = await sb.from("question_marks").insert({ question_key: key, ...patch }).select().single();
      // the other person marked it at the same moment: update theirs instead
      if (res.error) {
        await load();
        if (marks.has(key)) return setMark(key, status, markedAt);
      } else {
        marks.set(key, res.data);
      }
    }
    if (res.error) {
      if (before) marks.set(key, before);
      toast(tr("Couldn't save: ") + res.error.message);
    }
    render();
  }

  async function clearMark(key) {
    const before = marks.get(key);
    if (!before) return;
    marks.delete(key);
    render();
    const { error } = await sb.from("question_marks").delete().eq("question_key", key);
    if (error) {
      marks.set(key, before);
      render();
      toast(tr("Couldn't save: ") + error.message);
    }
  }

  // ---------- swipe ----------
  const card = $("q-card");
  card.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || index >= deck.length) return;
    drag = { x: e.clientX, y: e.clientY, dx: 0, pid: e.pointerId };
    card.setPointerCapture(e.pointerId);
    card.classList.remove("settling", "flying");
  });
  card.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    drag.dx = e.clientX - drag.x;
    const dy = (e.clientY - drag.y) * 0.25;
    card.style.transform = `translate(${drag.dx}px, ${dy}px) rotate(${clampRot(drag.dx / 14)}deg)`;
    const r = Math.min(1, Math.abs(drag.dx) / SWIPE);
    $("q-stamp-yes").style.opacity = drag.dx > 0 ? r : 0;
    $("q-stamp-no").style.opacity = drag.dx < 0 ? r : 0;
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const dx = drag.dx;
    drag = null;
    if (Math.abs(dx) > SWIPE) return act(dx > 0 ? "answered" : "skip");
    card.classList.add("settling");
    card.style.transform = "";
    $("q-stamp-yes").style.opacity = $("q-stamp-no").style.opacity = 0;
  };
  card.addEventListener("pointerup", endDrag);
  card.addEventListener("pointercancel", endDrag);
  const clampRot = (r) => Math.max(-14, Math.min(14, r));

  document.addEventListener("keydown", (e) => {
    if ($("pane-questions").hidden || $("q-play").hidden || document.querySelector("dialog[open]")) return;
    if (e.key === "ArrowRight") act("answered");
    else if (e.key === "ArrowLeft") act("skip");
    else if (e.key === "ArrowUp") act("saved");
    else if (e.key === "z" || e.key === "Z") undo();
  });

  // ---------- buttons ----------
  $("q-fresh").addEventListener("change", render);
  $("q-start").addEventListener("click", () => play(pool()));
  $("q-answered").addEventListener("click", () => act("answered"));
  $("q-skip").addEventListener("click", () => act("skip"));
  $("q-undo").addEventListener("click", undo);
  $("q-save").addEventListener("click", () => {
    const q = deck[index];
    if (q && statusOf(q) === "saved") act("skip"); // already saved: just move on
    else act("saved");
  });
  $("q-back").addEventListener("click", () => { showView("home"); render(); });
  $("q-done-home").addEventListener("click", () => { showView("home"); render(); });
  $("q-again").addEventListener("click", () => play(history.filter((h) => h.action === "skip").map((h) => h.q)));
  $("q-play-saved").addEventListener("click", () => {
    const saved = withStatus("saved");
    if (!saved.length) return toast(tr("Nothing saved yet. Tap 🔖 on a card to keep it for later."));
    $("q-library").close();
    play(saved);
  });

  // ---------- library: answered / saved / your own ----------
  function openLibrary(seg) {
    libSeg = seg;
    renderLibrary();
    $("q-library").showModal();
  }
  $("q-open-saved").addEventListener("click", () => openLibrary("saved"));
  $("q-open-answered").addEventListener("click", () => openLibrary("answered"));
  $("q-open-ours").addEventListener("click", () => openLibrary("ours"));
  $("q-add").addEventListener("click", () => { openLibrary("ours"); $("q-new-text").focus(); });
  $("q-lib-segs").addEventListener("click", (e) => {
    const seg = e.target.closest("[data-qseg]")?.dataset.qseg;
    if (seg) { libSeg = seg; renderLibrary(); }
  });

  function renderLibrary() {
    for (const b of $("q-lib-segs").children) b.setAttribute("aria-selected", String(b.dataset.qseg === libSeg));
    $("q-new").hidden = libSeg !== "ours";
    $("q-play-saved").hidden = libSeg !== "saved" || !withStatus("saved").length;

    const nameOf = (id) => getMembers().find((m) => m.user_id === id)?.display_name ?? "";
    let rows, empty;
    if (libSeg === "ours") {
      rows = [...custom.values()].reverse().map(customQ);
      empty = tr("No questions of your own yet. Write one above.");
    } else {
      rows = withStatus(libSeg);
      empty = libSeg === "saved" ? tr("Nothing saved yet. Tap 🔖 on a card to keep it for later.")
        : tr("Nothing answered yet. Swipe a card right once you've both answered it.");
    }
    $("q-lib-empty").textContent = empty;
    $("q-lib-empty").hidden = rows.length > 0;
    $("q-lib-list").replaceChildren(...rows.map((q) => {
      const li = document.createElement("li");
      li.className = "entry q-entry";
      li.style.setProperty("--dc", depthOf.get(q.depth).color);
      const text = document.createElement(libSeg === "ours" ? "button" : "div");
      text.className = "entry-text" + (libSeg === "ours" ? "" : " static");
      text.textContent = q.text;
      const meta = document.createElement("small");
      const by = libSeg === "ours" ? q.row.added_by : marks.get(q.key)?.marked_by;
      meta.textContent = depthOf.get(q.depth).name + (by && nameOf(by) ? ` · ${nameOf(by)}` : "");
      meta.style.setProperty("--c", colorOf.get(by) ?? "var(--muted)");
      text.append(meta);
      if (libSeg === "ours") {
        text.type = "button";
        text.title = tr("Edit");
        text.addEventListener("click", () => openEditor(q.text, (body) => editCustom(q.row, body)));
      }
      const del = document.createElement("button");
      del.type = "button";
      del.className = "entry-del";
      del.setAttribute("aria-label", libSeg === "ours" ? tr("Delete question") : libSeg === "saved" ? tr("Unsave") : tr("Mark as not answered"));
      del.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      del.addEventListener("click", () => {
        if (libSeg === "ours") deleteCustom(q.row);
        else clearMark(q.key);
      });
      li.append(text, del);
      return li;
    }));
  }

  // ---------- your own questions ----------
  $("q-new-depth").replaceChildren(...DEPTHS.map((d) => new Option(d.name, d.id)));
  $("q-new").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = $("q-new-text").value.trim();
    const depth = $("q-new-depth").value;
    if (!body) return;
    $("q-new-text").value = "";
    const { data, error } = await sb.from("questions").insert({ depth, body: body.slice(0, 300), added_by: getMe().id }).select().single();
    if (error) {
      $("q-new-text").value = body;
      return toast(tr("Couldn't add: ") + error.message);
    }
    custom.set(data.id, data);
    render();
  });

  async function editCustom(row, body) {
    const before = row.body;
    row.body = body.slice(0, 300);
    render();
    const { error } = await sb.from("questions").update({ body: row.body }).eq("id", row.id);
    if (error) {
      row.body = before;
      render();
      toast(tr("Couldn't save: ") + error.message);
    }
  }

  async function deleteCustom(row) {
    if (!confirm(tr('Delete "{x}"?', { x: row.body }))) return;
    custom.delete(row.id);
    render();
    const { error } = await sb.from("questions").delete().eq("id", row.id);
    if (error) {
      custom.set(row.id, row);
      render();
      return toast(tr("Couldn't delete: ") + error.message);
    }
    clearMark("c" + row.id);
  }

  return { start, stop, load };
}
