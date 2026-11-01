// node --test tests/   (the same four buses as test_pipeline.py, encoded by the official protobuf library)
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { decode } from "../netlify/functions/live.mjs"

test("decoder keeps fresh buses with a trip inside West Yorkshire", () => {
  const buses = decode(new Uint8Array(readFileSync(new URL("fixtures/feed.bin", import.meta.url))), 1_000_000)
  assert.deepEqual(buses.map((b) => b.t), ["VJ1"])
  assert.equal(buses[0].r, "r1")
  assert.equal(buses[0].v, "bus0")
  assert.ok(Math.abs(buses[0].la - 53.79) < 1e-4 && Math.abs(buses[0].lo + 1.75) < 1e-4)
})
