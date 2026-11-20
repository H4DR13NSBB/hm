// =============================================================================
// Lists tab: shared checklists (call topics, groceries, ...).
// Both people can add, tick, edit and delete anything; changes sync live.
// =============================================================================

import { tr } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const LAST_LIST_KEY = "duo-last-list";

/**
 * @param deps.sb          Supabase (or demo) client
 * @param deps.getMe       () => { id } of the signed-in user
 * @param deps.colorOf     Map user id -> CSS colour
 * @param deps.toast       (message) => void
 * @param deps.openEditor  (initialText, onSave) => void
 */
export function createLists({ sb, getMe, colorOf, toast, openEditor }) {
  const lists = new Map();    // id -> list row
  const entries = new Map();  // id -> list_items row
  let currentId = null;
  let channel = null;

  // ---------- lifecycle ----------
  async function start() {
    await load();
    channel = sb
      .channel("lists")
      .on("postgres_changes", { event: "*", schema: "public", table: "lists" }, (p) => apply(lists, p))
      .on("postgres_changes", { event: "*", schema: "public", table: "list_items" }, (p) => apply(entries, p))
      .subscribe();
  }

  function stop() {
    if (channel) sb.removeChannel(channel);
    channel = null;
    lists.clear();
    entries.clear();
    currentId = null;
    render();
  }

  /** Full reload; also used to catch up when the app returns to the foreground. */
  async function load() {
    const [l, e] = await Promise.all([
      sb.from("lists").select("*").order("created_at"),
      sb.from("list_items").select("*").order("created_at"),
    ]);
    if (l.error || e.error) return toast(tr("Couldn't load lists: ") + (l.error ?? e.error).message);
    lists.clear();
    entries.clear();
    // trip packing lists live in the Trips tab
    l.data.filter((r) => r.trip_id == null).forEach((r) => lists.set(r.id, r));
    e.data.filter((r) => lists.has(r.list_id)).forEach((r) => entries.set(r.id, r));
    render();
  }

  function apply(map, p) {
    if (p.eventType !== "DELETE") {
      if (map === lists && p.new.trip_id != null) return;          // a trip's packing list
      if (map === entries && !lists.has(p.new.list_id)) return;    // item of a packing list
    }
    if (p.eventType === "DELETE") {
      map.delete(p.old.id);
      if (map === lists) {
        for (const [id, it] of entries) if (it.list_id === p.old.id) entries.delete(id);
      }
    } else {
      map.set(p.new.id, p.new);
    }
    render();
  }

  // ---------- rendering ----------
  function pickCurrent() {
    if (currentId != null && lists.has(currentId)) return;
    let saved = null;
    try { saved = Number(localStorage.getItem(LAST_LIST_KEY)); } catch {}
    currentId = lists.has(saved) ? saved : (sortedLists()[0]?.id ?? null);
  }
  function choose(id) {
    currentId = id;
    try { localStorage.setItem(LAST_LIST_KEY, String(id)); } catch {}
    render();
  }

  const sortedLists = () => [...lists.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const openCount = (listId) => [...entries.values()].filter((e) => e.list_id === listId && !e.done).length;

  function render() {
    pickCurrent();

    // list picker chips
    const chips = sortedLists().map((l) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (l.id === currentId ? " active" : "");
      b.textContent = l.name;
      const n = openCount(l.id);
      if (n) {
        const c = document.createElement("span");
        c.className = "count";
        c.textContent = n;
        b.append(c);
      }
      b.addEventListener("click", () => choose(l.id));
      return b;
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "chip new";
    add.textContent = tr("+ New list");
    add.addEventListener("click", newList);
    $("list-chips").replaceChildren(...chips, add);

    const list = lists.get(currentId);
    $("list-body").hidden = !list;
    $("list-add").hidden = !list;
    $("lists-empty").hidden = !!list;
    if (!list) return;

    $("list-title").textContent = list.name;
    const mine = [...entries.values()].filter((e) => e.list_id === list.id);
    const open = mine.filter((e) => !e.done).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const done = mine.filter((e) => e.done).sort((a, b) => (b.done_at ?? "").localeCompare(a.done_at ?? ""));

    $("list-open").replaceChildren(...open.map(row));
    $("list-open-empty").hidden = open.length > 0;
    $("list-done-wrap").hidden = done.length === 0;
    $("list-done-count").textContent = done.length;
    $("list-done").replaceChildren(...done.map(row));
  }

  function row(it) {
    const li = document.createElement("li");
    li.className = "entry" + (it.done ? " done" : "");
    li.style.setProperty("--c", colorOf.get(it.added_by) ?? "var(--muted)");

    const check = document.createElement("button");
    check.type = "button";
    check.className = "check";
    check.setAttribute("aria-label", it.done ? tr("Mark as not done") : tr("Mark as done"));
    check.setAttribute("aria-pressed", String(it.done));
    check.innerHTML = "<span>✓</span>";
    check.addEventListener("click", () => toggle(it));

    const text = document.createElement("button");
    text.type = "button";
    text.className = "entry-text";
    text.textContent = it.body;
    text.title = tr("Edit");
    text.addEventListener("click", () => openEditor(it.body, (body) => update(it, { body })));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "entry-del";
    del.setAttribute("aria-label", tr("Delete"));
    del.textContent = "✕";
    del.addEventListener("click", () => remove(it));

    li.append(check, text, del);
    return li;
  }

  // ---------- actions ----------
  async function update(it, patch) {
    const before = { ...it };
    Object.assign(it, patch);
    render();
    const { error } = await sb.from("list_items").update(patch).eq("id", it.id);
    if (error) {
      Object.assign(it, before);
      render();
      toast(tr("Couldn't save: ") + error.message);
    }
  }

  function toggle(it) {
    const done = !it.done;
    update(it, { done, done_at: done ? new Date().toISOString() : null });
  }

  async function remove(it) {
    if (!confirm(tr('Delete "{x}"?', { x: it.body }))) return;
    entries.delete(it.id);
    render();
    const { error } = await sb.from("list_items").delete().eq("id", it.id);
    if (error) {
      entries.set(it.id, it);
      render();
      toast(tr("Couldn't delete: ") + error.message);
    }
  }

  $("list-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("list-add-input");
    const body = input.value.trim();
    if (!body || currentId == null) return;
    input.value = ""; // keep focus so you can add several in a row
    const { data, error } = await sb.from("list_items")
      .insert({ list_id: currentId, body, added_by: getMe().id })
      .select().single();
    if (error) {
      input.value = body;
      return toast(tr("Couldn't add: ") + error.message);
    }
    entries.set(data.id, data);
    render();
  });

  async function newList() {
    const name = prompt(tr("Name of the new list"), "")?.trim();
    if (!name) return;
    const { data, error } = await sb.from("lists")
      .insert({ name: name.slice(0, 60), created_by: getMe().id })
      .select().single();
    if (error) return toast(tr("Couldn't create the list: ") + error.message);
    lists.set(data.id, data);
    choose(data.id);
  }

  $("list-rename").addEventListener("click", async () => {
    const list = lists.get(currentId);
    if (!list) return;
    const name = prompt(tr("Rename list"), list.name)?.trim();
    if (!name || name === list.name) return;
    const before = list.name;
    list.name = name.slice(0, 60);
    render();
    const { error } = await sb.from("lists").update({ name: list.name }).eq("id", list.id);
    if (error) {
      list.name = before;
      render();
      toast(tr("Couldn't rename: ") + error.message);
    }
  });

  $("list-delete").addEventListener("click", async () => {
    const list = lists.get(currentId);
    if (!list) return;
    const n = [...entries.values()].filter((e) => e.list_id === list.id).length;
    if (!confirm(tr(!n ? 'Delete the list "{name}"?' : n > 1 ? 'Delete the list "{name}" and its {n} items?' : 'Delete the list "{name}" and its 1 item?', { name: list.name, n }))) return;
    const { error } = await sb.from("lists").delete().eq("id", list.id);
    if (error) return toast(tr("Couldn't delete the list: ") + error.message);
    apply(lists, { eventType: "DELETE", old: { id: list.id } });
  });

  $("list-clear-done").addEventListener("click", async () => {
    const done = [...entries.values()].filter((e) => e.list_id === currentId && e.done);
    if (!done.length || !confirm(tr(done.length > 1 ? "Remove {n} done items?" : "Remove 1 done item?", { n: done.length }))) return;
    const { error } = await sb.from("list_items").delete().eq("list_id", currentId).eq("done", true);
    if (error) return toast(tr("Couldn't clear: ") + error.message);
    done.forEach((d) => entries.delete(d.id));
    render();
  });

  return { start, stop, load };
}
