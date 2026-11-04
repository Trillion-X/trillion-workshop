// parts/ui/motion/lazy-motion.tsx
//
// PURPOSE
//   Motion for parts that draw on the page's first paint. They draw with framer-motion's small `m` components inside
//   MotionFeatures, which fetches the animation and layout features (motion-features.ts) once, after the page has
//   started: the first paint shows every element where it belongs, and movement begins as soon as the features arrive.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One fetch for the whole page: every MotionFeatures shares it.
//   2. Nothing remounts when the features arrive; the same elements start to move.
//   3. `motion` here is framer-motion's `motion` for every part outside Reorder (which needs the whole library and is
//      itself fetched later, drag-reorder-list/SortableRowsMoving.tsx).

import React from 'react';
import { LazyMotion, m } from 'framer-motion';

const features = () => import('./motion-features').then(module => module.default);

export function MotionFeatures({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={features}>{children}</LazyMotion>;
}

// `motion.div` and the rest, each drawing inside MotionFeatures itself, so a part names `motion` as it always has and
// still carries only the small `m` element until the features arrive.
const wrapped = new Map<string, unknown>();
export const motion = new Proxy({} as typeof m, {
  get(_target, tag: string) {
    if (!wrapped.has(tag)) {
      const Element = (m as unknown as Record<string, React.ElementType>)[tag];
      const Wrapped = React.forwardRef<unknown, Record<string, unknown>>(function Moving(props, ref) {
        return <LazyMotion features={features}><Element {...props} ref={ref} /></LazyMotion>;
      });
      Wrapped.displayName = `motion.${tag}`;
      wrapped.set(tag, Wrapped);
    }
    return wrapped.get(tag);
  },
});
