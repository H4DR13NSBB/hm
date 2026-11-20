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
//
// Settings (see wrangler.toml):
//   SUPABASE_URL      var     https://<ref>.supabase.co
//   ALLOWED_ORIGINS   var     comma-separated site origins allowed to call the API
//   MEMBERS           secret  comma-separated Supabase user ids of the two of you
//   SIGNING_KEY       secret  any long random string (signs the view links)
//   JWT_SECRET        secret  optional: only for projects still on the legacy HS256 JWT secret

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp"];
const LINK_TTL = 60 * 60; // seconds
const PATH_RE = /^[0-9a-f-]{36}\/[0-9a-zA-Z-]{8,64}\.(jpg|png|webp)$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (req.method === "GET" && url.pathname.startsWith("/p/")) return await view(url, env);

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

      if (url.pathname.startsWith("/o/")) {
        const path = decodeURIComponent(url.pathname.slice(3));
        if (!PATH_RE.test(path)) return json({ error: "Bad path" }, 400, cors);
        if (path.split("/")[0] !== user) return json({ error: "Not your photo" }, 403, cors);

        if (req.method === "PUT") {
          const type = (req.headers.get("content-type") || "").split(";")[0];
          if (!TYPES.includes(type)) return json({ error: "Not an image" }, 415, cors);
          const size = Number(req.headers.get("content-length") || 0);
          if (size > MAX_BYTES) return json({ error: "Photo too large" }, 413, cors);
          const body = await req.arrayBuffer();
          if (body.byteLength > MAX_BYTES) return json({ error: "Photo too large" }, 413, cors);
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
};

// ---------- viewing ----------
async function view(url, env) {
  const path = decodeURIComponent(url.pathname.slice(3));
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") || "";
  const now = Math.floor(Date.now() / 1000);
  if (!PATH_RE.test(path) || !(exp > now) || !timingSafeEqual(sig, await sign(env, `${path}:${exp}`))) {
    return new Response("Link expired", { status: 403 });
  }
  const obj = await env.PHOTOS.get(path);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "image/jpeg",
      "cache-control": `private, max-age=${exp - now}`,
      "etag": obj.httpEtag,
    },
  });
}

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
