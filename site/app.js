import { clock, etaAt, locate, londonDate, serviceDayStart, verdict } from "./match.js"
import { COLOURS, LOOKS, animateBuses, createMap, empty, point, rescale, tag } from "./map3d.js"
import { busSvg, opColour, toast } from "./ui.js"

const params = new URLSearchParams(location.search)
const REPO = "https://raw.githubusercontent.com/damonchandio/is-my-bus-late"
// per-route timetables: rebuilt daily on the site-data branch; a copy ships with each deploy as a fallback
let DATA = params.get("data") || `${REPO}/site-data`
const STATS = params.get("stats") || `${REPO}/main/data/stats.json` // hourly samples, for the "usually" line
const LIVE = params.get("live") || "/api/live"
const REFRESH_MS = 20_000, GLIDE_MS = 1600, NEAR_M = 700
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches

const $ = (id) => document.getElementById(id)
const q = $("q"), dest = $("dest"), clearBtn = $("clear"), sheet = $("sheet"), choices = $("choices")
const status = $("status"), mystop = $("mystop"), list = $("buses")
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
// GTFS headsigns are cut at 19 characters; tidy the commonest cut for display
const place = (s) => String(s).replace(/\bInterchang$/, "Interchange").replace(/\bIntc$/, "Interchange")
const store = { get: (k) => { try { return JSON.parse(localStorage.getItem(k)) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } } }

// ---------- options: map style and 3D or flat, remembered on this device ----------
const hour = new Date().getHours()
const lookKey = [params.get("look"), store.get("look")].find((k) => LOOKS[k]) || (hour < 7 || hour >= 17 ? "night" : "street")
const look = LOOKS[lookKey]
document.body.classList.toggle("dark", !!look.dark)
document.body.classList.toggle("tilt-shift", !!look.tiltShift)
let flat = !!store.get("flat")
const tilt = (pitch) => (flat ? 0 : pitch)
// changing style reloads the page (the route is in the address); skip the fly-in the second time
const skipIntro = sessionStorage.getItem("skipIntro") === "1"
sessionStorage.removeItem("skipIntro")
const startClose = params.has("r") || skipIntro

let routes = [], byId = new Map(), stats = {}, current = null, selected = null, timer = null, dir = null
let routeCache = {}, shown = [], tags = new Map(), lastLive = null, you = null

const getJson = async (url) => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.json()
}

// ---------- the 3D map ----------
const { map, ready } = createMap("map", { reduceMotion, startClose, look })
ready.then(() => {
  if (flat) map.jumpTo({ pitch: 0, bearing: 0 })
  if (!startClose) {
    // the one orchestrated moment: from the globe down into the Bradford valley
    const wide = innerWidth >= 960
    map.flyTo({ center: [-1.7505, 53.7915], zoom: wide ? 15.1 : 14.6, pitch: tilt(wide ? 72 : 62), bearing: flat ? 0 : -32,
      padding: openArea(), duration: reduceMotion ? 0 : 7000, curve: 1.6, essential: true })
  }
  // the globe is for the arrival; once down at street level a flat map is cheaper and can draw the horizon haze
  map.once("moveend", () => map.setProjection({ type: "mercator" }))
  map.on("zoomend", () => rescale(map, shown))
  map.on("click", "buses-3d", (e) => {
    const p = e.features[0].properties
    if (current && p.id) select(p.id, true)
    else if (p.r && byId.has(p.r)) pickRoute(byId.get(p.r))
  })
  map.on("mouseenter", "buses-3d", () => (map.getCanvas().style.cursor = "pointer"))
  map.on("mouseleave", "buses-3d", () => (map.getCanvas().style.cursor = ""))
})

function placeBuses(next, withTags) {
  animateBuses(map, shown, next, GLIDE_MS, reduceMotion)
  // floating mini-blinds follow their buses
  const keep = new Set()
  if (withTags) for (const b of next) {
    keep.add(b.id)
    let t = tags.get(b.id)
    if (!t) {
      t = tag(map, "", b.cls).setLngLat([b.lon, b.lat]).addTo(map)
      t.getElement().addEventListener("click", (e) => { e.stopPropagation(); select(b.id, true) })
      tags.set(b.id, t)
    }
    const el = t.getElement()
    el.classList.remove("late", "on-time", "early", "quiet") // keep the map's own marker classes
    el.classList.add(b.cls)
    el.classList.toggle("sel", b.id === selected)
    el.innerHTML = `<i></i>${esc(b.label)}`
    el.setAttribute("aria-label", b.aria)
    glideTag(t, [b.lon, b.lat])
  }
  for (const [id, t] of tags) if (!keep.has(id)) { t.remove(); tags.delete(id) }
  shown = next
}

function glideTag(t, to) {
  const from = t.getLngLat(), start = performance.now()
  const step = (now) => {
    const k = reduceMotion ? 1 : Math.min(1, (now - start) / GLIDE_MS), e = k * (2 - k)
    t.setLngLat([from.lng + (to[0] - from.lng) * e, from.lat + (to[1] - from.lat) * e])
    if (k < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

// ---------- sheet (phones) ----------
$("grip").addEventListener("click", () => {
  const open = sheet.classList.toggle("open")
  $("grip").setAttribute("aria-expanded", open)
})

// ---------- search ----------
const norm = (s) => s.trim().toUpperCase()
const exactly = (v) => routes.filter((r) => r.route.toUpperCase() === v)

q.addEventListener("input", () => {
  const v = norm(q.value)
  clearBtn.hidden = !v
  if (!v) return home()
  const exact = exactly(v)
  const starts = routes.filter((r) => r.route.toUpperCase().startsWith(v) && r.route.toUpperCase() !== v).slice(0, 6)
  showChoices([...exact, ...starts])
  if (exact.length === 1 && v.length >= 2 && !starts.length) pickRoute(exact[0])
  else if (exact.length > 1) say(`<p class="summary">${exact.length} different buses are numbered ${esc(v)}. Pick the operator shown on your bus or stop.</p>`)
})

$("search").addEventListener("submit", (e) => {
  e.preventDefault()
  const v = norm(q.value), exact = exactly(v)
  if (exact.length === 1) pickRoute(exact[0])
  else if (!exact.length && v) say(`<p class="error">There's no West Yorkshire bus called ${esc(v)} in today's timetable. Check the number on the bus or the stop flag.</p>`)
  q.blur()
})

clearBtn.addEventListener("click", () => { q.value = ""; clearBtn.hidden = true; home(); q.focus() })

function choose(v) {
  q.value = v; clearBtn.hidden = false
  const exact = exactly(norm(v))
  showChoices(exact)
  if (exact.length === 1) pickRoute(exact[0])
  else say(`<p class="summary">${exact.length} different buses are numbered ${esc(v)}. Pick the operator shown on your bus or stop.</p>`)
}

function showChoices(rs) {
  choices.innerHTML = rs.map((r) => `
    <button type="button" class="choice" data-id="${esc(r.id)}" aria-pressed="${current?.id === r.id}">
      ${busSvg(opColour(r.operator), 44)}<span><b>${esc(r.route)}</b>${esc(r.operator)}<small>${r.to.length ? "To " + r.to.map((t) => esc(place(t))).join(" or ") : "&nbsp;"}</small></span>
    </button>`).join("")
  choices.querySelectorAll(".choice").forEach((b) => b.addEventListener("click", () => pickRoute(byId.get(b.dataset.id))))
}

const say = (html) => { status.innerHTML = html }

// ---------- home: every bus in West Yorkshire ----------
function home() {
  current = null; selected = null; dir = null; clearInterval(timer)
  document.body.classList.remove("has-route")
  $("fav").hidden = $("share").hidden = true
  choices.innerHTML = ""; list.innerHTML = ""; $("dirs").innerHTML = ""; mystop.hidden = true; dest.textContent = "West Yorkshire"
  history.replaceState(null, "", location.pathname + keepParams())
  status.replaceChildren($("intro").content.cloneNode(true))
  status.querySelectorAll(".try").forEach((b) => b.addEventListener("click", () => choose(b.dataset.q)))
  $("near").addEventListener("click", nearMe)
  const recent = (store.get("recent") || []).map((id) => byId.get(id)).filter(Boolean)
  if (recent.length) $("recent").innerHTML = `<p>Your recent buses</p>` + recent.map((r) =>
    `<button type="button" class="chip-r" data-id="${esc(r.id)}" title="${esc(r.operator)}">${esc(r.route)}</button>`).join("")
  const favs = (store.get("favs") || []).map((id) => byId.get(id)).filter(Boolean)
  if (favs.length) $("favs").innerHTML = `<p>Your saved buses</p>` + favs.map((r) =>
    `<button type="button" class="chip-r saved" data-id="${esc(r.id)}" title="${esc(r.operator)}">★ ${esc(r.route)}</button>`).join("")
  status.querySelectorAll(".chip-r").forEach((b) => b.addEventListener("click", () => pickRoute(byId.get(b.dataset.id))))
  league("late")
  ready.then(() => { map.getSource("route").setData(empty()); map.getSource("stops").setData(empty()) })
  overview()
  timer = setInterval(overview, REFRESH_MS * 2)
}

async function overview() {
  try {
    const live = await getJson(LIVE)
    if (current) return
    lastLive = live
    const c = $("count")
    if (c) c.textContent = `${live.buses.length} buses are on the road in West Yorkshire right now. Tap one on the map to see its route.`
    await ready
    placeBuses(live.buses.map((b, i) => ({ id: b.v || `o${i}`, routeId: b.r, lon: b.lo, lat: b.la, heading: b.b >= 0 ? b.b : 0,
      colour: opColour(byId.get(b.r)?.operator) })), false)
  } catch { /* the map still works without buses */ }
}

const keepParams = () => { const p = new URLSearchParams(params); p.delete("r"); const s = p.toString(); return s ? "?" + s : "" }

// ---------- league table: which routes run late, from the hourly samples ----------
function league(kind) {
  const el = $("league")
  if (!el) return
  const rows = Object.entries(stats.routes || {}).map(([k, s]) => {
    const [route, operator] = k.split("|")
    return { r: routes.find((x) => x.route === route && x.operator === operator), n: s[0], on: s[1], late: s[2] }
  }).filter((x) => x.r && x.n >= 30).sort(kind === "late" ? (a, b) => b.late - a.late : (a, b) => b.on - a.on).slice(0, 5)
  if (!rows.length) { el.innerHTML = ""; return }
  el.innerHTML = `<h2>League table</h2>
    <div class="seg" role="group" aria-label="Which end of the table">
      <button type="button" data-k="late" aria-pressed="${kind === "late"}">Most often late</button>
      <button type="button" data-k="on" aria-pressed="${kind === "on"}">Most punctual</button>
    </div>
    <ol>${rows.map((x) => `<li><button type="button" data-id="${esc(x.r.id)}">
      ${busSvg(opColour(x.r.operator), 40)}<span class="lr"><b>${esc(x.r.route)}</b> ${esc(x.r.operator)}
      <span class="bar ${kind}"><i style="width:${kind === "late" ? x.late : x.on}%"></i></span></span>
      <span class="pc">${kind === "late" ? x.late : x.on}%<small>${kind === "late" ? "5+ min late" : "on time"}</small></span>
    </button></li>`).join("")}</ol>
    <p class="private">Share of stops reached, measured every hour. Routes need 30 measured trips to rank.</p>`
  el.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => league(b.dataset.k)))
  el.querySelectorAll("ol button").forEach((b) => b.addEventListener("click", () => pickRoute(byId.get(b.dataset.id))))
}

// ---------- buses near me ----------
function nearMe() {
  const btn = $("near")
  if (!navigator.geolocation) return say(`<p class="error">This browser can't share your location. Type your bus number instead.</p>`)
  btn.setAttribute("aria-busy", "true"); btn.lastChild.textContent = " Finding you…"
  navigator.geolocation.getCurrentPosition(async (pos) => {
    you = [pos.coords.longitude, pos.coords.latitude]
    await ready
    map.getSource("you").setData({ type: "FeatureCollection", features: [point(...you)] })
    map.flyTo({ center: you, zoom: 15.2, pitch: tilt(62), padding: openArea(), duration: reduceMotion ? 0 : 2500 })
    const live = lastLive || await getJson(LIVE).catch(() => null)
    if (!live) return say(`<p class="error">The live bus feed isn't answering. Try again in a minute.</p>`)
    const kx = 111320 * Math.cos((you[1] * Math.PI) / 180)
    const near = new Map()
    for (const b of live.buses) {
      const m = Math.hypot((b.lo - you[0]) * kx, (b.la - you[1]) * 110540)
      if (m > NEAR_M || !byId.has(b.r)) continue
      const e = near.get(b.r) || { r: byId.get(b.r), n: 0, m }
      e.n++; e.m = Math.min(e.m, m); near.set(b.r, e)
    }
    const rows = [...near.values()].sort((a, b) => a.m - b.m)
    btn.removeAttribute("aria-busy"); btn.lastChild.textContent = " Buses near me"
    const html = rows.length
      ? `<p class="summary">${rows.length === 1 ? "One route has" : `${rows.length} routes have`} a bus within ${NEAR_M} m of you.</p>`
      : `<p class="summary">No buses within ${NEAR_M} m of you right now.</p><p>Type your bus number to see where it is.</p>`
    say(html + `<p class="private">Your location stays on this device.</p>`)
    showChoices(rows.map((e) => e.r))
  }, () => {
    btn.removeAttribute("aria-busy"); btn.lastChild.textContent = " Buses near me"
    say(`<p class="error">Location is off for this site. Allow it in your browser settings, or type your bus number.</p>`)
  }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 })
}

// ---------- a route ----------
async function pickRoute(r) {
  if (!r) return
  current = r; selected = null; dir = null
  document.body.classList.add("has-route")
  $("fav").hidden = $("share").hidden = false
  $("fav").setAttribute("aria-pressed", (store.get("favs") || []).includes(r.id))
  q.value = r.route; clearBtn.hidden = false
  dest.textContent = r.to[0] ? place(r.to[0]) : r.operator
  choices.querySelectorAll(".choice").forEach((b) => b.setAttribute("aria-pressed", b.dataset.id === r.id))
  const p = new URLSearchParams(params); p.set("r", r.id)
  history.replaceState(null, "", "?" + p)
  store.set("recent", [r.id, ...(store.get("recent") || []).filter((x) => x !== r.id)].slice(0, 5))
  say(`<p class="summary">Finding buses on the ${esc(r.route)}…</p>`)
  list.innerHTML = ""; mystop.hidden = true
  clearInterval(timer)
  try {
    routeCache[r.id] ??= await getJson(`${DATA}/r/${r.id}.json`)
  } catch {
    return say(`<p class="error">The timetable for the ${esc(r.route)} didn't load. Check your connection and try again.</p>`)
  }
  setupMyStop(r, routeCache[r.id])
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
    return say(`<p class="error">The live bus feed isn't answering. This page tries again every 20 seconds.</p>`)
  }
  if (r !== current) return
  const tt = routeCache[r.id]
  const all = live.buses.map((b) => ({ ...b, m: locate(b, tt) }))
    .filter((b) => b.m.status !== "finished")
    .sort((a, b) => order(a) - order(b))
  // direction filter: only offered when buses are heading to more than one place
  const heads = [...new Set(all.map((b) => b.m.head).filter(Boolean))]
  if (!heads.includes(dir)) dir = null
  $("dirs").innerHTML = heads.length > 1 ? [null, ...heads].map((h) =>
    `<button type="button" aria-pressed="${dir === h}" data-h="${esc(h ?? "")}">${h ? "To " + esc(place(h)) : "Both ways"}</button>`).join("") : ""
  $("dirs").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { dir = b.dataset.h || null; refresh(false) }))
  const buses = dir ? all.filter((b) => b.m.head === dir) : all
  render(r, tt, buses, live.at)
  renderArrivals(r, tt, buses)
  await ready
  draw(tt, buses, fit)
}

const order = (b) => (b.m.status === "running" ? -b.m.delay : b.m.status === "waiting" ? 1e6 + b.m.departs : 2e9)
const clsOf = (m) => (m.status === "running" ? verdict(m.delay) : "quiet")
const short = (m) => {
  if (m.status === "waiting") return `${clock(m.departs)}`
  if (m.status !== "running") return "?"
  const d = Math.round(m.delay / 60)
  return verdict(m.delay) === "on-time" ? (d > 0 ? `+${d}` : "On time") : d > 0 ? `+${d}` : `${d}`
}

function render(r, tt, buses, at) {
  const running = buses.filter((b) => b.m.status === "running")
  const late = running.filter((b) => verdict(b.m.delay) === "late").length
  const s = stats.routes?.[`${r.route}|${r.operator}`]
  const usual = s && s[0] >= 10
    ? `<p class="usual">Usually ${s[1]}% of stops are reached on time and ${s[2]}% over 5 minutes late, from ${s[0]} measured trips.</p>` : ""
  const n = (k) => `${k} ${k === 1 ? "bus" : "buses"}`
  let summary
  if (!buses.length) summary = `No buses on the ${esc(r.route)} are reporting a position right now.`
  else if (!running.length) summary = `${n(buses.length)} on the ${esc(r.route)}, none on the road yet.`
  else summary = `${n(running.length)} on the ${esc(r.route)} right now. ${late ? `${late} ${late === 1 ? "is" : "are"} over 5 minutes late.` : "None is more than 5 minutes late."}`
  say(`<p class="summary">${summary}</p>${usual}${buses.length ? "" : nextJourneys(tt)}
    <p class="fresh">${esc(r.operator)}. Positions from ${clock(at)}, updating every 20 seconds.</p>`)
  list.innerHTML = buses.map(row).join("")
  list.querySelectorAll(".bus > button").forEach((b) => b.addEventListener("click", () => select(b.parentElement.dataset.v, true)))
}

function todayIndex(tt) {
  const base = serviceDayStart(londonDate(Date.now() / 1000))
  return { base, k: Math.round((base - serviceDayStart(tt.d0)) / 86400) }
}

function nextJourneys(tt) {
  const now = Date.now() / 1000, { base, k } = todayIndex(tt)
  const due = Object.values(tt.trips).filter((t) => (t[4] >> k) & 1 && base + t[1] > now).sort((a, b) => a[1] - b[1]).slice(0, 4)
  if (!due.length) return `<p>No more journeys are timetabled today.</p>`
  return `<p>Next journeys start at ${due.map((t) => `${clock(base + t[1])} to ${esc(place(tt.heads[t[0]] || "the end of the route"))}`).join(", ")}.</p>`
}

function row(b) {
  const m = b.m, cls = clsOf(m)
  let mins, where, extra = ""
  if (m.status === "running") {
    const d = Math.round(m.delay / 60)
    mins = cls === "on-time" ? (d > 0 ? `${d}<small>min late<span class="sr-only">, counts as on time</span></small>` : `0<small>On time</small>`)
      : cls === "late" ? `${d}<small>min late</small>` : `${-d}<small>min early</small>`
    where = `<strong>To ${esc(place(m.head || "end of route"))}</strong><span>Near ${esc(m.near)}</span>`
    extra = `<ol class="next">${m.next.map((n) => `<li><span class="n">${esc(n.name)}</span>${
      Math.abs(n.expected - n.due) >= 60 ? `<s>${clock(n.due)}</s><b>${clock(n.expected)}</b>` : `<span></span><b>${clock(n.due)}</b>`}</li>`).join("")}</ol>`
    if (m.relabelledTo) extra += `<p class="note">This bus is still broadcasting its previous journey, so it's shown against the one it's running now.</p>`
  } else if (m.status === "waiting") {
    mins = `${clock(m.departs)}<small>leaves</small>`
    where = `<strong>To ${esc(place(m.head || "end of route"))}</strong><span>Waiting at ${esc(m.pts[0].stop[0])}</span>`
  } else {
    mins = `?<small>${m.status === "offroute" ? "off route" : "no timetable"}</small>`
    where = `<strong>Position only</strong><span>${m.status === "offroute" ? "This bus is away from its timetabled route, perhaps on a diversion." : "This bus isn't reporting a timetabled journey."}</span>`
  }
  return `<li class="bus ${cls}" data-v="${esc(b.v)}" aria-current="${b.v === selected}">
    <button type="button"><span class="lead"><span class="mins">${mins}</span>${busSvg(opColour(current?.operator), 52)}</span><span class="where">${where}${extra}</span></button></li>`
}

// ---------- your stop ----------
function setupMyStop(r, tt) {
  const { k } = todayIndex(tt)
  const names = new Set()
  for (const t of Object.values(tt.trips)) if ((t[4] >> k) & 1) for (const i of t[2]) names.add(tt.stops[i][0])
  const chosen = store.get(`stop:${r.id}`)
  mystop.hidden = false
  mystop.innerHTML = `<label for="stop">Where are you waiting?</label>
    <div class="field"><input id="stop" list="stops" placeholder="Start typing your stop" value="${esc(chosen && names.has(chosen) ? chosen : "")}">
    <button type="button" class="x" id="stop-x" aria-label="Clear your stop">&times;</button></div>
    <datalist id="stops">${[...names].sort().map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
    <ol class="arrivals" id="arrivals" aria-live="polite"></ol>`
  const input = $("stop")
  const set = () => {
    const v = input.value.trim()
    if (v && !names.has(v)) return
    store.set(`stop:${r.id}`, v || null)
    lastArrivals && renderArrivals(...lastArrivals)
    lastArrivals && draw(lastArrivals[1], lastArrivals[2], false)
  }
  input.addEventListener("change", set)
  input.addEventListener("input", () => names.has(input.value.trim()) && set())
  $("stop-x").addEventListener("click", () => { input.value = ""; set(); input.focus() })
}

let lastArrivals = null
function renderArrivals(r, tt, buses) {
  lastArrivals = [r, tt, buses]
  const out = $("arrivals")
  if (!out) return
  const stop = store.get(`stop:${r.id}`)
  if (!stop) { out.innerHTML = ""; return }
  const now = Date.now() / 1000
  const live = buses.map((b) => ({ b, e: etaAt(b.m, stop, now) })).filter((x) => x.e)
  const tracked = new Set(buses.map((b) => b.m.trip))
  // journeys due at this stop that no tracked bus is running yet
  const { base, k } = todayIndex(tt)
  // operators sometimes publish the same journey twice under two services, so key on time and destination
  const planned = new Map()
  for (const t of Object.values(tt.trips)) {
    if (!((t[4] >> k) & 1) || tracked.has(t)) continue
    t[2].forEach((i, j) => {
      const due = base + t[1] + t[3][j]
      if (j < t[2].length - 1 && tt.stops[i][0] === stop && due > now && due < now + 5400) planned.set(`${due}|${t[0]}`, { due, head: tt.heads[t[0]] })
    })
  }
  const items = [
    ...live.map(({ b, e }) => ({ at: e.expected, html: arrival(e.expected, now, clsOf(b.m), `${clock(e.expected)}${Math.round(e.delay / 60) >= 1 ? `, ${Math.round(e.delay / 60)} min late` : ", on time"}`, `Bus to ${place(b.m.head || "end of route")}, live`) })),
    ...[...planned.values()].map((p) => ({ at: p.due, html: arrival(p.due, now, "quiet", `${clock(p.due)} timetabled`, `To ${place(p.head || "end of route")}, not tracked yet`) })),
  ].sort((a, b) => a.at - b.at).slice(0, 5)
  out.innerHTML = items.length ? items.map((x) => x.html).join("") : `<li class="quiet"><span class="in">–</span><span class="what">Nothing due at ${esc(stop)} in the next 90 minutes.</span></li>`
}

function arrival(at, now, cls, line, sub) {
  const mins = Math.max(0, Math.round((at - now) / 60))
  return `<li class="${cls}"><span class="in">${mins ? mins : "Due"}${mins ? "<small>min</small>" : ""}</span>
    <span class="what">${esc(line)}<span>${esc(sub)}</span></span></li>`
}

// ---------- map drawing for a route ----------
function select(v, fly) {
  selected = selected === v ? null : v
  list.querySelectorAll(".bus").forEach((li) => li.setAttribute("aria-current", li.dataset.v === selected))
  for (const [id, t] of tags) t.getElement().classList.toggle("sel", id === selected)
  const b = shown.find((x) => x.id === selected)
  if (b && fly) {
    map.flyTo({ center: [b.lon, b.lat], zoom: Math.max(map.getZoom(), 16), pitch: tilt(66), padding: openArea(),
      bearing: flat ? 0 : (b.heading + 200) % 360, duration: reduceMotion ? 0 : 1800 })
    if (innerWidth < 960) sheet.classList.remove("open")
  }
  list.querySelector(`[data-v="${CSS.escape(v)}"]`)?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" })
}

function draw(tt, buses, fit) {
  const trips = new Set(), lines = [], stopsOn = new Map()
  for (const b of buses) if (b.m.trip) trips.add(b.m.trip)
  if (!trips.size) { // nothing running: show the route's longest journey
    const t = Object.values(tt.trips).sort((a, b) => b[2].length - a[2].length)[0]
    if (t) trips.add(t)
  }
  for (const t of trips) {
    lines.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: t[2].map((i) => [tt.stops[i][2], tt.stops[i][1]]) } })
    t[2].forEach((i) => stopsOn.set(tt.stops[i][0] + i, tt.stops[i]))
  }
  const mine = store.get(`stop:${current?.id}`)
  const stopFeats = [...stopsOn.values()].map((s) => s[0] === mine
    ? { type: "Feature", properties: { name: s[0], mine: true }, geometry: { type: "Polygon", coordinates: [square(s[2], s[1], 9)] } }
    : point(s[2], s[1], { name: s[0] }))
  map.getSource("route").setData({ type: "FeatureCollection", features: lines })
  map.getSource("stops").setData({ type: "FeatureCollection", features: stopFeats })
  placeBuses(buses.map((b) => {
    const cls = clsOf(b.m)
    return { id: b.v, routeId: current?.id, lon: b.lo, lat: b.la, heading: b.m.heading ?? (b.b >= 0 ? b.b : 0),
      colour: COLOURS[cls], cls, label: short(b.m), aria: `${current?.route} bus, ${short(b.m)}` }
  }), true)
  if (fit) {
    const pts = [...buses.map((b) => [b.lo, b.la]), ...[...stopsOn.values()].map((s) => [s[2], s[1]])]
    if (pts.length) {
      const bounds = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]))
      map.fitBounds(bounds, { padding: openArea(40), pitch: tilt(58), bearing: flat ? 0 : -20, maxZoom: 15, duration: reduceMotion ? 0 : 2200 })
    }
  }
}

// The part of the screen the blind and panel leave open, so the camera frames things there. Always keeps at
// least 180 px of map, or MapLibre refuses to fit at all on short screens.
function openArea(extra = 0) {
  if (innerWidth >= 960) return { top: 40 + extra, bottom: 40 + extra, left: 460 + extra, right: 40 + extra }
  const top = 140, bottom = Math.max(0, Math.min(innerHeight * 0.45, innerHeight - top - 180))
  return { top, bottom, left: extra / 2, right: extra / 2 }
}

// a small square around a point, for the extruded "you are here" stop post
function square(lon, lat, m) {
  const dx = m / (111320 * Math.cos((lat * Math.PI) / 180)), dy = m / 110540
  return [[lon - dx, lat - dy], [lon + dx, lat - dy], [lon + dx, lat + dy], [lon - dx, lat + dy], [lon - dx, lat - dy]]
}

// ---------- tools: save, share, 3D or flat, map style ----------
$("fav").addEventListener("click", () => {
  if (!current) return
  const favs = store.get("favs") || [], on = !favs.includes(current.id)
  store.set("favs", on ? [current.id, ...favs].slice(0, 8) : favs.filter((x) => x !== current.id))
  $("fav").setAttribute("aria-pressed", on)
  toast(on ? `Saved the ${current.route}. It's on the home screen now.` : `Removed the ${current.route} from your saved buses.`)
})

$("share").addEventListener("click", async () => {
  if (!current) return
  const data = { title: `Is the ${current.route} late?`, text: `Live: where the ${current.route} is right now and how late it's running.`, url: location.href }
  try {
    if (navigator.share) await navigator.share(data)
    else { await navigator.clipboard.writeText(data.url); toast("Link copied.") }
  } catch { /* closed the share sheet */ }
})

const viewBtn = $("view")
const showView = () => { viewBtn.textContent = flat ? "2D" : "3D"; viewBtn.setAttribute("aria-pressed", !flat) }
showView()
viewBtn.addEventListener("click", () => {
  flat = !flat; store.set("flat", flat); showView()
  map.easeTo({ pitch: tilt(62), bearing: flat ? 0 : -24, duration: reduceMotion ? 0 : 900 })
})

const looks = $("looks"), looksBtn = $("looks-btn")
looks.innerHTML = Object.entries(LOOKS).map(([k, l]) =>
  `<button type="button" data-k="${k}" aria-pressed="${k === lookKey}"><i class="sw-${k}"></i><b>${esc(l.name)}</b><small>${esc(l.blurb)}</small></button>`).join("")
const closeLooks = () => { looks.hidden = true; looksBtn.setAttribute("aria-expanded", false) }
looksBtn.addEventListener("click", () => { looks.hidden = !looks.hidden; looksBtn.setAttribute("aria-expanded", !looks.hidden) })
document.addEventListener("keydown", (e) => e.key === "Escape" && closeLooks())
looks.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.k === lookKey) return closeLooks()
  store.set("look", b.dataset.k)
  sessionStorage.setItem("skipIntro", "1")
  location.reload()
}))

// ---------- start ----------
Promise.all([
  getJson(`${DATA}/routes.json`).catch(() => getJson(`${(DATA = "site-data")}/routes.json`)).then((r) => { routes = r; byId = new Map(r.map((x) => [x.id, x])) }),
  getJson(STATS).then((s) => (stats = s)).catch(() => {}),
]).then(() => {
  const r = byId.get(params.get("r"))
  if (r) pickRoute(r)
  else home()
}).catch(() => say(`<p class="error">The route list didn't load. Check your connection and reload the page.</p>`))
