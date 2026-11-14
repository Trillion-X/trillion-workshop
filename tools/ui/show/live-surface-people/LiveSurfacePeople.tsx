// packages/ui/show/live-surface-people/LiveSurfacePeople.tsx
//
// Pure visual projection for people concurrently using one mounted surface.
// The caller owns identity resolution, transport, authorization, coordinates,
// selection references, and lifecycle. This module only paints already-resolved
// view data and therefore remains removable from the collaboration substrate.

import React from 'react';
import { MousePointer2 } from 'lucide-react';

import { AvatarGroup } from '../avatar-group';
import { DisplayMark } from '../display-mark';
import { Container } from '../container';
import { Icon } from '../icon';
import { Text } from '../text';

export interface LiveSurfacePoint {
  readonly x: number;
  readonly y: number;
}

export interface LiveSurfaceBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LiveSurfacePersonView {
  readonly key: string;
  readonly label: string;
  readonly color?: string;
  readonly point?: LiveSurfacePoint;
  readonly selectedRefs?: readonly string[];
}

export type LiveSurfaceBoundsSource =
  | ReadonlyMap<string, LiveSurfaceBounds>
  | ((reference: string) => LiveSurfaceBounds | undefined);

export interface LiveSurfacePeopleOverlayProps {
  readonly people: readonly LiveSurfacePersonView[];
  readonly bounds?: LiveSurfaceBoundsSource;
}

export interface LiveSurfacePeopleRosterProps {
  readonly people: readonly LiveSurfacePersonView[];
  readonly label?: string;
  readonly max?: number;
  readonly onOpen?: () => void;
}

const DEFAULT_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#059669',
  '#0891b2',
  '#4f46e5',
] as const;

export function stableLiveSurfaceColor(key: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return DEFAULT_COLORS[hash % DEFAULT_COLORS.length] ?? DEFAULT_COLORS[0];
}

function colorOf(person: LiveSurfacePersonView): string {
  return person.color ?? stableLiveSurfaceColor(person.key);
}

function boundsFor(
  source: LiveSurfaceBoundsSource | undefined,
  reference: string,
): LiveSurfaceBounds | undefined {
  if (!source) return undefined;
  return typeof source === 'function' ? source(reference) : source.get(reference);
}

function SelectionOutline({
  bounds,
  color,
}: {
  bounds: LiveSurfaceBounds;
  color: string;
}) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute rounded-[10px] border-2"
      style={{
        borderColor: color,
        height: bounds.height + 6,
        left: bounds.x - 3,
        top: bounds.y - 3,
        width: bounds.width + 6,
      }}
    />
  );
}

function PersonPoint({ person, color }: { person: LiveSurfacePersonView; color: string }) {
  if (!person.point) return null;
  return (
    <span
      aria-label={`${person.label} is here`}
      className="pointer-events-none absolute inline-flex items-start"
      style={{ color, left: person.point.x, top: person.point.y }}
    >
      <Icon icon={MousePointer2} size="sm" aria-hidden="true" />
      <span
        className="ml-0.5 mt-2 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium text-white shadow-sm"
        style={{ backgroundColor: color }}
      >
        {person.label}
      </span>
    </span>
  );
}

export function LiveSurfacePeopleOverlay({
  people,
  bounds,
}: LiveSurfacePeopleOverlayProps) {
  return (
    <div
      aria-label="People here"
      className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
    >
      {people.map((person) => {
        const color = colorOf(person);
        return (
          <React.Fragment key={person.key}>
            {(person.selectedRefs ?? []).map((reference) => {
              const selectedBounds = boundsFor(bounds, reference);
              return selectedBounds ? (
                <SelectionOutline
                  key={`${person.key}:${reference}`}
                  bounds={selectedBounds}
                  color={color}
                />
              ) : null;
            })}
            <PersonPoint person={person} color={color} />
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function LiveSurfacePeopleRoster({
  people,
  label = 'People here',
  max = 4,
  onOpen,
}: LiveSurfacePeopleRosterProps) {
  if (people.length === 0) return null;
  const items = people.map((person) => ({
    key: person.key,
    // The shared person mark, in the person's own live colour (the same colour as their cursor).
    node: <DisplayMark spec={{ name: person.label, tint: { background: colorOf(person), foreground: '#fff' } }} size="sm" />,
  }));

  return (
    <Container layout="horizontal" gap="sm" alignItems="center" aria-label={label}>
      <AvatarGroup
        ariaLabel={label}
        items={items}
        size="sm"
        max={max}
        onClick={onOpen}
        onOverflowClick={onOpen}
      />
      <Text variant="body-sm" tone="muted">
        {people.length === 1 ? '1 person here' : `${people.length} people here`}
      </Text>
    </Container>
  );
}
