"use client";

import { useEffect, useRef } from "react";
import Globe, { type GlobeInstance } from "globe.gl";
import { geoCentroid } from "d3-geo";

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
  paint: (s: Shape, active: boolean) => Paint;
  label: (s: Shape) => string;
  version: string;
  active: string | null;
  focus: string | null;
  reducedMotion: boolean;
  onHover: (id: string | null, name: string | null) => void;
  onOpen: (id: string) => void;
  onReady: () => void;
  onFail: () => void;
}

const RADIUS_MIN = 140;
const RADIUS_MAX = 520;
const SPIN_SPEED = 0.2;
const SPIN_RESUME_MS = 4000;

export default function GlobeCanvas(props: GlobeCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const globe = useRef<GlobeInstance | null>(null);
  const spinHold = useRef<(reason: string, on: boolean, delay?: number) => void>(() => {});
  const latest = useRef(props);
  // eslint-disable-next-line react-hooks/refs -- callbacks read the newest props without rebuilding the globe
  latest.current = props;

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
          spinHold.current("hover", !!s);
          latest.current.onHover(s?.id ?? null, s ? s.name : null);
        })
        .onPolygonClick((o) => {
          const s = o as Shape;
          if (s.id) latest.current.onOpen(s.id);
        })
        .pointOfView({ lat: 22, lng: 8, altitude: 1.95 }, 0);
    } catch {
      el.replaceChildren();
      latest.current.onFail();
      return;
    }

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
    controls.autoRotateSpeed = SPIN_SPEED;
    const holds = new Set<string>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const applySpin = () => {
      controls.autoRotate = !latest.current.reducedMotion && holds.size === 0;
    };
    spinHold.current = (reason, on, delay = 0) => {
      clearTimeout(timers.get(reason));
      timers.delete(reason);
      if (on) holds.add(reason);
      else if (delay > 0) {
        timers.set(
          reason,
          setTimeout(() => {
            timers.delete(reason);
            holds.delete(reason);
            applySpin();
          }, delay),
        );
        return;
      } else holds.delete(reason);
      applySpin();
    };
    applySpin();
    const stop = () => spinHold.current("drag", true);
    const resume = () => spinHold.current("drag", false, SPIN_RESUME_MS);
    controls.addEventListener("start", stop);
    controls.addEventListener("end", resume);
    controls.domElement.style.touchAction = "pan-y";

    const size = () => {
      g.width(el.clientWidth).height(el.clientHeight);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);

    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) g.resumeAnimation();
      else g.pauseAnimation();
    });
    io.observe(el);

    globe.current = g;
    latest.current.onReady();
    return () => {
      controls.removeEventListener("start", stop);
      controls.removeEventListener("end", resume);
      timers.forEach(clearTimeout);
      spinHold.current = () => {};
      ro.disconnect();
      io.disconnect();
      g.renderer().forceContextLoss();
      g._destructor();
      el.replaceChildren();
      globe.current = null;
    };
  }, []);

  const { shapes } = props;
  useEffect(() => {
    globe.current?.polygonsData(shapes);
  }, [shapes]);

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

  const { reducedMotion } = props;
  useEffect(() => {
    spinHold.current("motion", reducedMotion);
  }, [reducedMotion]);

  const { focus } = props;
  useEffect(() => {
    const g = globe.current;
    if (!g) return;
    spinHold.current("focus", !!focus, focus ? 0 : SPIN_RESUME_MS);
    if (!focus) return;
    const s = latest.current.shapes.find((x) => x.id === focus && x.kind === "box") ?? latest.current.shapes.find((x) => x.id === focus);
    if (!s) return;
    const [lng, lat] = geoCentroid({ type: "Feature", properties: {}, geometry: s.geometry } as Parameters<typeof geoCentroid>[0]);
    g.pointOfView({ lat, lng, altitude: Math.min(g.pointOfView().altitude, 2) }, latest.current.reducedMotion ? 0 : 900);
  }, [focus]);

  return <div ref={host} aria-hidden="true" className="absolute inset-0 [&_canvas]:outline-none" />;
}
