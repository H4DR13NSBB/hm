// Photo storage for Duo on Cloudflare R2.
//
// The app sends its Supabase login token; this Worker checks it and only lets
// the two members in. Photos are private: viewing goes through short-lived
// signed links, just like Supabase Storage's signed URLs.
//
//   PUT    /o/<user_id>/<id>.jpg     upload (own folder only)         Bearer token
//   DELETE /o/<user_id>/<id>.jpg     delete (own folder only)         Bearer token
//   POST   /sign  {paths:[...]}      -> {urls:{path:url}, expires}    Bearer token
//   GET    /p/<path>?exp=..&sig=..   the photo itself (signed link, no token)
//   POST   /resolve {url}            -> {url}  expand a Google Maps short link  Bearer token
//   GET    /gifs?type=gifs|stickers&q=..&offset=..  -> {results, next}  GIPHY search  Bearer token
//   POST   /push/test                -> {sent}  a test notification to your own phones  Bearer token
//
// Every minute (cron, see wrangler.toml) it also sends the push notifications
// that Supabase's push_due() says are due.
//
// Settings (see wrangler.toml):
//   SUPABASE_URL      var     https://<ref>.supabase.co
//   ALLOWED_ORIGINS   var     comma-separated site origins allowed to call the API
//   VAPID_PUBLIC_KEY  var     push public key (also in the site's config.js)
//   VAPID_SUBJECT     var     a link or mailto: for push services to reach you
//   MEMBERS           secret  comma-separated Supabase user ids of the two of you
//   SIGNING_KEY       secret  any long random string (signs the view links)
//   GIPHY_KEY         secret  GIPHY API key, for GIF & sticker search
//   VAPID_PRIVATE_KEY secret  push private key ("d" of the key pair, base64url)
//   SUPABASE_SECRET_KEY secret  Supabase secret (service role) key, to read what's due
//   JWT_SECRET        secret  optional: only for projects still on the legacy HS256 JWT secret

const MAX_BYTES = 5 * 1024 * 1024;        // photos
const MAX_MEDIA_BYTES = 30 * 1024 * 1024; // voice notes and videos
const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MEDIA_TYPES = ["audio/mp4", "audio/mpeg", "audio/webm", "audio/aac", "video/mp4", "video/quicktime", "video/webm"];
const LINK_TTL = 60 * 60; // seconds
const PATH_RE = /^[0-9a-f-]{36}\/[0-9a-zA-Z-]{8,64}\.(jpg|png|webp|m4a|mp3|aac|mp4|mov|webm)$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/p/")) return await view(req, url, env);

      const user = await authenticate(req, env);
      if (!user) return json({ error: "Not signed in" }, 401, cors);
      if (!members(env).includes(user)) return json({ error: "Not a member" }, 403, cors);

      if (req.method === "POST" && url.pathname === "/sign") {
        const { paths } = await req.json();
        if (!Array.isArray(paths) || paths.length > 500) return json({ error: "Bad request" }, 400, cors);
        // Round expiry to the hour so the same photo keeps the same link (browser cache hits).
        const expires = (Math.floor(Date.now() / 1000 / LINK_TTL) + 2) * LINK_TTL;
        const urls = {};
        for (const p of paths) {
          if (typeof p !== "string" || !PATH_RE.test(p)) continue;
          urls[p] = `${url.origin}/p/${p}?exp=${expires}&sig=${await sign(env, `${p}:${expires}`)}`;
        }
        return json({ urls, expires }, 200, cors);
      }

      if (req.method === "POST" && url.pathname === "/resolve") {
        const { url: link } = await req.json();
        return json(await resolveMapsLink(String(link)), 200, cors);
      }

      if (req.method === "GET" && url.pathname === "/gifs") {
        if (!env.GIPHY_KEY) return json({ error: "GIF search isn't set up yet (GIPHY_KEY)" }, 503, cors);
        return json(await searchGifs(url.searchParams, env), 200, cors);
      }

      if (req.method === "POST" && url.pathname === "/push/test") {
        const { lang } = await req.json().catch(() => ({}));
        const subs = await supabase(env, "GET", `/push_subscriptions?select=endpoint,p256dh,auth,lang&user_id=eq.${user}`);
        let sent = 0;
        for (const s of subs) {
          if (await push(env, s, testMessage(lang === "fr" ? "fr" : s.lang), 300)) sent++;
        }
        return json({ sent }, 200, cors);
      }

      if (url.pathname.startsWith("/o/")) {
        const path = decodeURIComponent(url.pathname.slice(3));
        if (!PATH_RE.test(path)) return json({ error: "Bad path" }, 400, cors);
        if (path.split("/")[0] !== user) return json({ error: "Not your photo" }, 403, cors);

        if (req.method === "PUT") {
          const type = (req.headers.get("content-type") || "").split(";")[0];
          const media = MEDIA_TYPES.includes(type);
          if (!media && !TYPES.includes(type)) return json({ error: "Not an image, sound or video" }, 415, cors);
          const max = media ? MAX_MEDIA_BYTES : MAX_BYTES;
          const tooBig = media ? "File too large (max 30 MB)" : "Photo too large";
          const size = Number(req.headers.get("content-length") || 0);
          if (size > max) return json({ error: tooBig }, 413, cors);
          const body = await req.arrayBuffer();
          if (body.byteLength > max) return json({ error: tooBig }, 413, cors);
          if (await env.PHOTOS.head(path)) return json({ error: "Already exists" }, 409, cors);
          await env.PHOTOS.put(path, body, { httpMetadata: { contentType: type } });
          return json({ path }, 200, cors);
        }
        if (req.method === "DELETE") {
          await env.PHOTOS.delete(path);
          return json({ ok: true }, 200, cors);
        }
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      return json({ error: "Server error" }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDue(env));
  },
};

// ---------- viewing ----------
// Supports Range requests: iPhone Safari won't play a video without them.
async function view(req, url, env) {
  const path = decodeURIComponent(url.pathname.slice(3));
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") || "";
  const now = Math.floor(Date.now() / 1000);
  if (!PATH_RE.test(path) || !(exp > now) || !timingSafeEqual(sig, await sign(env, `${path}:${exp}`))) {
    return new Response("Link expired", { status: 403 });
  }
  const ranged = req.headers.has("range");
  const obj = req.method === "HEAD"
    ? await env.PHOTOS.head(path)
    : await env.PHOTOS.get(path, ranged ? { range: req.headers } : undefined);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = {
    "content-type": obj.httpMetadata?.contentType || "image/jpeg",
    "cache-control": `private, max-age=${exp - now}`,
    "etag": obj.httpEtag,
    "accept-ranges": "bytes",
  };
  const r = obj.range;
  if (!ranged || !r || req.method === "HEAD") {
    return new Response(obj.body ?? null, { headers: { ...headers, "content-length": String(obj.size) } });
  }
  const offset = "suffix" in r ? obj.size - r.suffix : r.offset ?? 0;
  const length = "suffix" in r ? r.suffix : r.length ?? obj.size - offset;
  return new Response(obj.body, {
    status: 206,
    headers: {
      ...headers,
      "content-range": `bytes ${offset}-${offset + length - 1}/${obj.size}`,
      "content-length": String(length),
    },
  });
}

// ---------- GIFs & stickers ----------
// Searches GIPHY here so the API key never reaches the public site.
// Empty query = trending. Only what the app needs is sent back.
async function searchGifs(params, env) {
  const type = params.get("type") === "stickers" ? "stickers" : "gifs";
  const q = (params.get("q") || "").trim().slice(0, 50);
  const api = new URL(`https://api.giphy.com/v1/${type}/${q ? "search" : "trending"}`);
  api.search = new URLSearchParams({
    api_key: env.GIPHY_KEY,
    limit: "24",
    offset: String(Math.min(Math.max(Number(params.get("offset")) || 0, 0), 4999)),
    rating: "pg-13",
    ...(q && { q }),
  });
  const res = await fetch(api);
  if (!res.ok) throw new Error(`GIPHY error (${res.status})`);
  const { data = [], pagination = {} } = await res.json();
  const results = [];
  for (const g of data) {
    const big = g.images?.downsized?.url ? g.images.downsized : g.images?.original;
    const small = g.images?.fixed_width?.url ? g.images.fixed_width : big;
    const w = Number(big?.width), h = Number(big?.height);
    if (!big?.url || !(w > 0) || !(h > 0)) continue;
    results.push({ url: big.url, w, h, preview: small.webp || small.url, title: g.title || "" });
  }
  const end = (pagination.offset ?? 0) + (pagination.count ?? data.length);
  return { results, next: data.length && end < (pagination.total_count ?? 0) ? end : null };
}

// ---------- Google Maps links ----------
// Short links (maps.app.goo.gl/...) redirect to the full URL with the place's
// name and coordinates; a browser can't follow that itself (CORS). Only Google
// hosts are fetched, so this can't be used to reach arbitrary sites.
const MAPS_HOST = /^(maps\.app\.goo\.gl|goo\.gl|(www\.|maps\.)?google\.[a-z.]{2,6}|consent\.google\.[a-z.]{2,6})$/i;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

async function resolveMapsLink(link) {
  let current = new URL(link);
  for (let hop = 0; hop < 8; hop++) {
    if (current.protocol !== "https:" || !MAPS_HOST.test(current.hostname)) throw new Error("Not a Google Maps link");
    // EU cookie-consent interstitial: the real destination is in ?continue=
    const next = current.searchParams.get("continue");
    if (/^consent\./i.test(current.hostname) && next) { current = new URL(next); continue; }
    // Reached a full Google Maps URL: the name and pin are in it. Fetching it
    // again only bounces to the consent page (in the EU), so stop here.
    if (!/goo\.gl$/i.test(current.hostname)) break;
    const res = await fetch(current, { redirect: "manual", headers: { "user-agent": UA, "accept-language": "en" } });
    const location = res.headers.get("location");
    await res.body?.cancel();
    if (res.status >= 300 && res.status < 400 && location) { current = new URL(location, current); continue; }
    break;
  }
  return { url: current.toString() };
}

// ---------- push notifications ----------
// Supabase decides what's due (push_due() in schema.sql, which also makes sure
// nothing goes out twice); this words it in each phone's language and sends it.
async function sendDue(env) {
  if (!env.SUPABASE_SECRET_KEY || !env.VAPID_PRIVATE_KEY) return;
  const due = await supabase(env, "POST", "/rpc/push_due", {});
  if (!due.length) return;
  const users = [...new Set(due.map((d) => d.user_id))];
  const subs = await supabase(env, "GET", `/push_subscriptions?select=endpoint,user_id,p256dh,auth,lang&user_id=in.(${users.join(",")})`);
  await Promise.all(due.flatMap((d) => subs.filter((s) => s.user_id === d.user_id).map((s) =>
    push(env, s, message(d, s.lang), TTL[d.topic] ?? 3600).catch((err) => console.log("push failed", err.message)))));
}

// How long a push may wait for a phone that's offline before it's dropped (seconds)
const TTL = { board: 6 * 3600, games: 6 * 3600, mail: 86400, gifts: 86400, trip_next: 3600, trip_arrive: 1800 };
const TAB = { board: "board", games: "games", mail: "mail", gifts: "board", trip_next: "trips", trip_arrive: "trips" };

const WORDS = {
  en: {
    board: "New on the board", boardOne: "{from} added {what}.", boardMany: "{from} added {n} things today.",
    what: { text: "a note", photo: "a picture", gif: "a GIF", sticker: "a sticker", audio: "a voice note", video: "a video" },
    games: { tictactoe: "Tic-tac-toe", connect4: "Connect Four", sketch: "Draw & Guess" },
    yourTurn: "Your turn", played: "{from} played in {game}.", started: "{from} started a game. Your move!",
    draw: "It's a draw!", won: "{from} won this one.",
    sketchNew: "{from} drew something for you. Can you guess it?",
    guessed: "{from} guessed your drawing: “{word}” ✓", gave_up: "{from} gave up on “{word}”.",
    mail: "You've got mail 📬", mailOne: "A postcard from {from} just arrived.", mailMany: "{n} postcards from {from} just arrived.",
    advent: "🎁 Advent box {day}", birthday: "🎂 Happy birthday!", anniversary: "💞 Happy anniversary!",
    gift: "{from} left you a gift box. Open it on the board.",
    next: "At {time}, in {lead}", arrive: "Arriving at {time}, in about {lead}",
    test: "Notifications work 🎉",
  },
  fr: {
    board: "Du nouveau sur le tableau", boardOne: "{from} a ajouté {what}.", boardMany: "{from} a ajouté {n} choses aujourd'hui.",
    what: { text: "une note", photo: "une image", gif: "un GIF", sticker: "un sticker", audio: "un message vocal", video: "une vidéo" },
    games: { tictactoe: "Morpion", connect4: "Puissance 4", sketch: "Dessine et devine" },
    yourTurn: "À toi de jouer", played: "{from} a joué au {game}.", started: "{from} a lancé une partie. À toi de jouer !",
    draw: "Match nul !", won: "{from} a gagné cette partie.",
    sketchNew: "{from} t'a dessiné quelque chose. Tu devines ?",
    guessed: "{from} a deviné ton dessin : « {word} » ✓", gave_up: "{from} a abandonné « {word} ».",
    mail: "Tu as du courrier 📬", mailOne: "Une carte postale de {from} vient d'arriver.", mailMany: "{n} cartes postales de {from} viennent d'arriver.",
    advent: "🎁 Calendrier de l'Avent, jour {day}", birthday: "🎂 Joyeux anniversaire !", anniversary: "💞 Joyeux anniversaire à vous deux !",
    gift: "{from} t'a laissé une boîte cadeau. Ouvre-la sur le tableau.",
    next: "À {time}, dans {lead}", arrive: "Arrivée à {time}, dans {lead} environ",
    test: "Les notifications marchent 🎉",
  },
};
const ICONS = { flight: "✈️", train: "🚆", transport: "🚌", stay: "🏨", activity: "🎟", food: "🍽", place: "📍", other: "📝" };
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
const lead = (min) => (min >= 60 ? `${min / 60} h` : `${min} min`);

/** The notification for one row of push_due(), in English or French. */
function message({ topic, tag, data: d }, lang) {
  const w = WORDS[lang] || WORDS.en;
  let title, body;
  if (topic === "board") {
    title = w.board;
    body = d.n === 1 ? fill(w.boardOne, { from: d.from, what: w.what[d.kind] ?? w.what.text }) : fill(w.boardMany, d);
  } else if (topic === "games" && d.sketch) {
    title = w.games.sketch;
    body = fill(d.sketch === "new" ? w.sketchNew : w[d.sketch], d);
  } else if (topic === "games") {
    const game = w.games[d.game];
    title = d.winner || d.new ? game : w.yourTurn;
    body = fill(d.winner === "draw" ? w.draw : d.winner ? w.won : d.new ? w.started : w.played, { from: d.from, game });
  } else if (topic === "mail") {
    title = w.mail;
    body = fill(d.n === 1 ? w.mailOne : w.mailMany, d);
  } else if (topic === "gifts") {
    title = fill(w[d.occasion] ?? w.advent, d);
    body = fill(w.gift, d);
  } else {
    title = `${ICONS[d.kind] ?? "📍"} ${d.title}`;
    body = fill(topic === "trip_next" ? w.next : w.arrive, { time: d.time, lead: lead(d.mins) });
    if (topic === "trip_next" && d.place) body += ` · ${d.place}`;
  }
  return { title, body, tag, tab: TAB[topic] };
}
const testMessage = (lang) => ({ title: "Duo", body: (WORDS[lang] || WORDS.en).test, tag: "test", tab: "board" });

/** Talks to Supabase as the server (the secret key skips the row rules). */
async function supabase(env, method, path, body) {
  const key = env.SUPABASE_SECRET_KEY;
  const headers = { apikey: key, "content-type": "application/json" };
  if (!key.startsWith("sb_")) headers.authorization = `Bearer ${key}`; // legacy service_role JWT
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, { method, headers, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/**
 * Sends one Web Push message (RFC 8291 encryption, RFC 8292 VAPID).
 * Returns true if the push service took it. A phone that's gone away is forgotten.
 */
async function push(env, sub, msg, ttl) {
  const body = await encrypt(sub, new TextEncoder().encode(JSON.stringify(msg)));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuth(env, new URL(sub.endpoint).origin),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(ttl),
      urgency: "high",
      topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32), // a newer push with the same topic replaces one still waiting
    },
    body,
  });
  if (res.status === 404 || res.status === 410) {
    await supabase(env, "DELETE", `/push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`);
  } else if (!res.ok) {
    console.log("push service said", res.status, await res.text());
  }
  return res.ok;
}

async function encrypt(sub, plaintext) {
  const uaPublic = b64urlBytes(sub.p256dh);
  const authSecret = b64urlBytes(sub.auth);
  const ecdh = { name: "ECDH", namedCurve: "P-256" };
  const local = await crypto.subtle.generateKey(ecdh, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, ecdh, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = concat(plaintext, new Uint8Array([2])); // 2 = last (and only) record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

const vapidCache = new Map(); // push service origin -> { header, exp }
async function vapidAuth(env, audience) {
  const now = Math.floor(Date.now() / 1000);
  const hit = vapidCache.get(audience);
  if (hit && hit.exp > now + 600) return hit.header;
  const exp = now + 12 * 3600;
  const pub = b64urlBytes(env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE_KEY,
    x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)),
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const unsigned = `${b64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })))}.${b64url(utf8(JSON.stringify({ aud: audience, exp, sub: env.VAPID_SUBJECT })))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(unsigned));
  const header = `vapid t=${unsigned}.${b64url(new Uint8Array(sig))}, k=${env.VAPID_PUBLIC_KEY}`;
  vapidCache.set(audience, { header, exp });
  return header;
}

const utf8 = (s) => new TextEncoder().encode(s);
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---------- auth ----------
const members = (env) => (env.MEMBERS || "").split(",").map((s) => s.trim()).filter(Boolean);

/** Verifies the Supabase access token and returns the user id, or null. */
async function authenticate(req, env) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer (.+)$/);
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const header = JSON.parse(b64urlText(h));
  const payload = JSON.parse(b64urlText(p));
  const data = new TextEncoder().encode(`${h}.${p}`);
  const sigBytes = b64urlBytes(s);

  let ok = false;
  if (header.alg === "HS256" && env.JWT_SECRET) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    ok = await crypto.subtle.verify("HMAC", key, sigBytes, data);
  } else if (header.alg === "ES256" || header.alg === "RS256") {
    const jwk = (await jwks(env)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const algo = header.alg === "ES256"
      ? { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" }
      : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    const key = await crypto.subtle.importKey("jwk", jwk, algo, false, ["verify"]);
    ok = await crypto.subtle.verify(algo, key, sigBytes, data);
  }
  if (!ok) return null;
  if (!(payload.exp > Date.now() / 1000)) return null;
  if (payload.role !== "authenticated" || typeof payload.sub !== "string") return null;
  return payload.sub;
}

let jwksCache = { keys: null, at: 0 };
async function jwks(env) {
  if (jwksCache.keys && Date.now() - jwksCache.at < 10 * 60_000) return jwksCache.keys;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
  const { keys } = await res.json();
  jwksCache = { keys: keys || [], at: Date.now() };
  return jwksCache.keys;
}

// ---------- helpers ----------
async function sign(env, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64urlBytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const b64urlText = (s) => new TextDecoder().decode(b64urlBytes(s));

function corsHeaders(req, env) {
  const origin = req.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  return {
    "access-control-allow-origin": allowed.includes(origin) ? origin : allowed[0] || "",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), { status, headers: { ...headers, "content-type": "application/json" } });
