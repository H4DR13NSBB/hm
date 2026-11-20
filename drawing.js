// =============================================================================
// Painting strokes from the drawing pad, shared by the board and Draw & Guess.
// A stroke is { color, size, pts: [[x, y], ...] }: points are fractions of the
// pad width, and brush sizes are relative to a 400px-wide pad.
// =============================================================================

/** Draws strokes. `scale` = pixels per pad width; (ox, oy) = top-left, in pad widths. */
export function paint(ctx, scale, ox, oy, list) {
  ctx.lineCap = ctx.lineJoin = "round";
  for (const st of list) {
    if (!st.pts.length) continue;
    const X = (p) => (p[0] - ox) * scale, Y = (p) => (p[1] - oy) * scale;
    ctx.strokeStyle = ctx.fillStyle = st.color;
    ctx.lineWidth = st.size / 400 * scale;
    ctx.beginPath();
    if (st.pts.length === 1) {
      ctx.arc(X(st.pts[0]), Y(st.pts[0]), ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.moveTo(X(st.pts[0]), Y(st.pts[0]));
    // smooth: curve through the midpoints between samples
    for (let i = 1; i < st.pts.length - 1; i++) {
      const a = st.pts[i], b = st.pts[i + 1];
      ctx.quadraticCurveTo(X(a), Y(a), (X(a) + X(b)) / 2, (Y(a) + Y(b)) / 2);
    }
    ctx.lineTo(X(st.pts.at(-1)), Y(st.pts.at(-1)));
    ctx.stroke();
  }
}

/** The box around the ink (plus brush radius), within the aspect ratios the board allows. */
export function inkBounds(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const st of list) {
    const r = st.size / 800 + 0.01;
    for (const [x, y] of st.pts) {
      x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r);
      x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r);
    }
  }
  let bw = x1 - x0, bh = y1 - y0;
  if (bw / bh > 9) { y0 -= (bw / 9 - bh) / 2; bh = bw / 9; }
  if (bw / bh < 1 / 9) { x0 -= (bh / 9 - bw) / 2; bw = bh / 9; }
  return { x0, y0, bw, bh };
}

/** Crops the strokes to their ink and renders a transparent PNG. Resolves to { blob, width, height, bw }. */
export async function renderPNG(list, maxSide, maxScale = Infinity) {
  const { x0, y0, bw, bh } = inkBounds(list);
  const scale = Math.min(maxSide / Math.max(bw, bh), maxScale);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(bw * scale));
  out.height = Math.max(1, Math.round(bh * scale));
  paint(out.getContext("2d"), scale, x0, y0, list);
  const blob = await new Promise((r) => out.toBlob(r, "image/png"));
  return { blob, width: out.width, height: out.height, bw };
}

/** Paints the strokes into a canvas, fitted and centred, with a margin. `upto` = points to show (for replays). */
export function paintFitted(canvas, list, upto = Infinity) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!list.length) return;
  const { x0, y0, bw, bh } = inkBounds(list);
  const m = 0.08;
  const scale = Math.min(canvas.width / (bw * (1 + 2 * m)), canvas.height / (bh * (1 + 2 * m)));
  const ox = x0 - (canvas.width / scale - bw) / 2, oy = y0 - (canvas.height / scale - bh) / 2;
  let left = upto;
  const partial = [];
  for (const st of list) {
    if (left <= 0) break;
    partial.push(left >= st.pts.length ? st : { ...st, pts: st.pts.slice(0, left) });
    left -= st.pts.length;
  }
  paint(ctx, scale, ox, oy, partial);
}

/** Smaller strokes to store: 4 decimals, without points that barely moved. */
export function packStrokes(list) {
  return list.map(({ color, size, pts }) => {
    const out = [];
    for (const [x, y] of pts) {
      const p = [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4];
      const q = out.at(-1);
      if (!q || Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) > 0.002) out.push(p);
    }
    const last = pts.at(-1);
    if (out.length > 1 && last) out[out.length - 1] = [Math.round(last[0] * 1e4) / 1e4, Math.round(last[1] * 1e4) / 1e4];
    return { color, size, pts: out };
  });
}
