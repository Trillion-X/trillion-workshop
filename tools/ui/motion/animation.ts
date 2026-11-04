// PORTED FROM: bitfield-packages/packages/ui/motion/animation.ts @ e99ac5976
// packages/ui/motion/animation.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Browser-local motion primitives shared by interactive UI components.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Reusable transitions only — no feature-specific business logic
// 2. Reduced-motion handling stays at the callsite
// 3. Shared collapse behavior remains single-sourced
//
// =============================================================================

import { type Transition, type Variants } from 'framer-motion';
import { MOTION } from '../../screen-look/read-data/resolve-screen-look-palette';

// The look's motion (screen-look's MOTION, the same numbers its CSS variables carry), in framer's seconds and curves.
const seconds = (name: keyof typeof MOTION.durations): number => MOTION.durations[name] / 1000;
const enter = MOTION.curves.enter as [number, number, number, number];
const exit = MOTION.curves.exit as [number, number, number, number];

export const springMedium: Transition = {
  type: 'spring',
  stiffness: 400,
  damping: 25,
};

export const springFast: Transition = {
  type: 'spring',
  stiffness: 600,
  damping: 30,
};

export const collapseVariants: Variants = {
  open: {
    height: 'auto',
    opacity: 1,
    y: 0,
    transition: {
      height: { duration: seconds('base'), ease: enter },
      opacity: { duration: seconds('fast'), ease: enter },
      y: { duration: seconds('fast'), ease: enter },
    },
  },
  collapsed: {
    height: 0,
    opacity: 0,
    y: -2,
    transition: {
      height: { duration: seconds('base'), ease: exit },
      opacity: { duration: seconds('fast'), ease: exit },
      y: { duration: seconds('fast'), ease: exit },
    },
  },
};

export const collapseVariantsReduced: Variants = {
  open: { height: 'auto', opacity: 1, y: 0, transition: { duration: 0 } },
  collapsed: { height: 0, opacity: 0, y: 0, transition: { duration: 0 } },
};
