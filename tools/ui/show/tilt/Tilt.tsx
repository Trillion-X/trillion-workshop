'use client';

import React, { useRef } from 'react';
import {useMotionTemplate, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionStyle, type SpringOptions} from 'framer-motion';
import { motion } from 'trillion-workshop/tools/ui/motion/lazy-motion.tsx';

export type TiltProps = {
  children: React.ReactNode;
  className?: string;
  style?: MotionStyle;
  rotationFactor?: number;
  reverse?: boolean;
  /** @deprecated Upstream compatibility alias. Prefer `reverse`. */
  isRevese?: boolean;
  springOptions?: SpringOptions;
};

export function normalizeTiltPointerPosition(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: (clientX - rect.left) / rect.width - 0.5,
    y: (clientY - rect.top) / rect.height - 0.5,
  };
}

export function Tilt({
  children,
  className,
  style,
  rotationFactor = 15,
  reverse,
  isRevese = false,
  springOptions,
}: TiltProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const shouldReverse = reverse ?? isRevese;

  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const xSpring = useSpring(x, springOptions);
  const ySpring = useSpring(y, springOptions);

  const rotateX = useTransform(
    ySpring,
    [-0.5, 0.5],
    shouldReverse
      ? [rotationFactor, -rotationFactor]
      : [-rotationFactor, rotationFactor]
  );
  const rotateY = useTransform(
    xSpring,
    [-0.5, 0.5],
    shouldReverse
      ? [-rotationFactor, rotationFactor]
      : [rotationFactor, -rotationFactor]
  );

  const transform = useMotionTemplate`perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;

  const reset = () => {
    x.set(0);
    y.set(0);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ref.current || reducedMotion || e.pointerType !== 'mouse') return;

    const rect = ref.current.getBoundingClientRect();
    const position = normalizeTiltPointerPosition(e.clientX, e.clientY, rect);
    if (!position) return;

    x.set(position.x);
    y.set(position.y);
  };

  return (
    <motion.div
      ref={ref}
      className={className}
      style={{
        transformStyle: 'preserve-3d',
        ...style,
        transform: reducedMotion ? 'none' : transform,
      }}
      onPointerMove={handlePointerMove}
      onPointerLeave={reset}
      onBlur={reset}
    >
      {children}
    </motion.div>
  );
}
