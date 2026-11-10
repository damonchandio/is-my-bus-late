// Live bus positions for the site. The DfT feed (all of England, ~1.5 MB zip) has no CORS headers, so the browser
// can't read it directly; this function fetches it, keeps West Yorkshire, and returns compact JSON.
//   /api/live            every bus in the box (lat, lon, route id) for the overview map
//   /api/live?route=ID   buses on one route, with trip ids for timetable matching
// Web APIs only, so the same file runs on Netlify Functions and on Supabase Edge Functions (supabase/functions/bus-live).

const FEED = "https://data.bus-data.dft.gov.uk/avl/download/gtfsrt"
const BOX = [53.52, -2.18, 53.96, -1.2] // same West Yorkshire box as pipeline/fetch.py
const FRESH_S = 300

let cache = { at: 0, buses: [] }

export default async (req) => {
  const route = new URL(req.url).searchParams.get("route")
  try {
    if (Date.now() - cache.at > 20_000) cache = { at: Date.now(), buses: decode(await unzip(await download())) }
  } catch (e) {
    if (!cache.buses.length) return Response.json({ error: "The live bus feed is not responding. Try again in a minute." }, { status: 502 })
  }
  const buses = route
    ? cache.buses.filter((b) => b.r === route)
    : cache.buses.map(({ r, la, lo, b, v }) => ({ r, la, lo, b, v }))
  return Response.json(
    { at: Math.round(cache.at / 1000), buses },
    { headers: { "Netlify-CDN-Cache-Control": "public, s-maxage=20, stale-while-revalidate=20", "Cache-Control": "no-store" } },
  )
}

export const config = { path: "/api/live" }

// The DfT endpoint sometimes hangs for 30 s and then answers the next request in about a second,
// so give each attempt 5 s and try three times, inside the function's own time limit.
async function download(tries = 3) {
  try {
    const r = await fetch(FEED, {
      headers: { "User-Agent": "is-my-bus-late (github.com/damonchandio/is-my-bus-late)" },
      signal: AbortSignal.timeout(5_000),
    })
    if (!r.ok) throw new Error(`feed ${r.status}`)
    return new Uint8Array(await r.arrayBuffer())
  } catch (e) {
    if (tries > 1) return download(tries - 1)
    throw e
  }
}

// The zip holds one file, gtfsrt.bin. Read its local header and inflate the data that follows.
export async function unzip(z) {
  const v = new DataView(z.buffer, z.byteOffset)
  if (v.getUint32(0, true) !== 0x04034b50) throw new Error("not a zip")
  const method = v.getUint16(8, true)
  let size = v.getUint32(18, true)
  const start = 30 + v.getUint16(26, true) + v.getUint16(28, true)
  // size is 0 when the zip uses a data descriptor: read it from the central directory at the end of the file,
  // because DecompressionStream rejects anything after the deflate stream
  if (!size) {
    let e = z.length - 22
    while (e > 0 && v.getUint32(e, true) !== 0x06054b50) e--
    size = v.getUint32(v.getUint32(e + 16, true) + 20, true)
  }
  const data = z.subarray(start, start + size)
  if (method === 0) return data
  const inflated = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
  return new Uint8Array(await new Response(inflated).arrayBuffer())
}

// Minimal protobuf reader for the GTFS-RT fields we need (field numbers from gtfs-realtime.proto).
function* fields(b, s = 0, e = b.length) {
  let i = s
  const varint = () => {
    let n = 0, m = 1, x
    do { x = b[i++]; n += (x & 0x7f) * m; m *= 128 } while (x & 0x80)
    return n
  }
  while (i < e) {
    const key = varint(), f = Math.floor(key / 8), w = key & 7
    if (w === 0) yield [f, varint()]
    else if (w === 1) { yield [f, null]; i += 8 }
    else if (w === 2) { const n = varint(); yield [f, [i, i + n]]; i += n }
    else if (w === 5) { yield [f, new DataView(b.buffer, b.byteOffset + i, 4).getFloat32(0, true)]; i += 4 }
    else throw new Error(`wire type ${w}`)
  }
}
const str = (b, [s, e]) => new TextDecoder().decode(b.subarray(s, e))

export function decode(b, now) {
  const out = []
  let headerTs = 0
  for (const [f, v] of fields(b)) {
    if (f === 1) for (const [hf, hv] of fields(b, ...v)) if (hf === 3) headerTs = hv
    if (f !== 2) continue
    for (const [ef, ev] of fields(b, ...v)) {
      if (ef !== 4) continue // FeedEntity.vehicle
      const bus = {}
      for (const [vf, vv] of fields(b, ...ev)) {
        if (vf === 1) for (const [tf, tv] of fields(b, ...vv)) {
          if (tf === 1) bus.t = str(b, tv); else if (tf === 3) bus.d = str(b, tv); else if (tf === 5) bus.r = str(b, tv)
        }
        else if (vf === 2) for (const [pf, pv] of fields(b, ...vv)) {
          if (pf === 1) bus.la = +pv.toFixed(5); else if (pf === 2) bus.lo = +pv.toFixed(5); else if (pf === 3) bus.b = Math.round(pv)
        }
        else if (vf === 5) bus.ts = vv
        else if (vf === 8) for (const [df, dv] of fields(b, ...vv)) if (df === 1) bus.v = str(b, dv)
      }
      out.push(bus)
    }
  }
  const t = now ?? (headerTs || Math.floor(Date.now() / 1000))
  return out.filter((x) => x.t && x.r && x.ts && t - x.ts <= FRESH_S &&
    x.la >= BOX[0] && x.la <= BOX[2] && x.lo >= BOX[1] && x.lo <= BOX[3])
}
