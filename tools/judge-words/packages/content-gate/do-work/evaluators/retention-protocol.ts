// packages/content-gate/do-work/evaluators/retention-protocol.ts
//
// Purpose: Evaluate content against learning-protocol principles that boost
// retention: spaced repetition, multisensory encoding, active recall,
// narrative framing, and synthesis/elaboration.
//
// Non-negotiable invariants:
//  - Protocol strategies and markers are DATA-configurable, not hardcoded.
//  - Open system: unknown strategies are ignored (no enum).
//  - Repetition detection: word/phrase appears 2+ times within different blocks
//    or at distance >= block_separation_minimum.
//  - Pure function: no I/O, deterministic.

import type { Evaluator, EvaluatorOutput } from '@/packages/content-gate/do-work/evaluator';
import type { GateRule, GateSubject } from '@/packages/content-gate/read-data/gate-types';

interface RetentionStrategy {
  /** Strategy name (e.g., "spaced-repetition", "multisensory", "active-recall") */
  id: string;
  /** Human-readable label */
  label?: string;
  /** Keywords/patterns that evidence this strategy */
  markers?: string[];
  /** Optional weight [0..100]. Default 1. */
  weight?: number;
}

interface RetentionProtocolConfig {
  /** Array of retention strategies */
  strategies?: RetentionStrategy[];
  /** Minimum percent of strategies that must be present. Default 0. */
  min_coverage?: number;
  /** For spaced-repetition strategy: minimum block distance between key phrase repeats. Default 2. */
  repetition_block_distance?: number;
  /** Verbose findings. Default false. */
  verbose?: boolean;
}

/**
 * Find case-insensitive marker matches in subject.
 * Returns count of occurrences and block indices.
 */
function findMarkerOccurrences(
  subject: GateSubject,
  pattern: string,
): { count: number; blockIndices: number[] } {
  const blockIndices: number[] = [];
  let count = 0;
  try {
    const re = new RegExp(`\\b${pattern}\\b`, 'i');
    for (let i = 0; i < subject.blocks.length; i++) {
      const block = subject.blocks[i];
      const matches = block.text.match(re);
      if (matches) {
        count += matches.length;
        blockIndices.push(i);
      }
    }
  } catch {
    // Invalid regex — skip.
  }
  return { count, blockIndices };
}

/**
 * Check if key phrase is repeated at required block distance.
 */
function hasSpacedRepetition(
  blockIndices: number[],
  minDistance: number,
): boolean {
  if (blockIndices.length < 2) return false;
  for (let i = 0; i < blockIndices.length - 1; i++) {
    if (blockIndices[i + 1] - blockIndices[i] >= minDistance) {
      return true;
    }
  }
  return false;
}

export const retentionProtocolEvaluator: Evaluator = (
  subject: GateSubject,
  rule: GateRule,
): EvaluatorOutput => {
  const cfg = rule.config as RetentionProtocolConfig;
  const strategies = cfg.strategies ?? [];
  const minCoverage = cfg.min_coverage ?? 0;
  const repetitionDistance = cfg.repetition_block_distance ?? 2;
  const verbose = cfg.verbose ?? false;

  if (strategies.length === 0) {
    return { score: 100, findings: [] };
  }

  const ruleOutcome = rule.outcome ?? 'block';

  // Evaluate each strategy.
  const strategyResults: { strategy: RetentionStrategy; present: boolean; evidence: string }[] = [];

  for (const strategy of strategies) {
    let found = false;
    let evidence = '';
    const markers = strategy.markers ?? [];

    if (strategy.id === 'spaced-repetition') {
      // Check if any marker is repeated at required distance.
      for (const marker of markers) {
        const { count, blockIndices } = findMarkerOccurrences(subject, marker);
        if (hasSpacedRepetition(blockIndices, repetitionDistance)) {
          found = true;
          evidence = `"${marker}" repeated at block distance ${repetitionDistance}+ (${count} total)`;
          break;
        }
      }
    } else {
      // Generic: just check for presence of any marker.
      for (const marker of markers) {
        const { count } = findMarkerOccurrences(subject, marker);
        if (count > 0) {
          found = true;
          evidence = `"${marker}" present (${count} occurrence${count > 1 ? 's' : ''})`;
          break;
        }
      }
    }

    strategyResults.push({ strategy, present: found, evidence });
  }

  const presentCount = strategyResults.filter((r) => r.present).length;
  const coverageScore = (presentCount / strategies.length) * 100;
  const passed = coverageScore >= minCoverage;

  const findings: typeof rule.findings = [];

  if (!passed) {
    findings.push({
      rule_id: rule.id,
      evaluator: rule.evaluator,
      outcome: ruleOutcome,
      message:
        rule.message ??
        `Retention protocol coverage insufficient: ${presentCount}/${strategies.length} strategies present (${coverageScore.toFixed(1)}%). ` +
        `Required: ${minCoverage}%. Missing: ${strategyResults.filter((r) => !r.present).map((r) => r.strategy.label ?? r.strategy.id).join(', ')}`,
    });
  } else if (verbose) {
    for (const result of strategyResults) {
      findings.push({
        rule_id: rule.id,
        evaluator: rule.evaluator,
        outcome: 'info',
        message: `${result.strategy.label ?? result.strategy.id}: ${result.present ? 'present — ' + result.evidence : 'absent'}`,
      });
    }
  }

  return { score: passed ? 100 : coverageScore, findings };
};
