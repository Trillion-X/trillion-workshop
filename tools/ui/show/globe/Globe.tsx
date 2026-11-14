// bitfield/packages/ui/globe/Globe.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Interactive 3D globe primitive for rendering geographic entity graphs.
// Pure canvas — zero external 3D libraries. Fibonacci sphere for dot
// distribution, quadratic arc curves for edges, pulsing markers for nodes.
//
// Data-driven: accepts GlobeNode[] (entities) and GlobeEdge[] (relationships)
// so any EEAF knowledge graph with geographic entities can be visualized by
// projecting entity attribute_facts into this prop shape.
//
// Theme-reactive: all colors read from CSS custom properties at draw time
// via getComputedStyle — automatically adapts to Monet, dark, and any
// future theme without component changes.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO external deps — pure canvas 2D context only
// 2. ZERO hardcoded colors — all colors from CSS vars (--accent-cyan etc.)
// 3. Data shape is EEAF-ready: GlobeNode maps to entity, GlobeEdge maps to
//    relationship. Consumers project EEAF data → GlobeNode/GlobeEdge arrays.
// 4. forwardRef on the outer container div (not the canvas) for composability
// 5. autoRotateSpeed=0 disables auto-rotation (user still drags freely)
// 6. Node IDs in GlobeEdge.from/to — not raw coordinates (never couple
//    edge definitions to lat/lng literals)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { forwardRef, useRef, useEffect, useCallback, useMemo } from 'react';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

/** A geographic entity to render as a pulsing marker on the globe. */
export interface GlobeNode {
  /** Unique identifier — used to reference this node from GlobeEdge */
  id: string;
  /** Latitude (-90 to 90) */
  lat: number;
  /** Longitude (-180 to 180) */
  lng: number;
  /** Optional label rendered next to the marker */
  label?: string;
  /** Optional RGBA color override — defaults to --accent-cyan */
  color?: string;
}

/** A directional relationship between two GlobeNodes rendered as an arc. */
export interface GlobeEdge {
  /** ID of the source GlobeNode */
  from: string;
  /** ID of the target GlobeNode */
  to: string;
  /** Whether to animate a traveling particle along this arc (default: true) */
  animated?: boolean;
  /** Optional RGBA color override — defaults to --accent-blue at 50% opacity */
  color?: string;
}

export interface GlobeProps {
  /** Entity nodes to render as pulsing geographic markers */
  nodes?: GlobeNode[];
  /** Relationship edges to render as animated arc curves */
  edges?: GlobeEdge[];
  /**
   * Auto-rotation speed in radians per frame.
   * 0 = no auto-rotation (user drag only). Default: 0.002
   */
  autoRotateSpeed?: number;
  /** Number of Fibonacci sphere dots. Higher = denser globe. Default: 1200 */
  dotCount?: number;
  /** Additional className for the container div */
  className?: string;
}

// ---------------------------------------------------------------------------
// GEOMETRY HELPERS
// ---------------------------------------------------------------------------

function latLngToXYZ(lat: number, lng: number, r: number): [number, number, number] {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lng + 180) * Math.PI) / 180;
  return [
    -(r * Math.sin(phi) * Math.cos(theta)),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  ];
}

function rotateY(x: number, y: number, z: number, a: number): [number, number, number] {
  const cos = Math.cos(a), sin = Math.sin(a);
  return [x * cos + z * sin, y, -x * sin + z * cos];
}

function rotateX(x: number, y: number, z: number, a: number): [number, number, number] {
  const cos = Math.cos(a), sin = Math.sin(a);
  return [x, y * cos - z * sin, y * sin + z * cos];
}

function project(x: number, y: number, z: number, cx: number, cy: number, fov: number): [number, number] {
  const scale = fov / (fov + z);
  return [x * scale + cx, y * scale + cy];
}

// ---------------------------------------------------------------------------
// THEME COLOR READER
// ---------------------------------------------------------------------------

/**
 * Read a resolved CSS custom property from a specific element.
 *
 * Reading from the element (not document.documentElement) ensures the full
 * CSS cascade is respected — including scoped overrides like
 * [data-theme="monet"] .landing-page { --accent-cyan: #3a8098 }.
 * Reading from <html> would skip those scoped values and give the wrong color.
 */
function cssVar(name: string, el: HTMLElement): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Parse an rgba/hex color and rebuild with a new alpha value. */
function withAlpha(color: string, alpha: number): string {
  // Handle hex colors
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  // Handle rgb/rgba — replace or append alpha
  const rgb = color.match(/[\d.]+/g);
  if (rgb && rgb.length >= 3) {
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
  }
  return color;
}

// ---------------------------------------------------------------------------
// DEFAULT SAMPLE DATA (shown when no nodes/edges provided)
// ---------------------------------------------------------------------------

const SAMPLE_NODES: GlobeNode[] = [
  { id: 'sf',    lat: 37.78,  lng: -122.42, label: 'San Francisco' },
  { id: 'lon',   lat: 51.51,  lng: -0.13,   label: 'London' },
  { id: 'tok',   lat: 35.68,  lng: 139.69,  label: 'Tokyo' },
  { id: 'syd',   lat: -33.87, lng: 151.21,  label: 'Sydney' },
  { id: 'sin',   lat: 1.35,   lng: 103.82,  label: 'Singapore' },
  { id: 'msc',   lat: 55.76,  lng: 37.62,   label: 'Moscow' },
  { id: 'sao',   lat: -23.55, lng: -46.63,  label: 'São Paulo' },
  { id: 'mex',   lat: 19.43,  lng: -99.13,  label: 'Mexico City' },
  { id: 'del',   lat: 28.61,  lng: 77.21,   label: 'Delhi' },
  { id: 'erb',   lat: 36.19,  lng: 44.01,   label: 'Erbil' },
];

const SAMPLE_EDGES: GlobeEdge[] = [
  { from: 'sf',  to: 'lon' },
  { from: 'lon', to: 'tok' },
  { from: 'tok', to: 'syd' },
  { from: 'sf',  to: 'sin' },
  { from: 'lon', to: 'del' },
  { from: 'sf',  to: 'sao' },
  { from: 'sin', to: 'syd' },
  { from: 'del', to: 'erb' },
  { from: 'lon', to: 'erb' },
];

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Interactive 3D globe for visualizing geographic entity graphs.
 *
 * Drag to rotate. Auto-rotates when idle. Renders GlobeNode markers as
 * pulsing rings and GlobeEdge relationships as animated arc curves.
 *
 * Colors adapt to the active theme automatically via CSS custom properties.
 *
 * @example
 * ```tsx
 * // EEAF knowledge graph: project entities with lat/lng into GlobeNode[]
 * const nodes: GlobeNode[] = entities.map(e => ({
 *   id: e.id,
 *   lat: e.attributes.lat,
 *   lng: e.attributes.lng,
 *   label: e.attributes.name,
 * }));
 * const edges: GlobeEdge[] = relationships.map(r => ({
 *   from: r.subjectId,
 *   to: r.objectId,
 * }));
 *
 * <Globe nodes={nodes} edges={edges} autoRotateSpeed={0.001} />
 * ```
 */
export const Globe = forwardRef<HTMLDivElement, GlobeProps>(
  (
    {
      nodes = SAMPLE_NODES,
      edges = SAMPLE_EDGES,
      autoRotateSpeed = 0.002,
      dotCount = 1200,
      className,
    },
    ref,
  ) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rotYRef = useRef(0.4);
    const rotXRef = useRef(0.3);
    const dragRef = useRef<{
      active: boolean;
      startX: number;
      startY: number;
      startRotY: number;
      startRotX: number;
    }>({ active: false, startX: 0, startY: 0, startRotY: 0, startRotX: 0 });
    const animRef = useRef<number>(0);
    const timeRef = useRef(0);
    const dotsRef = useRef<[number, number, number][]>([]);

    // Build node lookup map so edges can find coordinates by ID
    const nodeMap = useMemo(() => {
      const map = new Map<string, GlobeNode>();
      nodes.forEach(n => map.set(n.id, n));
      return map;
    }, [nodes]);

    // Generate Fibonacci sphere dots once (or when dotCount changes)
    useEffect(() => {
      const dots: [number, number, number][] = [];
      const golden = (1 + Math.sqrt(5)) / 2;
      for (let i = 0; i < dotCount; i++) {
        const theta = (2 * Math.PI * i) / golden;
        const phi = Math.acos(1 - (2 * (i + 0.5)) / dotCount);
        dots.push([
          Math.cos(theta) * Math.sin(phi),
          Math.cos(phi),
          Math.sin(theta) * Math.sin(phi),
        ]);
      }
      dotsRef.current = dots;
    }, [dotCount]);

    const draw = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // ---- Setup ----
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);

      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(w, h) * 0.38;
      const fov = 600;

      // ---- Theme colors (read from canvas element — respects full CSS cascade) ----
      // --border-secondary encodes each theme's signature RGB color as rgba(R,G,B,alpha).
      // withAlpha() strips that alpha and applies a new one, giving us the theme's
      // primary color at any opacity we choose. This is why the globe turns pink on rose,
      // purple on lavender, white on midnight, etc. automatically.
      // --accent-cyan / --accent-blue are NOT used — they never change per theme.
      const themeColor  = cssVar('--border-secondary', canvas);
      const borderColor = cssVar('--border-primary', canvas);

      // ---- Rotation ----
      if (!dragRef.current.active) {
        rotYRef.current += autoRotateSpeed;
      }
      timeRef.current += 0.015;
      const time = timeRef.current;
      const ry = rotYRef.current;
      const rx = rotXRef.current;

      ctx.clearRect(0, 0, w, h);

      // ---- Globe outline ----
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha(borderColor, 0.25);
      ctx.lineWidth = 1;
      ctx.stroke();

      // ---- Fibonacci dots ----
      const dots = dotsRef.current;
      for (let i = 0; i < dots.length; i++) {
        let [x, y, z] = dots[i];
        x *= radius; y *= radius; z *= radius;
        [x, y, z] = rotateX(x, y, z, rx);
        [x, y, z] = rotateY(x, y, z, ry);
        if (z > 0) continue; // back-face cull
        const [sx, sy] = project(x, y, z, cx, cy, fov);
        const depthAlpha = Math.max(0.08, 1 - (z + radius) / (2 * radius));
        const dotSize = 0.9 + depthAlpha * 0.7;
        ctx.beginPath();
        ctx.arc(sx, sy, dotSize, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(themeColor, depthAlpha * 0.7);
        ctx.fill();
      }

      // ---- Edges (arcs + animated particles) ----
      for (const edge of edges) {
        const fromNode = nodeMap.get(edge.from);
        const toNode = nodeMap.get(edge.to);
        if (!fromNode || !toNode) continue;

        const animated = edge.animated !== false;
        const edgeColor = edge.color ?? withAlpha(themeColor, 0.35);

        let [x1, y1, z1] = latLngToXYZ(fromNode.lat, fromNode.lng, radius);
        let [x2, y2, z2] = latLngToXYZ(toNode.lat, toNode.lng, radius);
        [x1, y1, z1] = rotateX(x1, y1, z1, rx);
        [x1, y1, z1] = rotateY(x1, y1, z1, ry);
        [x2, y2, z2] = rotateX(x2, y2, z2, rx);
        [x2, y2, z2] = rotateY(x2, y2, z2, ry);

        // Cull edges where both endpoints are on the back
        if (z1 > radius * 0.3 && z2 > radius * 0.3) continue;

        const [sx1, sy1] = project(x1, y1, z1, cx, cy, fov);
        const [sx2, sy2] = project(x2, y2, z2, cx, cy, fov);

        // Arc control point — elevated above sphere surface
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;
        const midZ = (z1 + z2) / 2;
        const midLen = Math.sqrt(midX * midX + midY * midY + midZ * midZ);
        const arcHeight = radius * 1.28;
        const [scx, scy] = project(
          (midX / midLen) * arcHeight,
          (midY / midLen) * arcHeight,
          (midZ / midLen) * arcHeight,
          cx, cy, fov,
        );

        ctx.beginPath();
        ctx.moveTo(sx1, sy1);
        ctx.quadraticCurveTo(scx, scy, sx2, sy2);
        ctx.strokeStyle = edgeColor;
        ctx.lineWidth = 1.1;
        ctx.stroke();

        // Traveling particle along the arc
        if (animated) {
          const t = (Math.sin(time * 1.2 + fromNode.lat * 0.1) + 1) / 2;
          const tx = (1 - t) * (1 - t) * sx1 + 2 * (1 - t) * t * scx + t * t * sx2;
          const ty = (1 - t) * (1 - t) * sy1 + 2 * (1 - t) * t * scy + t * t * sy2;
          ctx.beginPath();
          ctx.arc(tx, ty, 2, 0, Math.PI * 2);
          ctx.fillStyle = withAlpha(themeColor, 0.9);
          ctx.fill();
        }
      }

      // ---- Node markers ----
      for (const node of nodes) {
        const markerColor = node.color ?? themeColor;

        let [x, y, z] = latLngToXYZ(node.lat, node.lng, radius);
        [x, y, z] = rotateX(x, y, z, rx);
        [x, y, z] = rotateY(x, y, z, ry);
        if (z > radius * 0.1) continue; // cull back-face markers

        const [sx, sy] = project(x, y, z, cx, cy, fov);
        const pulse = Math.sin(time * 2 + node.lat) * 0.5 + 0.5;

        // Pulsing ring
        ctx.beginPath();
        ctx.arc(sx, sy, 4 + pulse * 4, 0, Math.PI * 2);
        ctx.strokeStyle = withAlpha(markerColor, 0.18 + pulse * 0.12);
        ctx.lineWidth = 1;
        ctx.stroke();

        // Solid dot
        ctx.beginPath();
        ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(markerColor, 0.9);
        ctx.fill();

        // Label
        if (node.label) {
          ctx.font = '10px system-ui, sans-serif';
          ctx.fillStyle = withAlpha(markerColor, 0.55);
          ctx.fillText(node.label, sx + 8, sy + 3);
        }
      }

      animRef.current = requestAnimationFrame(draw);
    }, [nodes, edges, nodeMap, autoRotateSpeed]);

    useEffect(() => {
      animRef.current = requestAnimationFrame(draw);
      return () => cancelAnimationFrame(animRef.current);
    }, [draw]);

    // ---- Pointer event handlers ----
    const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
      dragRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        startRotY: rotYRef.current,
        startRotX: rotXRef.current,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    }, []);

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!dragRef.current.active) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      rotYRef.current = dragRef.current.startRotY + dx * 0.005;
      rotXRef.current = Math.max(-1, Math.min(1, dragRef.current.startRotX + dy * 0.005));
    }, []);

    const onPointerUp = useCallback(() => {
      dragRef.current.active = false;
    }, []);

    return (
      <div ref={ref} className={cn('relative w-full h-full', className)}>
        <canvas
          ref={canvasRef}
          className="w-full h-full cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </div>
    );
  },
);

Globe.displayName = 'Globe';
