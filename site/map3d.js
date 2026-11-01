// The 3D scene: a real street map with Bradford's hills shaded in, 3D buildings, and double-decker buses built from extrusions.
// Everything is MapLibre's own WebGL (no three.js), so it stays light enough for a phone at a bus stop.

const TERRAIN = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png" // AWS open data, no key
export const COLOURS = { late: "#d2412a", "on-time": "#1e8a5c", early: "#2f6bd8", quiet: "#7b8597", overview: "#6a4ad6" }
const GLASS = "#1b2430", SKIRT = "#141a22", LED = "#ffb21a"
// buses are drawn larger than life so they read at any zoom: 9x out at city level, 2.5x up close
const scaleAt = (zoom) => Math.min(9, Math.max(2.5, 2 ** (17.8 - zoom)))

export function createMap(containerId, { reduceMotion, startClose }) {
  const container = document.getElementById(containerId)
  const map = new maplibregl.Map({
    container,
    style: "https://tiles.openfreemap.org/styles/liberty",
    center: startClose ? [-1.755, 53.792] : [-3.2, 54.4],
    zoom: startClose ? 12.8 : 3.4, pitch: startClose ? 60 : 0, bearing: startClose ? -24 : 0,
    maxPitch: 78, attributionControl: { compact: true },
  })
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right")
  window.busMap = map // handy in the console

  const ready = new Promise((resolve) => map.on("load", () => {
    map.setProjection({ type: "globe" })
    map.addSource("dem", { type: "raster-dem", tiles: [TERRAIN], encoding: "terrarium", tileSize: 256, maxzoom: 14,
      attribution: "Terrain: Mapzen, AWS Open Data" })
    // no setTerrain: with raised terrain this MapLibre version draws markers and extrusions off their real
    // positions once the camera tilts, so the hills are shaded instead of raised
    // start the credits collapsed on phones; they stay one tap away
    if (innerWidth < 960) container.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show")
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id
    map.addLayer({ id: "hills", type: "hillshade", source: "dem",
      paint: { "hillshade-exaggeration": 0.55, "hillshade-shadow-color": "#3d4a3a", "hillshade-highlight-color": "#fffbe8" } }, firstSymbol)
    map.setSky({ "sky-color": "#a9c7e8", "horizon-color": "#f3e3c3", "fog-color": "#eef1ec", "sky-horizon-blend": 0.6,
      "horizon-fog-blend": 0.4, "fog-ground-blend": 0.9, "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 3, 1, 9, 0.2, 12, 0] })

    for (const id of ["route", "stops", "buses", "you"]) map.addSource(id, { type: "geojson", data: empty() })
    // the route glows like the blind: a soft amber halo with a dark core
    map.addLayer({ id: "route-glow", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": LED, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 8, 14, 14, 17, 12], "line-blur": 6, "line-opacity": 0.45 } })
    map.addLayer({ id: "route-core", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#1a1206", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 15, 4.5] } })
    map.addLayer({ id: "stop-dots", type: "circle", source: "stops", minzoom: 12.5, filter: ["!=", ["get", "mine"], true],
      paint: { "circle-radius": 4, "circle-color": "#fff", "circle-stroke-color": "#1a1206", "circle-stroke-width": 2, "circle-pitch-alignment": "map" } })
    map.addLayer({ id: "stop-names", type: "symbol", source: "stops", minzoom: 14.5,
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 12, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
      paint: { "text-color": "#1a1206", "text-halo-color": "#fff", "text-halo-width": 1.5 } })
    map.addLayer({ id: "my-stop", type: "fill-extrusion", source: "stops", filter: ["==", ["get", "mine"], true],
      paint: { "fill-extrusion-color": LED, "fill-extrusion-height": 70, "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.95 } })
    map.addLayer({ id: "buses-3d", type: "fill-extrusion", source: "buses",
      paint: { "fill-extrusion-color": ["get", "c"], "fill-extrusion-base": ["get", "b"], "fill-extrusion-height": ["get", "h"],
        "fill-extrusion-opacity": 1, "fill-extrusion-vertical-gradient": true } })
    map.addLayer({ id: "you-dot", type: "circle", source: "you",
      paint: { "circle-radius": 9, "circle-color": "#2f6bd8", "circle-stroke-color": "#fff", "circle-stroke-width": 3, "circle-pitch-alignment": "map" } })
    resolve()
  }))

  return { map, ready, reduceMotion }
}

export const empty = () => ({ type: "FeatureCollection", features: [] })
export const point = (lon, lat, props = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props })

// One double-decker as stacked boxes (metres before SCALE): skirt, lower deck, glass, band, upper glass, roof, and the
// lit destination blind on the front. Each box is a polygon footprint with its own base and top.
const PARTS = [
  // [from rear, to front, half width, base, top, colour]  (null colour = the bus's status colour)
  [-5.6, 5.6, 1.22, 0, 0.5, SKIRT],
  [-5.6, 5.6, 1.27, 0.5, 2.0, null],
  [-5.5, 5.5, 1.24, 2.0, 2.7, GLASS],
  [-5.6, 5.6, 1.27, 2.7, 3.0, null],
  [-5.5, 5.4, 1.24, 3.0, 3.85, GLASS],
  [-5.6, 5.45, 1.2, 3.85, 4.4, null],
  [5.45, 5.75, 0.9, 3.25, 3.75, LED],
]

export function busFeatures(bus, SCALE) {
  const { lon, lat, heading, colour, id, routeId, label } = bus
  const th = (heading * Math.PI) / 180, fx = Math.sin(th), fy = Math.cos(th), rx = fy, ry = -fx
  const kx = 1 / (111320 * Math.cos((lat * Math.PI) / 180)), ky = 1 / 110540
  const at = (along, side) => [lon + (fx * along + rx * side) * SCALE * kx, lat + (fy * along + ry * side) * SCALE * ky]
  return PARTS.map(([a0, a1, w, b, h, c]) => ({
    type: "Feature",
    properties: { id, r: routeId, label, c: c || colour, b: b * SCALE, h: h * SCALE },
    geometry: { type: "Polygon", coordinates: [[at(a0, -w), at(a1, -w), at(a1, w), at(a0, w), at(a0, -w)]] },
  }))
}

// Glide buses from where they were to where they are now, instead of jumping every 20 seconds.
export function animateBuses(map, from, to, ms, reduceMotion) {
  const src = map.getSource("buses")
  const start = performance.now(), prev = new Map(from.map((b) => [b.id, b])), scale = scaleAt(map.getZoom())
  const lerpAngle = (a, b, t) => a + ((((b - a) % 360) + 540) % 360 - 180) * t
  const frame = (now) => {
    const t = reduceMotion ? 1 : Math.min(1, (now - start) / ms), e = t * (2 - t)
    const feats = to.flatMap((b) => {
      const p = prev.get(b.id)
      if (!p) return busFeatures(b, scale)
      return busFeatures({ ...b, lon: p.lon + (b.lon - p.lon) * e, lat: p.lat + (b.lat - p.lat) * e, heading: lerpAngle(p.heading, b.heading, e) }, scale)
    })
    src.setData({ type: "FeatureCollection", features: feats })
    if (t < 1) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

// Rebuild the buses at the right size after zooming.
export function rescale(map, buses) {
  const scale = scaleAt(map.getZoom())
  map.getSource("buses")?.setData({ type: "FeatureCollection", features: buses.flatMap((b) => busFeatures(b, scale)) })
}

// A floating mini destination blind above a bus: the page's hero element, repeated in the city.
export function tag(map, html, cls) {
  const el = document.createElement("div")
  el.className = `tag ${cls}`
  el.innerHTML = html
  return new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -34], pitchAlignment: "viewport" })
}
