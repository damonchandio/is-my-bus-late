// How late is a bus right now? Place its live position on its timetabled trip and compare with the clock.
// Same rules as models/marts/fct_observations.sql, plus interpolation between stops so the answer works mid-road.

const LONDON = "Europe/London"

// GTFS times count from "noon minus 12 hours" on the service day, in London time (right across clock changes).
export function serviceDayStart(yyyymmdd) {
  const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6), d = +yyyymmdd.slice(6, 8)
  const noonUtc = Date.UTC(y, m - 1, d, 12)
  const off = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, timeZoneName: "shortOffset" })
    .formatToParts(new Date(noonUtc)).find((p) => p.type === "timeZoneName").value // "GMT" or "GMT+1"
  const hours = off === "GMT" ? 0 : +off.slice(3)
  return noonUtc / 1000 - hours * 3600 - 12 * 3600
}

export const londonDate = (epochS) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: LONDON }).format(new Date(epochS * 1000)).replaceAll("-", "")

export const clock = (epochS) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, hour: "2-digit", minute: "2-digit" }).format(new Date(epochS * 1000))

const daysBetween = (a, b) => Math.round((serviceDayStart(b) - serviceDayStart(a)) / 86400)
const runsOn = (trip, d0, day) => { const k = daysBetween(d0, day); return k >= 0 && k < 31 && (trip[4] >> k) & 1 }

function timesOf(route, trip, base) {
  return trip[3].map((off, k) => ({ stop: route.stops[trip[2][k]], at: base + trip[1] + off }))
}

const NEAR_M = 100, OFF_ROUTE_M = 250, AMBIGUOUS_S = 900, ALT_WINDOW_S = 300

// bus: {t: trip id, d: service date or "", la, lo, ts}; route: a site-data/r/<id>.json file
export function locate(bus, route) {
  const trip = route.trips[bus.t]
  if (!trip) return { status: "unmatched" }
  const day = bus.d || londonDate(bus.ts)
  const pts = timesOf(route, trip, serviceDayStart(day))
  // flat-earth metres around the bus: plenty accurate over a few hundred metres
  const kx = 111320 * Math.cos((bus.la * Math.PI) / 180), ky = 110540
  const xy = (s) => [(s[2] - bus.lo) * kx, (s[1] - bus.la) * ky]

  const cands = []
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = xy(pts[k].stop), [bx, by] = xy(pts[k + 1].stop)
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy
    const f = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0
    const metres = Math.hypot(ax + f * dx, ay + f * dy)
    cands.push({ k, f, metres, due: pts[k].at + f * (pts[k + 1].at - pts[k].at) })
  }
  if (!cands.length) return { status: "unmatched" }
  const nearest = Math.min(...cands.map((c) => c.metres))
  if (nearest > OFF_ROUTE_M) return { status: "offroute", trip, pts }
  // loops and circulars pass the same street twice: of the near-enough places on the route, take the one due nearest now
  const best = cands.filter((c) => c.metres <= Math.max(nearest + 40, NEAR_M))
    .reduce((a, c) => (Math.abs(bus.ts - c.due) < Math.abs(bus.ts - a.due) ? c : a))
  let delay = bus.ts - best.due
  let { k } = best

  const atStart = k === 0 && best.f < 0.05, atEnd = k === pts.length - 2 && best.f > 0.95
  if (atStart && delay < 0) return { status: "waiting", trip, pts, departs: pts[0].at, head: route.heads[trip[0]], heading: headingOf(pts, 1), nextIdx: 0, delay: 0 }
  if (atEnd) return { status: "finished", trip, pts, head: route.heads[trip[0]] }

  // very late, but another trip in the same direction is due here now: the bus is almost certainly running that one
  let relabelled = null
  if (delay > AMBIGUOUS_S && route.d0) {
    const here = trip[2][best.f < 0.5 ? k : k + 1]
    for (const [id, other] of Object.entries(route.trips)) {
      if (id === bus.t || other[5] !== trip[5] || !runsOn(other, route.d0, day)) continue
      const j = other[2].indexOf(here)
      if (j < 0) continue
      const due = serviceDayStart(day) + other[1] + other[3][j]
      if (Math.abs(bus.ts - due) <= ALT_WINDOW_S && (!relabelled || Math.abs(bus.ts - due) < Math.abs(relabelled.d))) {
        relabelled = { id, d: bus.ts - due, j }
      }
    }
    if (relabelled) {
      const other = route.trips[relabelled.id]
      return finish(timesOf(route, other, serviceDayStart(day)), relabelled.j, relabelled.d, other, route, bus, relabelled.id)
    }
  }
  return finish(pts, k + 1, delay, trip, route, bus, null)
}

function finish(pts, nextIdx, delay, trip, route, bus, relabelledTo) {
  const now = bus.ts
  const next = pts.slice(nextIdx, nextIdx + 4).map((p) => ({ name: p.stop[0], due: p.at, expected: Math.max(now, p.at + delay) }))
  return {
    status: "running", delay, trip, pts, nextIdx, next, relabelledTo,
    head: route.heads[trip[0]], startedAt: pts[0].at,
    near: pts[Math.max(0, nextIdx - 1)].stop[0], heading: headingOf(pts, nextIdx),
  }
}

// Compass heading (degrees clockwise from north) of the stretch between stop i-1 and stop i.
function headingOf(pts, i) {
  const a = pts[Math.max(0, Math.min(i, pts.length - 1) - 1)].stop, b = pts[Math.max(1, Math.min(i, pts.length - 1))].stop
  const dx = (b[2] - a[2]) * Math.cos((a[1] * Math.PI) / 180), dy = b[1] - a[1]
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
}

// When will this bus reach the named stop? null if it has passed it, doesn't call there, or terminates there.
export function etaAt(m, stopName, now) {
  if (!m.pts || (m.status !== "running" && m.status !== "waiting")) return null
  for (let i = m.nextIdx; i < m.pts.length - 1; i++) { // not the last stop: the bus terminates there
    if (m.pts[i].stop[0] === stopName) {
      const delay = m.status === "running" ? m.delay : 0
      return { due: m.pts[i].at, expected: Math.max(now, m.pts[i].at + delay), delay }
    }
  }
  return null
}

// On time = 1 minute early to 5 minutes late at a stop, the DfT punctuality window used across this project.
export const verdict = (delay) => (delay > 300 ? "late" : delay < -60 ? "early" : "on-time")
