"use client";

// FE-026: the WebGL globe itself (globe.gl on three.js). Loaded only by GlobeExplorer, with a dynamic import after
// the page has painted, so three.js sits in its own chunk and no other page's bundle grows. Draws Natural Earth
// 1:110m countries as polygons (colour and height from the explorer) and the deep dives as outlined boxes on top.
// Everything it shows is also in the table under it; the canvas is aria-hidden.
import { useEffect, useRef } from "react";
import Globe, { type GlobeInstance } from "globe.gl";
import { geoCentroid } from "d3-geo";

/** One shape on the globe: a country outline or a deep-dive box. `id` = the region it shows, or null (no record). */
export interface Shape {
  kind: "country" | "box";
  id: string | null;
  name: string;
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
}

export interface Paint {
  cap: string;
  side: string;
  stroke: string;
  altitude: number;
}

export interface GlobeCanvasProps {
  shapes: Shape[];
  /** Colour and height of a shape in the current view; called again whenever `version` changes. */
  paint: (s: Shape, active: boolean) => Paint;
  /** Tooltip HTML (already escaped) for a shape. */
  label: (s: Shape) => string;
  /** Bumped by the explorer whenever year, view or selection change, so the accessors re-run. */
  version: string;
  /** Region the readout is showing (hovered on the globe or focused in the table). */
  active: string | null;
  /** Turn to this region (from the table); null leaves the camera alone. */
  focus: string | null;
  reducedMotion: boolean;
  onHover: (id: string | null, name: string | null) => void;
  onOpen: (id: string) => void;
  onReady: () => void;
  /** WebGL failed after all (context lost, GPU gone): the explorer falls back to the table. */
  onFail: () => void;
}

const RADIUS_MIN = 140; // three-globe radius is 100: zoom stops just above the surface ...
const RADIUS_MAX = 520; // ... and before the globe is a dot

export default function GlobeCanvas(props: GlobeCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const globe = useRef<GlobeInstance | null>(null);
  const latest = useRef(props);
  // eslint-disable-next-line react-hooks/refs -- callbacks read the newest props without rebuilding the globe
  latest.current = props;

  // build once
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let g: GlobeInstance;
    try {
      g = new Globe(el, { rendererConfig: { antialias: true, alpha: true, powerPreference: "high-performance" }, animateIn: false })
        .backgroundColor("rgba(0,0,0,0)")
        .showGraticules(true)
        .showAtmosphere(true)
        .atmosphereColor("#ff3b2e")
        .atmosphereAltitude(0.17)
        .polygonGeoJsonGeometry("geometry")
        .polygonCapCurvatureResolution(4)
        .polygonsTransitionDuration(latest.current.reducedMotion ? 0 : 450)
        .polygonLabel((o) => latest.current.label(o as Shape))
        .onPolygonHover((o) => {
          const s = o as Shape | null;
          el.style.cursor = s?.id ? "pointer" : "";
          latest.current.onHover(s?.id ?? null, s ? s.name : null);
        })
        .onPolygonClick((o) => {
          const s = o as Shape;
          if (s.id) latest.current.onOpen(s.id);
        })
        .pointOfView({ lat: 22, lng: 8, altitude: 1.95 }, 0);
    } catch {
      // the WebGL probe passed but the real context did not: never take the page (and its table) down with it
      el.replaceChildren();
      latest.current.onFail();
      return;
    }

    // three-globe's own MeshPhongMaterial, recoloured (no direct three.js import needed)
    const mat = g.globeMaterial() as unknown as { color: { set(c: string): void }; emissive?: { set(c: string): void }; shininess?: number };
    mat.color.set("#1a0f0d");
    mat.emissive?.set("#090403");
    mat.shininess = 4;

    const controls = g.controls();
    controls.minDistance = RADIUS_MIN;
    controls.maxDistance = RADIUS_MAX;
    controls.enableDamping = true;
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 0.8;
    // slow spin until the first touch; never under reduced motion
    controls.autoRotate = !latest.current.reducedMotion;
    controls.autoRotateSpeed = 0.35;
    const stop = () => {
      controls.autoRotate = false;
    };
    controls.addEventListener("start", stop);
    // OrbitControls sets touch-action: none, which would trap page scroll on phones: let vertical swipes scroll the
    // page and keep horizontal swipes (and pinch) for the globe
    controls.domElement.style.touchAction = "pan-y";

    const size = () => {
      g.width(el.clientWidth).height(el.clientHeight);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);

    // no frames drawn while the globe is scrolled out of view
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) g.resumeAnimation();
      else g.pauseAnimation();
    });
    io.observe(el);

    globe.current = g;
    latest.current.onReady();
    return () => {
      controls.removeEventListener("start", stop);
      ro.disconnect();
      io.disconnect();
      g.renderer().forceContextLoss(); // hand the WebGL context back now, not at garbage collection
      g._destructor();
      el.replaceChildren();
      globe.current = null;
    };
  }, []);

  // data
  const { shapes } = props;
  useEffect(() => {
    globe.current?.polygonsData(shapes);
  }, [shapes]);

  // colours and heights for the current year / view / selection
  const { version, active } = props;
  useEffect(() => {
    const g = globe.current;
    if (!g) return;
    const p = (o: object) => latest.current.paint(o as Shape, (o as Shape).id !== null && (o as Shape).id === active);
    g.polygonCapColor((o) => p(o).cap)
      .polygonSideColor((o) => p(o).side)
      .polygonStrokeColor((o) => p(o).stroke)
      .polygonAltitude((o) => p(o).altitude);
  }, [version, active, shapes]);

  // turn to a region chosen in the table
  const { focus } = props;
  useEffect(() => {
    const g = globe.current;
    if (!g || !focus) return;
    const s = latest.current.shapes.find((x) => x.id === focus && x.kind === "box") ?? latest.current.shapes.find((x) => x.id === focus);
    if (!s) return;
    const [lng, lat] = geoCentroid({ type: "Feature", properties: {}, geometry: s.geometry } as Parameters<typeof geoCentroid>[0]);
    g.controls().autoRotate = false;
    g.pointOfView({ lat, lng, altitude: Math.min(g.pointOfView().altitude, 2) }, latest.current.reducedMotion ? 0 : 900);
  }, [focus]);

  return <div ref={host} aria-hidden="true" className="absolute inset-0 [&_canvas]:outline-none" />;
}
