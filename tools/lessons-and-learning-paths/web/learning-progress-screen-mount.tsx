// tools/lessons-and-learning-paths/web/learning-progress-screen-mount.tsx
//
// PURPOSE
//   The learner progress screen (tool:work-out-where-a-learner-stands' screen) as a screen module: the one file the
//   screen's row names (`screen.module.entry`), whose single export, `mount(element, props)`, is the contract of the
//   module kind (web/src/workspace/tool-screen.tsx). The screen itself is ../packages/learning-progress/show/
//   LearningProgressSurface.tsx, moved here from bitfield-packages (moved-from.json) and edited where it called the
//   retired Bitfield runtime (README.md lists each call). This file hands it the learner and the practice action the
//   screen's input names; it takes the place of the retired package entry (mount-learning-progress.tsx), which is not
//   carried.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The practice action is a tool the input names (`practice_action.tool`) and the payload it runs with; nothing
//      here names a tool or a track.
//   2. Nothing here reads or writes a row: the screen reads its own rows (packages/learning-progress/show/use-progress-rows.ts).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { mountReactMaterial } from '../../ui';
import { LearningProgressSurface } from '../packages/learning-progress/show/LearningProgressSurface';

type PracticeAction = { tool?: string; payload?: Record<string, unknown>; label?: string };

type LearningProgressScreenInput = {
  learner_id?: string;
  learnerId?: string;
  practice_action?: PracticeAction;
  practiceAction?: PracticeAction;
  [key: string]: unknown;
};

export function mount(element: HTMLElement, props: LearningProgressScreenInput = {}) {
  const configured = props.practice_action ?? props.practiceAction;
  const practiceAction = configured?.tool ? { ...configured, tool: configured.tool } : undefined;
  return mountReactMaterial(
    element,
    React.createElement(LearningProgressSurface, { learnerId: props.learner_id ?? props.learnerId, practiceAction }),
    props,
    'Learning Progress',
  );
}
