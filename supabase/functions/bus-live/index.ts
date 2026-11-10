// The live-feed relay as a Supabase Edge Function. Deployed with a copy of netlify/functions/live.mjs beside it.
// Public, read-only open data, so no JWT is required and any origin may read it.
import live from "./live.mjs"

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" } })
  }
  const res = await live(req)
  const headers = new Headers(res.headers)
  headers.set("Access-Control-Allow-Origin", "*")
  return new Response(res.body, { status: res.status, headers })
})
