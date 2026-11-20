// Find these in Supabase: Project Settings > API (or "Connect" > App frameworks).
// The anon/publishable key is safe to ship in a public site — RLS policies protect the data.
// NEVER put the service_role / secret key here.
export const SUPABASE_URL = "https://ygpxcijdnoexqtzlhohn.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_cMzpsTJpRMR73wQfWGSv7Q_vSTW_kUP";

// Photo storage on Cloudflare R2: the URL of the duo-photos Worker (see cloudflare/).
// Leave empty to keep photos in Supabase Storage instead.
export const PHOTOS_URL = "https://duo-photos.h4dr13nsbb.workers.dev";
