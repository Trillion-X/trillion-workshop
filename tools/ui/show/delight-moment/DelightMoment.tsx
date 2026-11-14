// parts/ui/show/delight-moment/DelightMoment.tsx
//
// NO PRIOR: searched bitfield-packages/packages/*/show for "confetti", "celebrat" and "delight" (only
// destination-surface's per-screen celebration of finished items, not a shared player) and the 21st.dev MCP for
// "celebration toast with confetti sparks" (Confetti by motiondotdev, Burst by tinkerers-labs, Party Popper).
//
// PURPOSE
//   Plays one small good moment at the bottom of the screen: a mark that turns and settles, a ring of sparks around it
//   and one line of words, then it fades away by itself. What the motion is, how many sparks fly and the words are all
//   the caller's DATA (parts/delight-moments reads them from records/delight-moments.json); this part knows no moment,
//   no event and no product. Anatomy from 21st.dev "Confetti" (motiondotdev) and "Burst" (tinkerers-labs) and the
//   Descript and Dropbox Dash "You're all set" screens on Mobbin, kept small so it never covers work.
//
// NON-NEGOTIABLE INVARIANTS
//   1. It never takes focus, never blocks a click (pointer-events none) and never plays a sound.
//   2. Reduced motion shows the words at once, with no turning mark and no sparks, for the same time.
//   3. The words are read once by screen readers (role status, polite); the mark and sparks are hidden from them.
//   4. `onDone` runs once, after the card's own animation ends, so the next moment can play.
//
// APPEARANCE
//   screen-look/show/delight-moment.css.
//
// The extensive documentation in this codebase is a critical design feature. You are forbidden from simplifying
// or removing it.

import React, { useMemo } from 'react';
import {useReducedMotion, type TargetAndTransition, type Transition} from 'framer-motion';
import { motion } from 'trillion-workshop/tools/ui/motion/lazy-motion.tsx';

/** How a moment moves: the card's and the mark's motion, and the sparks that fly from the mark. */
export type DelightMotion = {
  card: { initial?: TargetAndTransition; animate: TargetAndTransition; transition: Transition };
  mark?: { animate: TargetAndTransition; transition: Transition };
  sparks?: number;
  spark_distance?: number;
  spark_duration?: number;
};

export type DelightMomentProps = {
  /** A short mark drawn beside the words (a star, a check). */
  mark: string;
  /** The one line the person reads. */
  words: string;
  motion: DelightMotion;
  /** Runs once when the moment has finished playing. */
  onDone: () => void;
};

export function DelightMoment({ mark, words, motion: spec, onDone }: DelightMomentProps) {
  const reduced = useReducedMotion();
  const total = Number((spec.card.transition as { duration?: number }).duration ?? 3);
  const sparks = useMemo(() => {
    const count = reduced ? 0 : Math.max(0, Math.floor(spec.sparks ?? 0));
    const distance = spec.spark_distance ?? 56;
    return Array.from({ length: count }, (_, at) => {
      const angle = (at / Math.max(count, 1)) * Math.PI * 2 + (at % 2 ? 0.2 : -0.1);
      const reach = distance * (at % 3 === 0 ? 1 : 0.72);
      return { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach, hue: at % 4 };
    });
  }, [reduced, spec.sparks, spec.spark_distance]);
  const card = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: [0, 1, 1, 0] }, transition: { duration: total, times: [0, 0.05, 0.92, 1] } }
    : spec.card;
  return (
    <motion.div className="delight-moment" data-delight-moment="" initial={card.initial} animate={card.animate} transition={card.transition} onAnimationComplete={onDone}>
      <motion.span className="delight-moment-mark" aria-hidden="true" animate={reduced ? undefined : spec.mark?.animate} transition={spec.mark?.transition}>
        {mark}
        {sparks.map((spark, at) => (
          <motion.span
            key={at}
            className="delight-moment-spark"
            data-hue={spark.hue}
            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
            animate={{ x: spark.x, y: spark.y, opacity: 0, scale: 0.4 }}
            transition={{ duration: spec.spark_duration ?? 1, ease: [0.22, 1, 0.36, 1], delay: 0.08 }}
          />
        ))}
      </motion.span>
      <motion.span className="delight-moment-words" role="status" aria-live="polite">{words}</motion.span>
    </motion.div>
  );
}

/** The fixed place moments play in, low and centred on the screen; draws nothing while no moment plays. */
export function DelightMomentLayer({ moment, onDone }: { moment: (Omit<DelightMomentProps, 'onDone'> & { key: string }) | null; onDone: () => void }) {
  if (!moment) return null;
  return (
    <motion.div className="delight-moment-layer" data-delight-moment-layer="">
      <DelightMoment key={moment.key} mark={moment.mark} words={moment.words} motion={moment.motion} onDone={onDone} />
    </motion.div>
  );
}
