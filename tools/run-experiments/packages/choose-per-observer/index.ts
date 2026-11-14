// packages/choose-per-observer/index.ts
//
// Purpose: Public barrel export for the choose-per-observer package.
// Exports all Wave-1 and Wave-2 primitives.

// --- read-data: evaluator (T1) ---
export {
  builtinOps,
  evalExpr,
  scoreCandidates,
  type CandidateResult,
  type ObserverFact,
  type OpHandler,
  type OpRegistry,
  type ScoreContext,
  type ScoreCandidatesResult,
} from './read-data/score-candidates';

// --- read-data: decider schema (T3) ---
export {
  validateDecider,
  type CaseClause,
  type CandidateScoresNode,
  type ConstNode,
  type DeciderProgram,
  type DeciderValidationResult,
  type FactPathNode,
  type OpNode,
  type ScoreExpr,
  type SplitNode,
} from './read-data/decider-schema';

// --- read-data: candidate-set schema (T4) ---
export {
  validateCandidateSet,
  type Candidate,
  type CandidateSetValidationResult,
  type SelectionSurface,
} from '../../../funnels-screen/read-data/candidate-set-schema';

// --- read-data: select — DECIDE op (T5) ---
export {
  claimTranscript,
  selectWinner,
  transcriptAddress,
  type ClaimTranscriptOptions,
  type DecisionTranscript,
} from './read-data/select';

// --- read-data: scoreboard — aggregation (T11) ---
export {
  aggregateOutcomes,
  computeRate,
  readOutcome,
  type CandidateOutcomes,
  type Scoreboard,
} from './read-data/scoreboard';

// --- read-data: scope-records — per-observer record scoping (owner boundary) ---
export {
  scopeRecordsForObserver,
  type ScopedRecordDecision,
  type ScopeRecordsResult,
} from './read-data/scope-records';

// --- read-data: attribute-outcomes — ATTRIBUTE op ---
export {
  attributeOutcomes,
  readAtPath,
  validateAttributionJoin,
  type AttributeOutcomesResult,
  type AttributionJoin,
  type AttributionJoinValidationResult,
  type AttributionWhere,
} from './read-data/attribute-outcomes';

// --- write-data: observe (T2) ---
export {
  appendObservation,
  buildObservationRecord,
  buildWriteBatchEntry,
  observationAddress,
  type ObservationRecord,
  type ObserveOptions,
  type WriteBatchEntry,
} from './write-data/observe';

// --- write-data: capture-signals (T8) ---
export {
  buildSignals,
  captureSignals,
  deriveObserverId,
  extractSignalValue,
  type CaptureSignalsOptions,
  type FirstTouchContext,
  type ObserverId,
  type ObserverIdSource,
  type SignalDescriptor,
} from './write-data/capture-signals';

// --- do-work: mirror-facts — outbound subscriber (T9) ---
export {
  factMatches,
  mapFactFields,
  mirrorFacts,
  type EmitFn,
  type MirrorRecord,
} from './do-work/mirror-facts';
