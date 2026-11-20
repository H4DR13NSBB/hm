// =============================================================================
// Voice notes and videos: recording them in the app (or picking a file), and
// playing them. Used by the board and by gift boxes.
// Files are uploaded as they are (no re-encoding in the browser), so recordings
// are kept short and at a modest bitrate to stay well under the upload limit.
// =============================================================================

import { tr } from "./i18n.js";

const $ = (id) => document.getElementById(id);

export const MEDIA_MAX_BYTES = 30 * 1024 * 1024; // the photos Worker accepts up to this
const MAX_SECONDS = { audio: 180, video: 60 };
const MIME = {
  audio: ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"],
  video: ["video/mp4;codecs=avc1,mp4a", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"],
};
const EXT = {
  "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/aac": "aac", "audio/webm": "webm",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
};
// what some phones call these files -> what the Worker expects
const ALIAS = { "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4", "audio/mp3": "audio/mpeg", "audio/x-aac": "audio/aac" };

const baseType = (t) => {
  const b = (t || "").split(";")[0].trim().toLowerCase();
  return ALIAS[b] ?? b;
};

export function fmtDuration(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Opens the file picker. Resolves to the file, or null if cancelled (where the browser says so). */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = $("pick-input");
    input.accept = accept;
    input.value = "";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Duration (and size, for video) of a sound or video file, read by the browser. */
function inspect(blob, kind) {
  return new Promise((resolve) => {
    const m = document.createElement(kind === "video" ? "video" : "audio");
    m.preload = "metadata";
    m.muted = true;
    const url = URL.createObjectURL(blob);
    const done = (ok) => {
      clearTimeout(timer);
      const out = ok ? {
        duration: Number.isFinite(m.duration) ? m.duration : null,
        aspect: kind === "video" && m.videoWidth && m.videoHeight ? m.videoWidth / m.videoHeight : null,
      } : null;
      m.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(out);
    };
    const timer = setTimeout(() => done(true), 5000);
    m.onloadedmetadata = () => done(true);
    m.onerror = () => done(false);
    m.src = url;
  });
}

// ---------------------------------------------------------------------------
// Playing. Only one thing plays at a time.
// ---------------------------------------------------------------------------
let playing = null;

export function togglePlay(m) {
  if (!m) return;
  if (!m.paused) return m.pause();
  if (playing && playing !== m) playing.pause();
  playing = m;
  m.play().catch(() => {});
}

export function stopAll() {
  playing?.pause();
  playing = null;
}

/**
 * Wires a board-style player: `el` gets .playing while it plays, and the
 * `.dur` inside it counts down.
 */
export function wirePlayer(el, m, duration) {
  const dur = el.querySelector(".dur");
  const show = () => {
    if (!dur) return;
    const total = Number.isFinite(m.duration) && m.duration > 0 ? m.duration : duration;
    dur.textContent = fmtDuration(m.paused && !m.currentTime ? total : Math.max(0, (total || 0) - m.currentTime));
  };
  m.addEventListener("play", () => el.classList.add("playing"));
  m.addEventListener("pause", () => el.classList.remove("playing"));
  m.addEventListener("ended", () => { m.currentTime = 0; show(); });
  m.addEventListener("timeupdate", show);
  m.addEventListener("loadedmetadata", show);
  show();
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
export function createRecorder() {
  const dlg = $("rec");
  const live = $("rec-live");
  const reviewVideo = $("rec-review");
  const reviewAudio = $("rec-review-audio");
  let kind = "audio";
  let stream = null, recorder = null, chunks = [];
  let startedAt = 0, timer = 0, facing = "user";
  let result = null;       // what "Use" hands back
  let resolveFn = null;
  let reviewUrl = null;

  function setStatus(text) { $("rec-status").textContent = text; }

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    live.srcObject = null;
  }

  function clearReview() {
    if (reviewUrl) URL.revokeObjectURL(reviewUrl);
    reviewUrl = null;
    for (const m of [reviewVideo, reviewAudio]) { m.pause(); m.removeAttribute("src"); m.load(); m.hidden = true; }
    result = null;
    $("rec-use").disabled = true;
    $("rec-retake").hidden = true;
  }

  async function startStream() {
    stopStream();
    try {
      stream = await navigator.mediaDevices.getUserMedia(kind === "video"
        ? { audio: true, video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } }
        : { audio: true });
    } catch (err) {
      setStatus(err?.name === "NotAllowedError"
        ? tr(kind === "video" ? "Duo isn't allowed to use the camera. You can allow it in Settings, or choose a file instead." : "Duo isn't allowed to use the microphone. You can allow it in Settings, or choose a file instead.")
        : tr(kind === "video" ? "Couldn't start the camera. You can choose a file instead." : "Couldn't start the microphone. You can choose a file instead."));
      $("rec-btn").disabled = true;
      return;
    }
    $("rec-btn").disabled = false;
    if (kind === "video") {
      live.srcObject = stream;
      live.hidden = false;
      live.classList.toggle("mirror", facing === "user");
      live.play().catch(() => {});
    }
    setStatus(kind === "video" ? tr("Up to {n} seconds", { n: MAX_SECONDS.video }) : tr("Up to {n} minutes", { n: MAX_SECONDS.audio / 60 }));
  }

  function startRecording() {
    if (!stream || recorder) return;
    clearReview();
    const mimeType = MIME[kind].find((t) => window.MediaRecorder?.isTypeSupported?.(t));
    try {
      recorder = new MediaRecorder(stream, {
        ...(mimeType && { mimeType }),
        ...(kind === "video" ? { videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 } : { audioBitsPerSecond: 128_000 }),
      });
    } catch {
      return setStatus(tr("This browser can't record here. Choose a file instead."));
    }
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    recorder.onstop = finishRecording;
    recorder.start(1000);
    startedAt = Date.now();
    dlg.classList.add("recording");
    $("rec-btn").setAttribute("aria-label", tr("Stop"));
    $("rec-flip").disabled = true;
    $("rec-file").disabled = true;
    tick();
    timer = setInterval(tick, 250);
  }

  function tick() {
    const s = (Date.now() - startedAt) / 1000;
    setStatus(`● ${fmtDuration(s)} / ${fmtDuration(MAX_SECONDS[kind])}`);
    if (s >= MAX_SECONDS[kind]) stopRecording();
  }

  function stopRecording() {
    if (recorder?.state === "recording") recorder.stop();
  }

  async function finishRecording() {
    clearInterval(timer);
    const r = recorder;
    recorder = null;
    dlg.classList.remove("recording");
    $("rec-btn").setAttribute("aria-label", tr("Record"));
    $("rec-flip").disabled = false;
    $("rec-file").disabled = false;
    if (!dlg.open) return; // closed while recording: throw it away
    const seconds = (Date.now() - startedAt) / 1000;
    const type = baseType(r.mimeType || chunks[0]?.type || (kind === "video" ? "video/mp4" : "audio/mp4"));
    const blob = new Blob(chunks, { type });
    chunks = [];
    if (seconds < 0.5 || !blob.size) return setStatus(tr("That was too short. Hold on a little longer."));
    await review(blob, seconds);
  }

  /** Shows what was recorded (or picked) and gets it ready to hand back. */
  async function review(blob, seconds) {
    const type = baseType(blob.type);
    if (!EXT[type] || !type.startsWith(kind)) {
      return setStatus(tr(kind === "video" ? "That file type can't be used. Try an MP4 or MOV video." : "That file type can't be used. Try an M4A or MP3 file."));
    }
    if (blob.size > MEDIA_MAX_BYTES) {
      return setStatus(tr("That's too big ({n} MB, max 30). Try a shorter one.", { n: Math.round(blob.size / 1048576) }));
    }
    const info = await inspect(blob, kind);
    const duration = info?.duration ?? seconds;
    if (duration && duration > MAX_SECONDS[kind] + 1) {
      return setStatus(tr("That's too long ({d}). Keep it under {max}.", { d: fmtDuration(duration), max: fmtDuration(MAX_SECONDS[kind]) }));
    }
    if (kind === "video") {
      stopStream(); // done with the camera
      live.hidden = true;
    }
    clearReview();
    reviewUrl = URL.createObjectURL(blob);
    const m = kind === "video" ? reviewVideo : reviewAudio;
    m.src = reviewUrl;
    m.hidden = false;
    const aspect = kind === "video"
      ? info?.aspect ?? await new Promise((r) => {
          if (m.videoWidth) return r(m.videoWidth / m.videoHeight);
          m.addEventListener("loadedmetadata", () => r(m.videoWidth ? m.videoWidth / m.videoHeight : 9 / 16), { once: true });
          setTimeout(() => r(9 / 16), 3000);
        })
      : null;
    result = {
      kind, blob, type, ext: EXT[type],
      duration: Math.round(Math.min(duration || seconds || 0, 600) * 10) / 10,
      aspect: aspect ? Math.min(Math.max(aspect, 0.1), 10) : null,
    };
    setStatus(`${fmtDuration(result.duration)} · ${(blob.size / 1048576).toFixed(1)} MB`);
    $("rec-use").disabled = false;
    $("rec-retake").hidden = false;
  }

  $("rec-btn").addEventListener("click", () => (recorder ? stopRecording() : startRecording()));
  $("rec-retake").addEventListener("click", () => {
    clearReview();
    startStream();
  });
  $("rec-flip").addEventListener("click", () => {
    facing = facing === "user" ? "environment" : "user";
    startStream();
  });
  $("rec-file").addEventListener("click", async () => {
    const file = await pickFile(kind === "video" ? "video/*" : "audio/*");
    if (!file || !dlg.open) return;
    setStatus(tr("Reading the file…"));
    await review(file, null);
  });
  $("rec-use").addEventListener("click", () => {
    const r = result, done = resolveFn;
    resolveFn = null;
    dlg.close();
    done?.(r);
  });
  dlg.addEventListener("close", () => {
    stopRecording();
    clearInterval(timer);
    stopStream();
    clearReview();
    dlg.classList.remove("recording");
    resolveFn?.(null);
    resolveFn = null;
  });

  /** Opens the recorder. Resolves to { kind, blob, type, ext, duration, aspect }, or null. */
  function record(k) {
    if (dlg.open) dlg.close();
    kind = k;
    $("rec-title").textContent = k === "video" ? tr("🎥 Video") : tr("🎙️ Voice note");
    $("rec-flip").hidden = k !== "video";
    $("rec-mic").hidden = k === "video";
    live.hidden = k !== "video";
    clearReview();
    setStatus(tr(""));
    dlg.showModal();
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      $("rec-btn").disabled = true;
      setStatus(tr("Recording isn't possible in this browser. Choose a file instead."));
    } else {
      startStream();
    }
    return new Promise((r) => { resolveFn = r; });
  }

  return { record };
}
