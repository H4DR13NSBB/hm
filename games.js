// =============================================================================
// Games tab: Tic-tac-toe and Connect Four, played live between your two phones,
// and Draw & Guess (sketch.js), which this tab hosts.
// Each game is one row in `games`. A move updates the row, and the database
// only lets the person whose turn it is do that. Starting a new game inserts a
// new row, so the old ones stay behind as the score.
// =============================================================================

const $ = (id) => document.getElementById(id);
const GAME_KEY = "duo-game";

const KINDS = {
  tictactoe: { name: "Tic-tac-toe", cols: 3, rows: 3, need: 3 },
  connect4:  { name: "Connect Four", cols: 7, rows: 6, need: 4 },
};
const size = (k) => KINDS[k].cols * KINDS[k].rows;
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

/** The winning cells through `idx`, or null. */
function lineThrough(kind, cells, idx) {
  const { cols, rows, need } = KINDS[kind];
  const mark = cells[idx];
  if (mark === "-") return null;
  const r0 = Math.floor(idx / cols), c0 = idx % cols;
  for (const [dc, dr] of DIRS) {
    const line = [idx];
    for (const s of [1, -1]) {
      let r = r0 + dr * s, c = c0 + dc * s;
      while (r >= 0 && r < rows && c >= 0 && c < cols && cells[r * cols + c] === mark) {
        line.push(r * cols + c);
        r += dr * s;
        c += dc * s;
      }
    }
    if (line.length >= need) return line;
  }
  return null;
}

function winningLine(kind, cells) {
  for (let i = 0; i < cells.length; i++) {
    const line = lineThrough(kind, cells, i);
    if (line) return line;
  }
  return null;
}

/**
 * @param deps.sb          Supabase (or demo) client
 * @param deps.getMe       () => { id } of the signed-in user
 * @param deps.getMembers  () => [{ user_id, display_name }]
 * @param deps.colorOf     Map user id -> CSS colour
 * @param deps.toast       (message) => void
 * @param deps.sketch      the Draw & Guess module, shown as one more game
 */
export function createGames({ sb, getMe, getMembers, colorOf, toast, sketch }) {
  const games = new Map(); // id -> games row
  let channel = null;
  let missing = false;     // table not created yet (schema.sql not re-run)
  let busy = false;        // a move is on its way to the database
  let lastSeen = new Map(); // kind -> cells shown last time (to animate the new mark)

  let kind = "tictactoe";
  const isKind = (k) => !!KINDS[k] || k === "sketch";
  try { if (isKind(localStorage.getItem(GAME_KEY))) kind = localStorage.getItem(GAME_KEY); } catch {}

  // ---------- lifecycle ----------
  async function start() {
    sketch.start();
    await load();
    channel = sb
      .channel("games")
      .on("postgres_changes", { event: "*", schema: "public", table: "games" }, (p) => {
        if (p.eventType === "DELETE") games.delete(p.old.id);
        else games.set(p.new.id, p.new);
        render();
      })
      .subscribe();
  }

  function stop() {
    sketch.stop();
    if (channel) sb.removeChannel(channel);
    channel = null;
    games.clear();
    lastSeen = new Map();
    render();
  }

  async function load() {
    sketch.load();
    const { data, error } = await sb.from("games").select("*").order("id");
    missing = !!error && /does not exist|schema cache|unknown table/i.test(error.message);
    if (error && !missing) toast("Couldn't load games: " + error.message);
    if (!error) {
      games.clear();
      data.forEach((g) => games.set(g.id, g));
    }
    render();
  }

  // ---------- helpers ----------
  const meId = () => getMe()?.id;
  const otherId = () => getMembers().find((m) => m.user_id !== meId())?.user_id;
  const nameOf = (id) => (id === meId() ? "You" : getMembers().find((m) => m.user_id === id)?.display_name ?? "?");
  const ofKind = (k) => [...games.values()].filter((g) => g.kind === k).sort((a, b) => a.id - b.id);
  const current = (k = kind) => ofKind(k).at(-1) ?? null;
  const markOf = (g, id) => (id === g.x_id ? "x" : "o");
  const playerOf = (g, mark) => (mark === "x" ? g.x_id : g.o_id);

  /** Games where it's my move, for the tab badge. */
  const myTurns = () => Object.keys(KINDS).filter((k) => {
    const g = current(k);
    return g && !g.winner && g.next_id === meId();
  }).length;

  // ---------- rendering ----------
  function render() {
    const turns = (missing ? 0 : myTurns()) + sketch.myTurns();
    $("games-badge").hidden = !turns;
    $("games-badge").textContent = turns;
    if (!meId()) return;

    for (const b of $("g-kinds").children) {
      const k = b.dataset.game, g = KINDS[k] && current(k);
      b.setAttribute("aria-selected", String(k === kind));
      b.classList.toggle("your-turn", k === "sketch" ? sketch.myTurns() > 0 : !!g && !g.winner && g.next_id === meId());
    }
    $("g-play").hidden = kind === "sketch";
    $("sk-main").hidden = kind !== "sketch";
    $("g-missing").hidden = !missing;
    $("g-game").hidden = missing;
    if (kind === "sketch" || missing) return;

    const g = current();
    const cells = g?.cells ?? "-".repeat(size(kind));
    const line = g?.winner && g.winner !== "draw" ? winningLine(kind, g.cells) : null;
    const before = lastSeen.get(kind);
    lastSeen.set(kind, cells);

    renderScore();
    renderStatus(g);
    renderBoard(g, cells, line, before);
    $("g-again").hidden = !g?.winner;
    $("g-restart").hidden = !g || !!g.winner || g.moves === 0;
  }

  function renderScore() {
    const wins = new Map();
    let draws = 0;
    for (const g of ofKind(kind)) {
      if (g.winner === "draw") draws++;
      else if (g.winner) {
        const id = playerOf(g, g.winner);
        wins.set(id, (wins.get(id) ?? 0) + 1);
      }
    }
    $("g-score").replaceChildren(...getMembers().map((m) => {
      const s = document.createElement("span");
      s.className = "g-score-person";
      s.style.setProperty("--c", colorOf.get(m.user_id));
      s.innerHTML = "<b></b><span></span>";
      s.querySelector("b").textContent = wins.get(m.user_id) ?? 0;
      s.querySelector("span").textContent = m.display_name;
      return s;
    }));
    const d = document.createElement("span");
    d.className = "g-score-draws muted";
    d.textContent = draws === 1 ? "1 draw" : `${draws} draws`;
    $("g-score").append(d);
  }

  function renderStatus(g) {
    const el = $("g-status");
    let text, color = null;
    if (!g) {
      text = "Make the first move";
      color = colorOf.get(meId());
    } else if (g.winner === "draw") {
      text = "It's a draw";
    } else if (g.winner) {
      const id = playerOf(g, g.winner);
      text = id === meId() ? "You win! 🎉" : `${nameOf(id)} wins`;
      color = colorOf.get(id);
    } else if (g.next_id === meId()) {
      text = "Your turn";
      color = colorOf.get(meId());
    } else {
      text = `${nameOf(g.next_id)}'s turn`;
      color = colorOf.get(g.next_id);
    }
    el.textContent = text;
    el.style.setProperty("--c", color ?? "var(--muted)");
  }

  function markEl(mark, g) {
    // before the first move: I'll be X
    const id = g ? playerOf(g, mark) : mark === "x" ? meId() : otherId();
    const i = document.createElement("i");
    i.className = `g-mark ${kind === "connect4" ? "disc" : mark}`;
    i.style.setProperty("--c", colorOf.get(id) ?? "var(--muted)");
    return i;
  }

  function renderBoard(g, cells, line, before) {
    const { cols } = KINDS[kind];
    const board = $("g-board");
    board.className = `g-board ${kind}`;
    board.style.setProperty("--cols", cols);
    const mine = canMove(g);
    board.classList.toggle("waiting", !mine);

    if (kind === "connect4") {
      // one button per column: you drop into a column, not a cell
      board.replaceChildren(...Array.from({ length: cols }, (_, c) => {
        const col = document.createElement("button");
        col.type = "button";
        col.className = "g-col";
        col.setAttribute("aria-label", `Column ${c + 1}`);
        col.disabled = !mine || cells[c] !== "-";
        for (let r = 0; r < KINDS.connect4.rows; r++) {
          col.append(cellEl(r * cols + c, cells, g, line, before));
        }
        col.addEventListener("click", () => drop(c));
        return col;
      }));
      return;
    }

    board.replaceChildren(...[...cells].map((_, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "g-cell-btn";
      b.setAttribute("aria-label", `Row ${Math.floor(i / cols) + 1}, column ${(i % cols) + 1}`);
      b.disabled = !mine || cells[i] !== "-";
      b.append(cellEl(i, cells, g, line, before));
      b.addEventListener("click", () => move(i));
      return b;
    }));
  }

  function cellEl(i, cells, g, line, before) {
    const span = document.createElement("span");
    span.className = "g-cell";
    if (cells[i] !== "-") {
      const m = markEl(cells[i], g);
      if (before && before[i] === "-") m.classList.add("new");
      if (kind === "connect4") m.style.setProperty("--fall", Math.floor(i / KINDS.connect4.cols) + 1);
      span.append(m);
    }
    if (line?.includes(i)) span.classList.add("win");
    return span;
  }

  // ---------- playing ----------
  function canMove(g) {
    if (busy || !otherId()) return false;
    if (!g) return true; // nobody has started yet
    return !g.winner && g.next_id === meId();
  }

  function drop(col) {
    const cells = current()?.cells ?? "-".repeat(size(kind));
    const { cols, rows } = KINDS.connect4;
    for (let r = rows - 1; r >= 0; r--) {
      if (cells[r * cols + col] === "-") return move(r * cols + col);
    }
  }

  async function move(idx) {
    let g = current();
    if (!canMove(g)) return;
    if (!g) {
      // first ever game of this kind: whoever moves first is X
      g = await newGame(kind, meId());
      if (!g) return;
    }
    if (g.cells[idx] !== "-") return;

    const mark = markOf(g, meId());
    const cells = g.cells.slice(0, idx) + mark + g.cells.slice(idx + 1);
    const winner = lineThrough(kind, cells, idx) ? mark : cells.includes("-") ? null : "draw";
    const patch = { cells, moves: g.moves + 1, winner, next_id: playerOf(g, mark === "x" ? "o" : "x") };
    const before = { ...g };

    Object.assign(g, patch);
    busy = true;
    render();
    if (navigator.vibrate) navigator.vibrate(10);
    // only lands if nobody moved in between (and the database checks it's your turn)
    const { data, error } = await sb.from("games").update(patch)
      .eq("id", g.id).eq("moves", before.moves).select();
    busy = false;
    if (error || !data?.length) {
      Object.assign(g, before);
      toast(error ? "Couldn't play: " + error.message : "The board changed. Have another look.");
      return load();
    }
    games.set(g.id, data[0]);
    render();
  }

  /** Inserts a fresh game where `xId` goes first. */
  async function newGame(k, xId) {
    const oId = getMembers().find((m) => m.user_id !== xId)?.user_id;
    busy = true;
    const { data, error } = await sb.from("games").insert({
      kind: k, cells: "-".repeat(size(k)), x_id: xId, o_id: oId, next_id: xId, moves: 0,
    }).select().single();
    busy = false;
    if (error) {
      toast("Couldn't start a game: " + error.message);
      render();
      return null;
    }
    games.set(data.id, data);
    lastSeen.set(k, data.cells);
    render();
    return data;
  }

  // last game's O goes first next time
  const again = () => newGame(kind, current()?.o_id ?? meId());

  // ---------- buttons ----------
  $("g-kinds").addEventListener("click", (e) => {
    const k = e.target.closest("[data-game]")?.dataset.game;
    if (!isKind(k)) return;
    kind = k;
    try { localStorage.setItem(GAME_KEY, k); } catch {}
    render();
  });
  $("g-again").addEventListener("click", again);
  $("g-restart").addEventListener("click", () => {
    if (confirm(`Give up this ${KINDS[kind].name} game and start a new one? It won't count.`)) again();
  });

  return { start, stop, load, render };
}
