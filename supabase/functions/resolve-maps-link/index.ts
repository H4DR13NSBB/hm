// Supabase Edge Function: resolve-maps-link
//
// Google Maps "Share" gives short links like https://maps.app.goo.gl/AbC123.
// The full URL they redirect to contains the place name and coordinates, but a
// browser can't follow that redirect itself (CORS). This function does it.
//
// Only Google hosts are allowed, so it can't be used to fetch arbitrary sites.
// Deploy: Supabase Dashboard > Edge Functions > Deploy a new function >
//         name it "resolve-maps-link" and paste this file. (Or: supabase functions deploy resolve-maps-link)

const ALLOWED_HOST = /^(maps\.app\.goo\.gl|goo\.gl|(www\.|maps\.)?google\.[a-z.]{2,6}|consent\.google\.[a-z.]{2,6})$/i;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const { url } = await req.json();
    let current = new URL(String(url));

    for (let hop = 0; hop < 6; hop++) {
      if (current.protocol !== "https:" || !ALLOWED_HOST.test(current.hostname)) {
        return json({ error: "Only Google Maps links are supported" }, 400);
      }
      // EU cookie-consent interstitial: the real destination is in ?continue=
      const next = current.searchParams.get("continue");
      if (/^consent\./i.test(current.hostname) && next) {
        current = new URL(next);
        continue;
      }
      const res = await fetch(current, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current);
        continue;
      }
      break;
    }
    return json({ url: current.toString() });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
