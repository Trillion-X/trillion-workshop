// parts/ui/show/catch-up/index.ts
//
// PURPOSE
//   The one import point for whether every copy is in step: the sources and their picture (catch-up.ts), the small mark
//   (CatchUpMark), the whole picture (CatchUpPanel) and the view that settles two versions (TwoVersions).

export {
  catchUpAct, catchUpReports, catchUpView, fillWords, onCatchUpChange, plainWords, provideCatchUpSource, provideCatchUpWords,
  settleKeptApart, stateNow, stateRow, useCatchUp, useCatchUpWords,
} from './catch-up';
export type {
  CatchUpActionRow, CatchUpAge, CatchUpFact, CatchUpReport, CatchUpSource, CatchUpStateRow, CatchUpView, CatchUpWords,
  KeptApart, KeptSide, Settle, ShownApart, ShownFact,
} from './catch-up';
export { CatchUpDot, CatchUpMark } from './CatchUpMark';
export type { CatchUpMarkProps } from './CatchUpMark';
export { CatchUpPanel } from './CatchUpPanel';
export { TwoVersions, fieldsOf, mergedValue } from './TwoVersions';
