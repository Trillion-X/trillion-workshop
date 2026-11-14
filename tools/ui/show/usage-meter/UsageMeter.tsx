// parts/ui/show/usage-meter/UsageMeter.tsx
//
// PURPOSE
//   How a whole is split: one rounded bar cut into proportional segments, each a colour, with a legend under it that
//   names every segment with its value and share (the Mintlify usage legend: a dot, a name, the amount, the share).
//   Used for a disk's taken and free space and for what kinds of files fill it. Adapted from "Partition Bar"
//   (21st.dev component 26545, by 8starlabs), see provenance.json.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Domain-blind: segments are an id, a label, an amount, the words to show for the amount, and a tone; the meter
//      never knows what is being measured.
//   2. A segment's share is its amount over `total` (or over the sum of the segments when no total is given); a share
//      too small to see still gets a hairline so it is not lost, and the legend still lists it.
//   3. Tones are named colour roles from the shared look (`--usage-meter-<tone>` in screen-look usage-meter.css), so a
//      new kind of thing is a DATA tone, never a colour written here.
//   4. The bar grows from the left when it first appears, unless reduced motion is asked for.

import * as React from 'react';
import { m as motion, useReducedMotion } from 'framer-motion';
import { MotionFeatures } from 'trillion-workshop/tools/ui/motion/lazy-motion.tsx'
import { cn } from '../cn';

export type UsageSegment = {
  id: string;
  label: string;
  amount: number;
  /** The amount as words, such as "1.2 TB". */
  words: string;
  /** A tone from the shared look: `used`, `free`, or a palette tone `1` to `10`. */
  tone: string;
};

export type UsageMeterProps = {
  segments: UsageSegment[];
  /** The whole the segments are shares of; the sum of the segments when absent. */
  total?: number;
  label: string;
  size?: 'sm' | 'md';
  /** Show the legend under the bar. */
  legend?: boolean;
  /** Show each segment's share in the legend. */
  shares?: boolean;
  className?: string;
};

const percentOf = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
const shareWords = (percent: number) => (percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`);

function UsageMeterMoving({ segments, total, label, size = 'md', legend = true, shares = true, className }: UsageMeterProps) {
  const reduced = useReducedMotion();
  const whole = total ?? segments.reduce((sum, segment) => sum + segment.amount, 0);
  const shown = segments.filter(segment => segment.amount > 0);
  return (
    <div className={cn('usage-meter flex flex-col gap-2', className)} data-size={size}>
      <div role="img" aria-label={`${label}: ${shown.map(segment => `${segment.label} ${segment.words}`).join(', ')}`} className="usage-meter-track flex w-full gap-[2px] overflow-hidden rounded-full">
        {shown.map((segment, index) => (
          <motion.div
            key={segment.id}
            title={`${segment.label}: ${segment.words}`}
            className="usage-meter-segment h-full"
            data-tone={segment.tone}
            initial={reduced ? false : { scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 32, delay: index * 0.04 }}
            style={{ flexBasis: `${percentOf(segment.amount, whole)}%`, flexGrow: 0, flexShrink: 0, minWidth: 3, transformOrigin: 'left center' }}
          />
        ))}
      </div>
      {legend ? (
        <ul className="usage-meter-legend flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={label}>
          {segments.map(segment => (
            <li key={segment.id} className="inline-flex items-center gap-1.5">
              <span className="usage-meter-dot size-2 shrink-0 rounded-full" data-tone={segment.tone} aria-hidden="true"/>
              <span className="text-muted-foreground">{segment.label}</span>
              <span className="font-medium tabular-nums">{segment.words}</span>
              {shares ? <span className="text-muted-foreground tabular-nums">({shareWords(percentOf(segment.amount, whole))})</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Drawn inside MotionFeatures (ui/motion/lazy-motion.tsx): its motion arrives after the first paint, without remounting.
export function UsageMeter(props: React.ComponentProps<typeof UsageMeterMoving>) {
  return <MotionFeatures><UsageMeterMoving {...props} /></MotionFeatures>;
}
