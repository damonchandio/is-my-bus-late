// The buses as real 3D models: a low-poly double-decker (body, windows, wheels, lights, destination blind) drawn with
// three.js inside MapLibre's own WebGL context, so buildings and hills hide them properly. One model, instanced.
import * as THREE from "three"
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"

const ORIGIN = [-1.75, 53.79] // Bradford: bus positions are sent to the GPU in metres from here, for precision
const CAP = 3000 // shortcut: fixed instance buffer; West Yorkshire peaks near 1,100 buses, raise if the box grows

// Geometry is in metres with +Y forward and +Z up. A colour makes it a fixed-colour trim part.
function tint(g, colour) {
  const c = new THREE.Color(colour), a = new Float32Array(g.attributes.position.count * 3)
  for (let i = 0; i < a.length; i += 3) a.set([c.r, c.g, c.b], i)
  return g.setAttribute("color", new THREE.BufferAttribute(a, 3))
}
const box = (w, l, h, x, y, z, colour) => tint(new THREE.BoxGeometry(w, l, h).translate(x, y, z), colour)
const wheel = (x, y) => tint(new THREE.CylinderGeometry(0.52, 0.52, 0.34, 14).rotateZ(Math.PI / 2).translate(x, y, 0.52), "#15181d")
const hub = (x, y) => tint(new THREE.CylinderGeometry(0.24, 0.24, 0.36, 10).rotateZ(Math.PI / 2).translate(x, y, 0.52), "#aab2bf")

function model() {
  const GLASS = "#18212d"
  // painted shell: takes the bus's own colour
  const body = new RoundedBoxGeometry(2.55, 11.2, 4.0, 3, 0.32).translate(0, 0, 2.4)
  const trim = mergeGeometries([
    box(2.4, 10.9, 0.5, 0, 0, 0.55, "#141a22"), // skirt
    ...[-1, 1].flatMap((s) => [
      box(0.05, 9.0, 0.78, s * 1.275, -0.5, 1.78, GLASS), // lower deck windows
      box(0.05, 10.3, 0.8, s * 1.275, 0, 3.42, GLASS), // upper deck windows
      wheel(s * 1.12, 3.5), wheel(s * 1.12, -3.3), hub(s * 1.13, 3.5), hub(s * 1.13, -3.3),
    ]),
    box(0.05, 1.1, 1.75, -1.275, 4.75, 1.45, GLASS), // doors, nearside front
    box(2.25, 0.05, 1.15, 0, 5.6, 1.62, GLASS), // windscreen
    box(2.25, 0.05, 0.8, 0, 5.6, 3.42, GLASS), // upper front window
    box(2.1, 0.05, 0.7, 0, -5.6, 3.42, GLASS), // upper rear window
    box(2.2, 10.2, 0.05, 0, 0, 4.41, "#e6e9ee"), // roof panel
  ])
  const glow = mergeGeometries([
    box(1.9, 0.06, 0.34, 0, 5.61, 4.02, "#ffb21a"), // destination blind
    box(0.36, 0.06, 0.2, -0.9, 5.61, 0.82, "#fff3c4"), box(0.36, 0.06, 0.2, 0.9, 5.61, 0.82, "#fff3c4"), // headlights
    box(0.3, 0.06, 0.22, -0.95, -5.61, 0.95, "#ff3b30"), box(0.3, 0.06, 0.22, 0.95, -5.61, 0.95, "#ff3b30"), // tail lights
  ])
  // the map's y axis points south, which mirrors the model: draw both sides so no face is culled
  const side = THREE.DoubleSide
  return [
    new THREE.InstancedMesh(body, new THREE.MeshLambertMaterial({ color: "#fff", side }), CAP),
    new THREE.InstancedMesh(trim, new THREE.MeshLambertMaterial({ vertexColors: true, side }), CAP),
    new THREE.InstancedMesh(glow, new THREE.MeshBasicMaterial({ vertexColors: true, side }), CAP),
  ]
}

// A MapLibre custom layer. set(buses) takes [{lon, lat, heading, colour}]; scaleAt(zoom) is how much larger than life.
export function busLayer(id, scaleAt, night) {
  let map, renderer, meshes, fleet = []
  const scene = new THREE.Scene(), camera = new THREE.Camera()
  const origin = maplibregl.MercatorCoordinate.fromLngLat(ORIGIN, 0), unit = origin.meterInMercatorCoordinateUnits()
  const local = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z).scale(new THREE.Vector3(unit, -unit, unit))
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), size = new THREE.Vector3()
  const up = new THREE.Vector3(0, 0, 1), colour = new THREE.Color()
  return {
    id, type: "custom", renderingMode: "3d",
    set(buses) { fleet = buses; map?.triggerRepaint() },
    onAdd(theMap, gl) {
      map = theMap
      meshes = model()
      for (const mesh of meshes) { mesh.frustumCulled = false; mesh.count = 0; scene.add(mesh) }
      scene.add(new THREE.AmbientLight("#ffffff", night ? 1.5 : 2.1))
      const sun = new THREE.DirectionalLight("#ffffff", night ? 0.9 : 1.7)
      sun.position.set(-0.5, -0.7, 1)
      scene.add(sun)
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true })
      renderer.autoClear = false
    },
    render(gl, args) {
      // the globe is only on screen during the fly-in, when buses would be specks anyway
      const n = map.getProjection()?.type === "globe" ? 0 : Math.min(fleet.length, CAP)
      if (!n) return
      const k = scaleAt(map.getZoom())
      for (let i = 0; i < n; i++) {
        const b = fleet[i], at = maplibregl.MercatorCoordinate.fromLngLat([b.lon, b.lat], 0)
        // queryTerrainElevation is relative to the map centre, the same frame MapLibre's matrix uses
        pos.set((at.x - origin.x) / unit, (origin.y - at.y) / unit, map.queryTerrainElevation([b.lon, b.lat]) || 0)
        m.compose(pos, q.setFromAxisAngle(up, (-b.heading * Math.PI) / 180), size.setScalar(k))
        for (const mesh of meshes) mesh.setMatrixAt(i, m)
        meshes[0].setColorAt(i, colour.set(b.colour))
      }
      for (const mesh of meshes) { mesh.count = n; mesh.instanceMatrix.needsUpdate = true }
      meshes[0].instanceColor.needsUpdate = true
      camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix).multiply(local)
      renderer.resetState()
      renderer.render(scene, camera)
    },
  }
}
