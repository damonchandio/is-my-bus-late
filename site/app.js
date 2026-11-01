import { clock, locate, londonDate, serviceDayStart, verdict } from "./match.js"

const params = new URLSearchParams(location.search)
const REPO = "https://raw.githubusercontent.com/damonchandio/is-my-bus-late"
// per-route timetables: rebuilt daily on the site-data branch; a copy ships with each deploy as a fallback
let DATA = params.get("data") || `${REPO}/site-data`
const STATS = params.get("stats") || `${REPO}/main/data/stats.json` // hourly samples, for the "usually" line
const LIVE = params.get("live") || "/api/live"
const REFRESH_MS = 20_000
const COLOURS = { late: "#c4361f", "on-time": "#1e7f55", early: "#2f62c9", quiet: "#566070" }
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches

const empty = () => ({ type: "FeatureCollection", features: [] })
const $ = (id) => document.getElementById(id)
const q = $("q"), dest = $("dest"), choices = $("choices"), status = $("status"), list = $("buses")
const place = (s) => String(s).replace(/\bInterchang$/, "Interchange").replace(/\bIntc$/, "Interchange")
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

let routes = [], stats = {}, current = null, selected = null, timer = null, routeCache = {}, busFC = empty()

const getJson = async (url) => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.json()
}

// ---------- map ----------
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: [-1.7594, 53.7938], zoom: 9.4, pitch: 0, bearing: 0,
  attributionControl: { compact: true },
})
window.busMap = map // handy in the console
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right")
const mapReady = new Promise((resolve) => map.on("load", resolve))

mapReady.then(() => {
  const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id
  map.addLayer({
    id: "buildings-3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 12.5,
    paint: {
      "fill-extrusion-color": "#d2d6ce",
      "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-opacity": 0.85,
    },
  }, firstSymbol)
  map.addSource("route", { type: "geojson", data: empty() })
  map.addSource("buses", { type: "geojson", data: empty() })
  map.addLayer({ id: "route-line", type: "line", source: "route", filter: ["==", "$type", "LineString"],
    paint: { "line-color": "#18202e", "line-width": 3, "line-opacity": 0.55 }, layout: { "line-join": "round", "line-cap": "round" } })
  map.addLayer({ id: "route-stops", type: "circle", source: "route", filter: ["==", "$type", "Point"], minzoom: 12,
    paint: { "circle-radius": 3, "circle-color": "#f4f5f1", "circle-stroke-color": "#18202e", "circle-stroke-width": 1.5 } })
  map.addLayer({ id: "bus-dots", type: "circle", source: "buses",
    paint: {
      "circle-radius": ["case", ["==", ["get", "sel"], true], 13, ["has", "label"], 10, 5],
      "circle-color": ["coalesce", ["get", "colour"], "#18202e"],
      "circle-stroke-color": "#ffffff", "circle-stroke-width": ["case", ["has", "label"], 2.5, 1.5],
      "circle-pitch-alignment": "viewport",
    } })
  map.addLayer({ id: "bus-labels", type: "symbol", source: "buses", filter: ["has", "label"],
    layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-allow-overlap": true },
    paint: { "text-color": "#ffffff" } })
  map.on("click", "bus-dots", (e) => {
    const p = e.features[0].properties
    if (p.v && current) select(p.v, true)
    else if (p.r) pickRoute(routes.find((r) => r.id === p.r))
  })
  map.on("mouseenter", "bus-dots", () => (map.getCanvas().style.cursor = "pointer"))
  map.on("mouseleave", "bus-dots", () => (map.getCanvas().style.cursor = ""))
  // the one orchestrated moment: drop from a flat overview into 3D Bradford
  map.flyTo({ center: [-1.7535, 53.7915], zoom: 13.6, pitch: 60, bearing: -24, duration: reduceMotion ? 0 : 3200, essential: true })
})

const pt = (lon, lat, props = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props })

// ---------- search ----------
const norm = (s) => s.trim().toUpperCase()

q.addEventListener("input", () => {
  const v = norm(q.value)
  if (!v) return reset()
  const exact = routes.filter((r) => r.route.toUpperCase() === v)
  const starts = routes.filter((r) => r.route.toUpperCase().startsWith(v) && r.route.toUpperCase() !== v).slice(0, 6)
  showChoices([...exact, ...starts])
  if (exact.length > 1) showStatus(`<p class="summary">${exact.length} different buses are numbered ${esc(v)}. Pick the operator shown on your bus or stop.</p>`)
})

$("search").addEventListener("submit", (e) => {
  e.preventDefault()
  const v = norm(q.value)
  const exact = routes.filter((r) => r.route.toUpperCase() === v)
  if (exact.length === 1) pickRoute(exact[0])
  else if (!exact.length && v) showStatus(`<p class="error">There's no West Yorkshire bus called ${esc(v)} in today's timetable. Check the number on the bus or the stop flag.</p>`)
})

document.querySelectorAll(".try").forEach((b) => b.addEventListener("click", () => {
  q.value = b.dataset.q
  q.dispatchEvent(new Event("input"))
  const exact = routes.filter((r) => r.route.toUpperCase() === b.dataset.q)
  if (exact.length === 1) pickRoute(exact[0])
}))

function showChoices(rs) {
  choices.innerHTML = rs.map((r) => `
    <button type="button" class="choice" data-id="${esc(r.id)}" aria-pressed="${current?.id === r.id}">
      <b>${esc(r.route)}</b>${esc(r.operator)}<small>${r.to.length ? "To " + r.to.map((t) => esc(place(t))).join(" or ") : "&nbsp;"}</small>
    </button>`).join("")
  choices.querySelectorAll(".choice").forEach((b) => b.addEventListener("click", () => pickRoute(routes.find((r) => r.id === b.dataset.id))))
}

function reset() {
  current = null; selected = null; clearInterval(timer)
  document.body.classList.remove("has-route")
  choices.innerHTML = ""; list.innerHTML = ""; dest.textContent = "West Yorkshire"
  history.replaceState(null, "", location.pathname + keepParams())
  showStatus(document.querySelector("#status").dataset.intro)
  overview()
}

const keepParams = () => { const p = new URLSearchParams(params); p.delete("r"); const s = p.toString(); return s ? "?" + s : "" }

function showStatus(html) { status.innerHTML = html; bindTry() }
function bindTry() {
  status.querySelectorAll(".try").forEach((b) => b.addEventListener("click", () => {
    q.value = b.dataset.q; q.dispatchEvent(new Event("input"))
    const exact = routes.filter((r) => r.route.toUpperCase() === b.dataset.q)
    if (exact.length === 1) pickRoute(exact[0])
  }))
}

// ---------- a route ----------
async function pickRoute(r) {
  if (!r) return
  current = r; selected = null
  document.body.classList.add("has-route")
  q.value = r.route
  dest.textContent = r.to[0] ? place(r.to[0]) : r.operator
  if (choices.children.length) choices.querySelectorAll(".choice").forEach((b) => b.setAttribute("aria-pressed", b.dataset.id === r.id))
  const p = new URLSearchParams(params); p.set("r", r.id)
  history.replaceState(null, "", "?" + p)
  showStatus(`<p class="summary">Finding ${esc(r.route)} buses…</p>`)
  list.innerHTML = ""
  clearInterval(timer)
  try {
    routeCache[r.id] ??= await getJson(`${DATA}/r/${r.id}.json`)
  } catch {
    return showStatus(`<p class="error">The timetable for the ${esc(r.route)} didn't load. Check your connection and try again.</p>`)
  }
  await refresh(true)
  timer = setInterval(() => refresh(false), REFRESH_MS)
}

async function refresh(fit) {
  const r = current
  if (!r) return
  let live
  try {
    live = await getJson(`${LIVE}?route=${encodeURIComponent(r.id)}`)
  } catch {
    return showStatus(`<p class="error">The live bus feed isn't answering. This page tries again every 20 seconds.</p>`)
  }
  if (r !== current) return
  const tt = routeCache[r.id]
  const buses = live.buses.map((b) => ({ ...b, m: locate(b, tt) }))
    .filter((b) => b.m.status !== "finished")
    .sort((a, b) => order(a) - order(b))
  render(r, tt, buses, live.at)
  draw(tt, buses, fit)
}

const order = (b) => (b.m.status === "running" ? -b.m.delay : b.m.status === "waiting" ? 1e6 + b.m.departs : 2e9)

function render(r, tt, buses, at) {
  const running = buses.filter((b) => b.m.status === "running")
  const late = running.filter((b) => verdict(b.m.delay) === "late").length
  const s = stats.routes?.[`${r.route}|${r.operator}`]
  const usual = s && s[0] >= 10
    ? `<p class="usual">Usually: ${s[1]}% of stops reached on time, ${s[2]}% over 5 minutes late, from ${s[0]} measured trips.</p>` : ""
  let summary
  const n = (k) => `${k} ${k === 1 ? "bus" : "buses"}`
  if (!buses.length) summary = `No buses on the ${esc(r.route)} are reporting a position right now.`
  else if (!running.length) summary = `${n(buses.length)} on the ${esc(r.route)}, none on the road yet.`
  else summary = `${n(running.length)} on the ${esc(r.route)} right now. ${late ? `${late} ${late === 1 ? "is" : "are"} over 5 minutes late.` : "None is more than 5 minutes late."}`
  showStatus(`<p class="summary">${summary}</p>${usual}${buses.length ? "" : nextDepartures(tt)}
    <p class="fresh">${esc(r.operator)}. Positions from ${clock(at)}, updating every 20 seconds.</p>`)
  list.innerHTML = buses.map(row).join("")
  list.querySelectorAll(".bus > button").forEach((b) => b.addEventListener("click", () => select(b.parentElement.dataset.v, true)))
}

function nextDepartures(tt) {
  const now = Date.now() / 1000, today = londonDate(now), base = serviceDayStart(today)
  const k = Math.round((base - serviceDayStart(tt.d0)) / 86400)
  const due = Object.values(tt.trips).filter((t) => (t[4] >> k) & 1 && base + t[1] > now)
    .sort((a, b) => a[1] - b[1]).slice(0, 4)
  if (!due.length) return `<p>No more journeys are timetabled today.</p>`
  return `<p>Next journeys start at ${due.map((t) => `${clock(base + t[1])} to ${esc(place(tt.heads[t[0]] || "the end of the route"))}`).join(", ")}.</p>`
}

function row(b) {
  const m = b.m
  const cls = m.status === "running" ? verdict(m.delay) : "quiet"
  let mins, where, extra = ""
  if (m.status === "running") {
    const d = Math.round(m.delay / 60)
    mins = cls === "on-time" ? (d > 0 ? `${d}<small>min late<span class="sr-only">, counts as on time</span></small>` : `0<small>On time</small>`)
      : cls === "late" ? `${d}<small>min late</small>` : `${-d}<small>min early</small>`
    where = `<strong>To ${esc(place(m.head || "end of route"))}</strong><span>Near ${esc(m.near)}</span>`
    extra = `<ol class="next">${m.next.map((n) => `<li><span class="n">${esc(n.name)}</span>${
      Math.abs(n.expected - n.due) >= 60 ? `<s>${clock(n.due)}</s><b>${clock(n.expected)}</b>` : `<span></span><b>${clock(n.due)}</b>`}</li>`).join("")}</ol>`
    if (m.relabelledTo) extra += `<p class="note">This bus is broadcasting an earlier journey; it's running the ${clock(m.startedAt)} trip.</p>`
  } else if (m.status === "waiting") {
    mins = `${clock(m.departs)}<small>leaves</small>`
    where = `<strong>To ${esc(place(m.head || "end of route"))}</strong><span>Waiting at ${esc(m.pts[0].stop[0])}</span>`
  } else {
    mins = `?<small>${m.status === "offroute" ? "off route" : "no timetable"}</small>`
    where = `<strong>Position only</strong><span>${m.status === "offroute" ? "This bus is away from its timetabled route, perhaps on a diversion." : "This bus isn't reporting a timetabled journey."}</span>`
  }
  return `<li class="bus ${cls}" data-v="${esc(b.v)}" aria-current="${b.v === selected}">
    <button type="button"><span class="mins">${mins}</span><span class="where">${where}${extra}</span></button></li>`
}

function select(v, fly) {
  selected = selected === v ? null : v
  list.querySelectorAll(".bus").forEach((li) => li.setAttribute("aria-current", li.dataset.v === selected))
  const src = map.getSource("buses")
  if (src) {
    busFC.features.forEach((f) => (f.properties.sel = f.properties.v === selected))
    src.setData(busFC)
    const f = busFC.features.find((f) => f.properties.v === selected)
    if (f && fly) map.flyTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), 14.5), pitch: 60, duration: reduceMotion ? 0 : 1200 })
  }
  list.querySelector(`[data-v="${CSS.escape(v)}"]`)?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" })
}

async function draw(tt, buses, fit) {
  await mapReady
  const seen = new Set(), lines = [], stopsOn = new Map()
  for (const b of buses) {
    const t = b.m.trip
    if (!t || seen.has(t)) continue
    seen.add(t)
    lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: t[2].map((i) => [tt.stops[i][2], tt.stops[i][1]]) }, properties: {} })
    t[2].forEach((i) => stopsOn.set(i, tt.stops[i]))
  }
  if (!lines.length) { // nothing running: show the route's most common journey
    const t = Object.values(tt.trips).sort((a, b) => b[2].length - a[2].length)[0]
    if (t) {
      lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: t[2].map((i) => [tt.stops[i][2], tt.stops[i][1]]) }, properties: {} })
      t[2].forEach((i) => stopsOn.set(i, tt.stops[i]))
    }
  }
  map.getSource("route").setData({ type: "FeatureCollection", features: [...lines, ...[...stopsOn.values()].map((s) => pt(s[2], s[1]))] })
  busFC = { type: "FeatureCollection", features: buses.map((b) => {
    const cls = b.m.status === "running" ? verdict(b.m.delay) : "quiet"
    const d = b.m.status === "running" ? Math.round(b.m.delay / 60) : null
    return pt(b.lo, b.la, { v: b.v, colour: COLOURS[cls], sel: b.v === selected,
      label: d === null ? "·" : cls === "on-time" ? "✓" : d > 0 ? `+${d}` : `${d}` })
  }) }
  map.getSource("buses").setData(busFC)
  if (fit) {
    const pts = [...buses.map((b) => [b.lo, b.la]), ...[...stopsOn.values()].map((s) => [s[2], s[1]])]
    if (pts.length) {
      const bounds = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]))
      map.fitBounds(bounds, { padding: 60, pitch: 50, bearing: -12, maxZoom: 14.5, duration: reduceMotion ? 0 : 1400 })
    }
  }
}

// ---------- overview: every bus in West Yorkshire ----------
async function overview() {
  await mapReady
  map.getSource("route").setData(empty())
  try {
    const live = await getJson(LIVE)
    if (current) return
    map.getSource("buses").setData({ type: "FeatureCollection", features: live.buses.map((b) => pt(b.lo, b.la, { r: b.r })) })
    const intro = status.querySelector(".hint")
    if (intro && !status.querySelector(".count")) {
      intro.insertAdjacentHTML("beforebegin", `<p class="count">${live.buses.length} buses are reporting their position across West Yorkshire right now. Tap one on the map, or type a number.</p>`)
    }
  } catch { /* the map still works without dots */ }
}

// ---------- start ----------
status.dataset.intro = status.innerHTML
bindTry()
Promise.all([
  getJson(`${DATA}/routes.json`).catch(() => getJson(`${(DATA = "site-data")}/routes.json`)).then((r) => (routes = r)),
  getJson(STATS).then((s) => (stats = s)).catch(() => {}),
]).then(() => {
  const r = routes.find((x) => x.id === params.get("r"))
  if (r) { q.value = r.route; pickRoute(r) } else overview()
}).catch(() => showStatus(`<p class="error">The route list didn't load. Check your connection and reload the page.</p>`))
