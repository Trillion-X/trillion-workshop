// parts/ui/show/spinner/Spinner.tsx
//
// PURPOSE
//   The small inline "working on it" mark (a pressed button, a file opening, a panel reading): the one loading
//   animation, the needle and thread (../loading-mark), at a size that sits beside words. There is no other spinner.

import React from 'react';
import { LoadingMark, type LoadingMarkSize } from 'trillion-workshop/tools/ui/show/loading-mark/index.ts';

export interface SpinnerProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children' | 'role'> {
  /** sm beside words in a button, md in a panel, lg over a canvas. */
  size?: LoadingMarkSize;
  /** What is being waited for; omit (or set aria-hidden) when words beside it already say so. */
  'aria-label'?: string;
}

/** The needle and thread, small. */
export const Spinner: React.FC<SpinnerProps> = ({ size = 'sm', 'aria-label': label, 'aria-hidden': hidden, ...rest }) => (
  <LoadingMark {...rest} size={size} label={hidden ? undefined : label ?? 'Loading'} />
);

Spinner.displayName = 'Spinner';
