// packages/ui/show/timeline/Timeline.tsx
//
// A vertical connected timeline (Vibecode "publish your app" / Alan / Hers
// anatomy): an ordered list of steps, each a glowing IconTile badge on a
// connecting vertical rail, with an optional time label, a title, and a detail.
// Generic + data-driven: it paints already-resolved TimelineItemView[] and knows
// no domain — a pre-match routine, a recovery protocol, an onboarding checklist,
// a morning ritual are all the same component, different items (L069/L090).
//
// Pure presentation. Composes the shared IconTile (with its `glow` badge) + Text;
// the only bespoke element is the 1px connecting rail between markers, which is
// legitimate primitive-level styling (this IS a `ui` primitive, the styling
// floor — like PathNode). The last step draws no trailing rail.

import * as React from 'react';

import { cn } from '../cn';
import { IconTile } from '../icon-tile/IconTile';
import { Text } from '../text';
import type { LucideIcon } from 'lucide-react';

type IconTileTone = React.ComponentProps<typeof IconTile>['tone'];

export interface TimelineItemView {
  id: string;
  /** Badge icon; absent → a plain dot marker (never a fabricated icon). */
  icon?: LucideIcon;
  /** Badge tone (defaults to accent). */
  tone?: IconTileTone;
  /** Small label above the title, e.g. "60 MIN BEFORE". */
  time?: string;
  title: string;
  detail?: string;
}

export interface TimelineProps {
  items: TimelineItemView[];
  className?: string;
}

const RAIL_COLOR = 'var(--border-subtle, rgba(255,255,255,0.14))';
const DOT_COLOR = 'var(--text-muted, rgba(255,255,255,0.45))';

export function Timeline({ items, className }: TimelineProps) {
  return (
    <div className={cn('flex w-full flex-col', className)} data-ui="timeline">
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <div key={item.id} className="flex gap-4" data-timeline-item={item.id}>
            {/* Marker rail: the badge, then a connecting line down to the next. */}
            <div className="flex flex-col items-center">
              {item.icon ? (
                <IconTile icon={item.icon} tone={item.tone ?? 'accent'} size="md" glow label={item.time ?? item.title} />
              ) : (
                <span
                  aria-hidden
                  style={{
                    width: 12,
                    height: 12,
                    marginTop: 6,
                    borderRadius: '9999px',
                    background: DOT_COLOR,
                    boxShadow: '0 0 0 4px var(--surface-nested, rgba(255,255,255,0.05))',
                  }}
                />
              )}
              {!isLast && (
                <span
                  aria-hidden
                  style={{ flex: 1, width: 2, marginTop: 8, marginBottom: 8, borderRadius: 2, background: RAIL_COLOR }}
                />
              )}
            </div>

            {/* Content: time + title + detail. */}
            <div className={cn('flex flex-col gap-1', isLast ? undefined : 'pb-7')}>
              {item.time ? (
                <Text variant="label" color="accent">
                  {item.time}
                </Text>
              ) : null}
              <Text variant="heading-xs">{item.title}</Text>
              {item.detail ? (
                <Text variant="body" color="muted">
                  {item.detail}
                </Text>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
