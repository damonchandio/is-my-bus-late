// The 3D scene: real 3D terrain, buildings, and double-decker bus models (bus3d.js), in one of a few looks.
// Every source is free with no key.
import { busLayer } from "./bus3d.js"

const TERRAIN = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png" // AWS open data
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/"
const OFM = "https://tiles.openfreemap.org"
export const COLOURS = { late: "#d2412a", "on-time": "#1e8a5c", early: "#2f6bd8", quiet: "#7b8597", overview: "#6a4ad6" }
const LED = "#ffb21a"
let fleet // the three.js bus layer
// buses are drawn larger than life so they read at any zoom: 9x out at city level, 2.5x up close
const scaleAt = (zoom) => Math.min(9, Math.max(2.5, 2 ** (17.8 - zoom)))

// Satellite photos with road and place labels, as in JARVIS Earth; buildings come from OpenStreetMap
const satelliteStyle = {
  version: 8,
  glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
  sources: {
    sat: { type: "raster", tileSize: 256, maxzoom: 19, tiles: [`${ESRI}World_Imagery/MapServer/tile/{z}/{y}/{x}`],
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
    roads: { type: "raster", tileSize: 256, maxzoom: 19, tiles: [`${ESRI}Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`] },
    places: { type: "raster", tileSize: 256, maxzoom: 19, tiles: [`${ESRI}Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`] },
    openmaptiles: { type: "vector", url: `${OFM}/planet` },
  },
  layers: [
    { id: "sat", type: "raster", source: "sat", paint: { "raster-fade-duration": 200, "raster-saturation": 0.1, "raster-contrast": 0.08 } },
    { id: "roads", type: "raster", source: "roads", paint: { "raster-opacity": 0.55 } },
    { id: "places", type: "raster", source: "places", paint: { "raster-opacity": 0.9 } },
  ],
}

export const LOOKS = {
  satellite: {
    name: "Satellite", blurb: "Real aerial photos draped over Bradford's hills, with buildings standing up out of them.",
    style: satelliteStyle, exaggeration: 1.6, routeInk: "#ffe08a", glow: 0.95,
    buildings: { color: "#eee8dc", opacity: 0.55 },
    sky: { "sky-color": "#6fa8dc", "horizon-color": "#dcecf7", "fog-color": "#dfe9ef" },
    stopInk: "#10151d",
  },
  golden: {
    name: "Golden hour", blurb: "A warm, low autumn sun over a miniature city, with the edges softly out of focus like a model railway.",
    style: `${OFM}/styles/liberty`, exaggeration: 1.6, hillshade: { shadow: "#7a4b2a", highlight: "#fff1d6", strength: 0.6 },
    buildings: { color: "#f4ecdd", opacity: 0.95 }, light: { position: [1.4, 245, 22], color: "#ffecd0", intensity: 0.4 },
    sky: { "sky-color": "#f0a868", "horizon-color": "#ffe1b8", "fog-color": "#fde9d2" },
    tiltShift: true, stopInk: "#3a2210",
  },
  night: {
    name: "Night", blurb: "The city after dark: buildings in shadow, the route lit up like the bus blind, buses glowing as they move.",
    style: `${OFM}/styles/dark`, exaggeration: 1.6, hillshade: { shadow: "#000000", highlight: "#3b4a6b", strength: 0.5 },
    buildings: { color: "#26304a", opacity: 0.9 }, light: { position: [1.2, 200, 40], color: "#9db8ff", intensity: 0.35 },
    sky: { "sky-color": "#03060e", "horizon-color": "#1a2b52", "fog-color": "#0a1222" },
    glow: 0.85, stopInk: "#ffb21a", dark: true,
  },
  street: {
    name: "Street map", blurb: "A clean, colourful street map with 3D buildings and terrain.",
    style: `${OFM}/styles/liberty`, exaggeration: 1.6, hillshade: { shadow: "#3d4a3a", highlight: "#fffbe8", strength: 0.45 },
    buildings: { color: "#f3f1ec", opacity: 0.95 }, light: { position: [1.3, 215, 35], color: "#ffffff", intensity: 0.3 },
    sky: { "sky-color": "#a9c7e8", "horizon-color": "#f3e3c3", "fog-color": "#eef1ec" },
    stopInk: "#1a1206",
  },
}

export function createMap(containerId, { reduceMotion, startClose, look = LOOKS.street }) {
  const container = document.getElementById(containerId)
  const map = new maplibregl.Map({
    container, style: look.style,
    center: startClose ? [-1.755, 53.792] : [-3.2, 54.4],
    zoom: startClose ? 12.8 : 3.4, pitch: startClose ? 60 : 0, bearing: startClose ? -24 : 0,
    maxPitch: 80, attributionControl: { compact: true },
  })
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right")
  window.busMap = map // handy in the console

  const ready = new Promise((resolve) => map.on("load", () => {
    if (!startClose) map.setProjection({ type: "globe" })
    // start the credits collapsed on phones; they stay one tap away
    if (innerWidth < 960) container.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show")
    map.addSource("dem", { type: "raster-dem", tiles: [TERRAIN], encoding: "terrarium", tileSize: 256, maxzoom: 14,
      attribution: "Terrain: Mapzen, AWS Open Data" })
    map.setTerrain({ source: "dem", exaggeration: look.exaggeration })
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id
    if (look.hillshade) map.addLayer({ id: "hills", type: "hillshade", source: "dem",
      paint: { "hillshade-exaggeration": look.hillshade.strength, "hillshade-shadow-color": look.hillshade.shadow,
        "hillshade-highlight-color": look.hillshade.highlight } }, firstSymbol)
    if (look.buildings) {
      if (map.getLayer("building-3d")) map.removeLayer("building-3d")
      map.addLayer({ id: "buildings", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 13,
        paint: { "fill-extrusion-color": look.buildings.color, "fill-extrusion-opacity": look.buildings.opacity,
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 7], "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-vertical-gradient": true } }, firstSymbol)
    }
    // the stock dark style hides the streets; lift them so the city reads at night
    if (look.dark) for (const l of map.getStyle().layers) if (l.type === "line" && l.id.startsWith("highway") && !l.id.includes("casing"))
      map.setPaintProperty(l.id, "line-color", /major|motorway/.test(l.id) ? "#6b7fb3" : "#3c4a70")
    if (look.light) map.setLight({ anchor: "map", position: look.light.position, color: look.light.color, intensity: look.light.intensity })
    map.setSky({ ...look.sky, "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.4, "fog-ground-blend": 0.9,
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 3, 1, 9, 0.2, 12, 0] })

    for (const id of ["route", "stops", "buses", "you"]) map.addSource(id, { type: "geojson", data: empty() })
    // the route glows like the blind: a soft amber halo with a dark core
    map.addLayer({ id: "route-glow", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": LED, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 8, 14, 14, 17, 12], "line-blur": 6, "line-opacity": look.glow ?? 0.5 } })
    const ink = look.routeInk ?? (look.dark ? "#ffd27a" : "#1a1206")
    map.addLayer({ id: "route-core", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": ink, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 15, 4] } })
    map.addLayer({ id: "stop-dots", type: "circle", source: "stops", minzoom: 12.5, filter: ["!=", ["get", "mine"], true],
      paint: { "circle-radius": 4, "circle-color": look.dark ? "#15120c" : "#fff", "circle-stroke-color": look.stopInk, "circle-stroke-width": 2, "circle-pitch-alignment": "map" } })
    map.addLayer({ id: "stop-names", type: "symbol", source: "stops", minzoom: 14.5,
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 12, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
      paint: { "text-color": look.dark ? "#ffd27a" : "#1a1206", "text-halo-color": look.dark ? "#000" : "#fff", "text-halo-width": 1.5 } })
    map.addLayer({ id: "my-stop", type: "fill-extrusion", source: "stops", filter: ["==", ["get", "mine"], true],
      paint: { "fill-extrusion-color": LED, "fill-extrusion-height": 70, "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.95 } })
    fleet = busLayer("buses-3d", scaleAt, look.dark)
    map.addLayer(fleet)
    // the models can't be clicked, so an almost invisible circle under each bus takes the taps
    map.addLayer({ id: "buses-hit", type: "circle", source: "buses",
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 7, 13, 14, 17, 30], "circle-opacity": 0.01 } })
    map.addLayer({ id: "you-dot", type: "circle", source: "you",
      paint: { "circle-radius": 9, "circle-color": "#2f6bd8", "circle-stroke-color": "#fff", "circle-stroke-width": 3, "circle-pitch-alignment": "map" } })
    resolve()
  }))

  return { map, ready, reduceMotion }
}

export const empty = () => ({ type: "FeatureCollection", features: [] })
export const point = (lon, lat, props = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props })

// Glide buses from where they were to where they are now, instead of jumping every 20 seconds.
export function animateBuses(map, from, to, ms, reduceMotion) {
  const start = performance.now(), prev = new Map(from.map((b) => [b.id, b]))
  const lerpAngle = (a, b, t) => a + ((((b - a) % 360) + 540) % 360 - 180) * t
  map.getSource("buses").setData({ type: "FeatureCollection", features: to.map((b) => point(b.lon, b.lat, { id: b.id, r: b.routeId })) })
  const frame = (now) => {
    const t = reduceMotion ? 1 : Math.min(1, (now - start) / ms), e = t * (2 - t)
    fleet.set(to.map((b) => {
      const p = prev.get(b.id)
      return p ? { ...b, lon: p.lon + (b.lon - p.lon) * e, lat: p.lat + (b.lat - p.lat) * e, heading: lerpAngle(p.heading, b.heading, e) } : b
    }))
    if (t < 1) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

// A floating mini destination blind above a bus: the page's hero element, repeated in the city.
export function tag(map, html, cls) {
  const el = document.createElement("div")
  el.className = `tag ${cls}`
  el.innerHTML = html
  return new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -34], pitchAlignment: "viewport" })
}
