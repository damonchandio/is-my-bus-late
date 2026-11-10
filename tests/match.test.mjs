import assert from "node:assert/strict"
import { test } from "node:test"
import { locate, serviceDayStart } from "../site/match.js"

// A circular: Interchange -> Hill -> Interchange, 20 min each way, from 10:00 on 1 Nov 2026 (GMT).
const DAY = "20261101", base = serviceDayStart(DAY)
const stops = [["Interchange", 53.79, -1.75], ["Hill", 53.80, -1.75]]
const loop = (start) => [0, start, [0, 1, 0], [0, 1200, 2400], 1, 0]
const route = { d0: DAY, stops, heads: ["Circular"], trips: { A: loop(36000), B: loop(36000 + 3600) } }
const at = (hhmm) => base + (+hhmm.slice(0, 2)) * 3600 + (+hhmm.slice(2)) * 60

test("service day starts at local midnight", () => {
  assert.equal(new Date(serviceDayStart("20261101") * 1000).toISOString(), "2026-11-01T00:00:00.000Z")
  assert.equal(new Date(serviceDayStart("20260701") * 1000).toISOString(), "2026-06-30T23:00:00.000Z") // BST
})

test("a bus back at the Interchange is matched to its second visit, not its first", () => {
  // half way back down towards the Interchange at 10:33: due there 10:40, so it is on the return leg, ~3 min early
  const r = locate({ t: "A", d: DAY, la: 53.7915, lo: -1.75, ts: at("1033") }, route)
  assert.equal(r.status, "running")
  assert.ok(Math.abs(r.delay) < 300, `delay ${r.delay}`)
})

test("before departure at the first stop it is waiting, not early", () => {
  const r = locate({ t: "B", d: DAY, la: 53.79, lo: -1.75, ts: at("1055") }, route)
  assert.equal(r.status, "waiting")
})

test("an hour late on a stale trip id is read as the trip that is due now", () => {
  // reports trip A (Hill due 10:20) but is at Hill at 11:22: trip B is due there at 11:20
  const r = locate({ t: "A", d: DAY, la: 53.80, lo: -1.75, ts: at("1122") }, route)
  assert.equal(r.relabelledTo, "B")
  assert.ok(Math.abs(r.delay - 120) < 60, `delay ${r.delay}`)
})

test("heading and arrival time at a stop further along", async () => {
  const { etaAt } = await import("../site/match.js")
  // trip A outbound towards Hill (due 10:20); bus a third of the way there at 10:07, i.e. on time
  const r = locate({ t: "A", d: DAY, la: 53.7933, lo: -1.75, ts: at("1007") }, route)
  assert.ok(r.heading < 1 || r.heading > 359, `heading ${r.heading}`) // due north
  const eta = etaAt(r, "Hill", at("1007"))
  assert.equal(eta.due, at("1020"))
  assert.ok(Math.abs(eta.expected - at("1020")) < 90)
})

test("after midnight, a 24:10 journey stamped with the new date is on time, not a day early", () => {
  // trip N leaves at 24:10 on the 1 Nov service day; at 00:17 on 2 Nov the feed says start_date 2 Nov
  const night = { ...route, trips: { N: loop(86400 + 600) } }
  const r = locate({ t: "N", d: "20261102", la: 53.7933, lo: -1.75, ts: serviceDayStart("20261102") + 17 * 60 }, night)
  assert.equal(r.status, "running")
  assert.ok(Math.abs(r.delay) < 300, `delay ${r.delay}`)
})
