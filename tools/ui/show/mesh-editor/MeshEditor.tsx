// packages/ui/show/mesh-editor/MeshEditor.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The editor for the `mesh` visual-layer capability: a mesh gradient is a base
// color with N colored POINTS, each a soft radial blob at (x%, y%). The user
// drags points around a live preview, recolors the selected point, and adds/
// removes points. It composes the CSS `background-image` (a stack of
// radial-gradients) the capability paints.
//
// Like GradientEditor, it edits STRUCTURE (points + baseColor) and the render
// composes from that structure — no css parsing. value-in / patch-out,
// storage-blind.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. ui/ leaf — raw elements + className legal here.
// 2. No magic palette — initial points come from the layer input (caller DATA).
// 3. The blob technique (stacked radial-gradients) is a CSS-substrate fact, not a
//    product preference.
// =============================================================================

import React from 'react';
import { cn } from '../cn';
import { ColorWheel } from '../color-wheel/ColorWheel';
import { readMeshValue, type MeshPoint, type MeshValue } from './mesh-value';

// The value and its CSS live in ./mesh-value.ts, so a layer that only draws a mesh never carries this editor.
export { composeMeshBackground, readMeshValue } from './mesh-value';
export type { MeshPoint, MeshValue } from './mesh-value';

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

export interface MeshEditorProps {
  readonly input: Record<string, unknown>;
  readonly onPatch: (patch: Record<string, unknown>) => void;
}

export function MeshEditor({ input, onPatch }: MeshEditorProps) {
  const value = readMeshValue(input);
  const [selected, setSelected] = React.useState(0);
  const [dragging, setDragging] = React.useState<number | null>(null);
  const boxRef = React.useRef<HTMLDivElement | null>(null);

  const commit = (next: MeshValue) => {
    onPatch({ baseColor: next.baseColor, points: next.points, css: composeMeshBackground(next.points) });
  };

  const moveSelectedTo = (clientX: number, clientY: number, index: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const x = clamp(((clientX - rect.left) / rect.width) * 100);
    const y = clamp(((clientY - rect.top) / rect.height) * 100);
    commit({ ...value, points: value.points.map((p, i) => (i === index ? { ...p, x, y } : p)) });
  };

  const setPointColor = (hex: string) => {
    commit({ ...value, points: value.points.map((p, i) => (i === selected ? { ...p, color: hex } : p)) });
  };
  const addPoint = () => {
    const points = [...value.points, { x: 50, y: 50, color: '#ffffff' }];
    commit({ ...value, points });
    setSelected(points.length - 1);
  };
  const removePoint = (index: number) => {
    if (value.points.length <= 2) return;
    const points = value.points.filter((_, i) => i !== index);
    commit({ ...value, points });
    setSelected(Math.max(0, Math.min(selected, points.length - 1)));
  };

  const current = value.points[selected] ?? value.points[0];

  return (
    <div className="flex w-56 flex-col gap-2">
      {/* live preview + draggable point handles */}
      <div
        ref={boxRef}
        className="relative h-28 w-full overflow-hidden rounded-lg border border-[var(--border-primary)]"
        style={{ backgroundColor: value.baseColor, backgroundImage: composeMeshBackground(value.points) }}
        onPointerMove={(e) => {
          if (dragging !== null) moveSelectedTo(e.clientX, e.clientY, dragging);
        }}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
      >
        {value.points.map((p, i) => (
          <button
            key={i}
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              setSelected(i);
              setDragging(i);
            }}
            onDoubleClick={() => removePoint(i)}
            aria-label={`Point ${i + 1}${i === selected ? ' (selected)' : ''}`}
            title="Drag to move · double-click to remove"
            className={cn(
              'absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 shadow active:cursor-grabbing',
              i === selected ? 'border-white ring-2 ring-[var(--accent-primary)]' : 'border-white/70',
            )}
            style={{ left: `${p.x}%`, top: `${p.y}%`, background: p.color }}
          />
        ))}
      </div>

      <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
        <span>{value.points.length} points</span>
        <button
          type="button"
          onClick={addPoint}
          className="rounded-md border border-dashed border-[var(--border-primary)] px-2 py-0.5 hover:text-[var(--text-primary)]"
        >
          + Add point
        </button>
      </div>

      {/* selected point color */}
      <ColorWheel value={current?.color ?? '#ffffff'} onChange={setPointColor} size={150} />
    </div>
  );
}
