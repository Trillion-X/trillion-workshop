import React from 'react';
import type {
  MarkCoordinatePoint,
  MarkMaterialPath,
  MarkOperationRecord,
  MarkStyleRecord,
  MarkTarget,
  MarkToolRecord,
} from '../read-data/addressed-marks';
import { mapPointsForTool, materializeMarkRecords, nearestMarkPathRef, toolEmitsClosedSet, toolErases } from '../read-data/addressed-marks';
import type { MarkOperationWrite } from '../do-work/record-mark-operation';
import { inkOpacity, type InkFade } from '../read-data/ink-fade';
import { VisualLayerStack, createCapabilityMap, builtinVisualLayerCapabilities, isVisualLayerStackRecord } from '../../ui/show/visual-layer-stack';
import type { VisualLayerStackRecord, AddressRef } from '../../ui/show/visual-layer-stack';

export interface AddressedMarkLayerProps {
  target: MarkTarget;
  operations: readonly MarkOperationRecord[];
  styles?: readonly MarkStyleRecord[];
  selectedStyleRef?: string;
  selectedToolRef?: string;
  /** The tool records `selectedToolRef` is read from: a tool's mapper shapes the stroke (line, rectangle, ellipse)
   *  and an erasing tool hides the paths it passes over. Without tools, every stroke is freehand ink. */
  tools?: readonly MarkToolRecord[];
  /** How close (in the target's coordinate units) an erasing stroke must pass to hide a path. */
  eraseRadius?: number;
  onRecordOperation?: (operation: MarkOperationWrite) => void;
  coordinateFromPointer?: (event: React.PointerEvent<SVGSVGElement>) => MarkCoordinatePoint;
  interactive?: boolean;
  viewBox?: string;
  ariaLabel?: string;
  className?: string;
  /** When given, a mark is drawn at the opacity ink-fade.ts gives it and not drawn once gone (live annotations that fade).
   *  The records are untouched: a faded mark is still the person's record. */
  fade?: InkFade;
}

function coordinateFromPointer(event: React.PointerEvent<SVGSVGElement>): MarkCoordinatePoint {
  const rect = event.currentTarget.getBoundingClientRect();
  const width = rect.width || 1;
  const height = rect.height || 1;
  return {
    values: [
      Math.min(1, Math.max(0, (event.clientX - rect.left) / width)),
      Math.min(1, Math.max(0, (event.clientY - rect.top) / height)),
    ],
  };
}

function coordinateValue(point: MarkCoordinatePoint, index: number): number {
  const value = point.values[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function pathData(points: readonly MarkCoordinatePoint[], closed?: boolean): string {
  return points
    .map((point, index) => {
      const command = index === 0 ? 'M' : 'L';
      return `${command} ${coordinateValue(point, 0).toFixed(5)} ${coordinateValue(point, 1).toFixed(5)}`;
    })
    .join(' ')
    .concat(closed ? ' Z' : '');
}

function strokeFor(style: MarkStyleRecord | null): string {
  if (style?.stroke) return style.stroke;
  if (style?.strokeToken) return `var(${style.strokeToken})`;
  return 'var(--color-info)';
}

/**
 * Stroke widths are READER SCREEN PIXELS: every mark path renders with
 * vector-effect: non-scaling-stroke, so the width survives normalized tab
 * frames, world camera zoom, and any future coordinate frame unchanged.
 * Style records must author px values (e.g. 3), never frame fractions.
 */
function strokeWidthFor(style: MarkStyleRecord | null): number {
  return style?.strokeWidth ?? 3;
}

function MarkPath({ path, scale = 1 }: { path: MarkMaterialPath; scale?: number }) {
  return React.createElement('path', {
    d: pathData(path.coordinateSet.points, path.coordinateSet.closed),
    'data-mark-ref': path.ref,
    fill: 'none', // Stroke only; fill is rendered via clip-path + VisualLayerStack
    stroke: strokeFor(path.style),
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    strokeOpacity: (path.style?.strokeOpacity ?? 1) * scale,
    strokeWidth: strokeWidthFor(path.style),
    vectorEffect: 'non-scaling-stroke',
  });
}

/**
 * Render a single mark path's fill decoration via clip-path + VisualLayerStack.
 * The mark's SVG path provides the stroke outline and clip geometry; a DOM div
 * renders the capability-driven fill layers clipped to the path shape.
 */
function MarkFillLayer({
  path,
  svgRef,
}: {
  path: MarkMaterialPath;
  svgRef: React.RefObject<SVGSVGElement>;
}) {
  const decoration = path.style?.decoration;
  if (!isVisualLayerStackRecord(decoration)) {
    return null; // No decoration or invalid structure
  }

  const pathD = pathData(path.coordinateSet.points, path.coordinateSet.closed);

  // Capability map: mark uses the same builtin registry as regions
  const capabilityMap = React.useMemo(() => createCapabilityMap(builtinVisualLayerCapabilities), []);

  // Region address for the stack (mark-scoped; the registry doesn't need to resolve subjects)
  const markRegion: AddressRef = {
    family: 'addressed-marks.fill',
    parts: { pathRef: path.ref },
  };

  // Stub subject resolver: marks don't support addressed subjects
  const resolveSubject = React.useCallback((): unknown => null, []);

  const fillDiv = React.createElement(
    'div',
    {
      key: `fill:${path.ref}`,
      style: {
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        // Clip to the path shape via CSS clip-path
        // pathD is a valid SVG path string; CSS clip-path(path(...)) interprets it
        clipPath: `path('${pathD.replace(/'/g, "\\'")}')`,
        pointerEvents: 'none',
      },
    },
    // Render the visual-layer-stack via the capability registry (blind to capability kinds)
    React.createElement(VisualLayerStack, {
      record: { ...decoration, region: markRegion },
      map: capabilityMap,
      resolveSubject,
    }),
  );

  return fillDiv;
}

export function AddressedMarkLayer({
  target,
  operations,
  styles = [],
  selectedStyleRef = styles[0]?.id,
  selectedToolRef = 'tool:draw',
  tools = [],
  eraseRadius = 0.02,
  onRecordOperation,
  coordinateFromPointer: readPointerCoordinate = coordinateFromPointer,
  interactive = true,
  viewBox = '0 0 1 1',
  ariaLabel = 'Draw',
  className,
  fade,
}: AddressedMarkLayerProps) {
  const [draft, setDraft] = React.useState<readonly MarkCoordinatePoint[]>([]);
  const drawn = materializeMarkRecords({ operations, styles, target });
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!fade) return undefined;
    const timer = setInterval(() => setNow(Date.now()), fade.tick_ms);
    return () => clearInterval(timer);
  }, [fade?.tick_ms, fade?.hold_ms, fade?.fade_ms]);
  const seen = (path: MarkMaterialPath) => (fade ? inkOpacity(path.operation.createdAt, now, fade) : 1);
  const material = fade ? { ...drawn, paths: drawn.paths.filter((path) => seen(path) > 0) } : drawn;
  const svgRef = React.useRef<SVGSVGElement>(null);
  const tool = tools.find((row) => row.id === selectedToolRef);

  const start = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!interactive) return;
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDraft([readPointerCoordinate(event)]);
  };

  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!interactive) return;
    if (!draft.length) return;
    const point = readPointerCoordinate(event);
    setDraft((points) => [...points, point]);
  };

  const end = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!interactive) return;
    if (!draft.length) return;
    const points = [...draft, readPointerCoordinate(event)];
    setDraft([]);
    if (points.length < 2) return;
    const id = `mark:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
    const createdAt = new Date().toISOString();
    if (toolErases(tool)) {
      const hidden = new Set<string>();
      for (const point of points) {
        const ref = nearestMarkPathRef(material, point, eraseRadius);
        if (ref) hidden.add(ref);
      }
      if (!hidden.size) return;
      onRecordOperation?.({ id, target, toolRef: selectedToolRef, createdAt, body: { coordinate_sets: [], effects: { hide_refs: [...hidden] } } });
      return;
    }
    onRecordOperation?.({
      id,
      target,
      toolRef: selectedToolRef,
      styleRef: selectedStyleRef,
      createdAt,
      body: {
        coordinate_sets: [
          {
            id: 'path:0',
            closed: toolEmitsClosedSet(tool),
            points: mapPointsForTool(tool, points).map((point) => ({ values: [...point.values] })),
          },
        ],
        effects: {},
      },
    });
  };

  return React.createElement(
    'svg',
    {
      ref: svgRef,
      'aria-label': ariaLabel,
      className,
      'data-testid': 'addressed-mark-layer',
      onPointerDown: interactive ? start : undefined,
      onPointerMove: interactive ? move : undefined,
      onPointerUp: interactive ? end : undefined,
      role: interactive ? 'application' : 'img',
      viewBox,
      preserveAspectRatio: 'none',
      overflow: 'visible',
    },
    // Background for interactivity (transparent hit surface)
    interactive ? React.createElement('rect', { width: '100%', height: '100%', fill: 'transparent' }) : null,
    // Fill layers (DOM divs with clip-path, rendered via capability registry)
    material.paths.map((path) => React.createElement(MarkFillLayer, { key: `fill:${path.ref}`, path, svgRef })),
    // Stroke paths (pure SVG, overlaid on top of fills)
    material.paths.map((path) => React.createElement(MarkPath, { key: path.ref, path, scale: seen(path) })),
    // Draft stroke (during active drawing)
    draft.length > 1 && !toolErases(tool)
      ? React.createElement('path', {
          d: pathData(mapPointsForTool(tool, draft), toolEmitsClosedSet(tool)),
          fill: 'none',
          stroke: strokeFor(styles.find((style) => style.id === selectedStyleRef) ?? null),
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          strokeWidth: strokeWidthFor(styles.find((style) => style.id === selectedStyleRef) ?? null),
          vectorEffect: 'non-scaling-stroke',
        })
      : null,
  );
}
