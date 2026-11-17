// packages/content-gate/do-work/evaluators/humor-and-personality.ts
//
// Purpose: Evaluate content for humor signals, personality markers, and
// intentional bloopers/absurdist moments. Persona authenticity is critical
// for connection and retention.
//
// Non-negotiable invariants:
//  - Humor and personality markers are DATA-configurable, not hardcoded.
//  - Open system: unknown personality types are ignored (no enum).
//  - Blooper markers are text-based signals in the script (not post-film).
//  - Pure function: no I/O, deterministic.

import type { Evaluator, EvaluatorOutput } from '../evaluator';
import type { GateRule, GateSubject } from '../../read-data/gate-types';

interface PersonalityMarker {
  /** Marker type (e.g., "humor-wordplay", "self-deprecation", "blooper-signal") */
  id: string;
  /** Human-readable label */
  label?: string;
  /** Patterns that signal this marker (regex, case-insensitive) */
  patterns: string[];
  /** Optional weight [0..100]. Default 1. */
  weight?: number;
}

interface HumorAndPersonalityConfig {
  /** Array of personality/humor markers */
  markers?: PersonalityMarker[];
  /** Minimum coverage percent. Default 0. */
  min_coverage?: number;
  /** Require at least one self-aware humor signal (contradiction, misstep). Default false. */
  require_self_aware?: boolean;
  /** Verbose findings. Default false. */
  verbose?: boolean;
}

/**
 * Count regex pattern matches across all blocks.
 */
function countPatternMatches(subject: GateSubject, patternSrc: string): number {
  let count = 0;
  try {
    const pattern = new RegExp(patternSrc, 'i');
    for (const block of subject.blocks) {
      const matches = block.text.match(pattern);
      if (matches) {
        count += matches.length;
      }
    }
  } catch {
    // Invalid regex.
  }
  return count;
}

export const humorAndPersonalityEvaluator: Evaluator = (
  subject: GateSubject,
  rule: GateRule,
): EvaluatorOutput => {
  const cfg = rule.config as HumorAndPersonalityConfig;
  const markers = cfg.markers ?? [];
  const minCoverage = cfg.min_coverage ?? 0;
  const requireSelfAware = cfg.require_self_aware ?? false;
  const verbose = cfg.verbose ?? false;

  if (markers.length === 0) {
    return { score: 100, findings: [] };
  }

  const ruleOutcome = rule.outcome ?? 'block';

  // Evaluate each marker.
  const markerResults: { marker: PersonalityMarker; present: boolean; evidence: string }[] = [];

  for (const marker of markers) {
    let found = false;
    let evidence = '';

    for (const patternSrc of marker.patterns) {
      const count = countPatternMatches(subject, patternSrc);
      if (count > 0) {
        found = true;
        evidence = `Pattern "${patternSrc}" found (${count} occurrence${count > 1 ? 's' : ''})`;
        break;
      }
    }

    markerResults.push({ marker, present: found, evidence });
  }

  // Self-aware requirement: look for contradiction/irony patterns.
  let selfAwareMet = true;
  let selfAwareEvidence = '';

  if (requireSelfAware) {
    const selfAwarePatterns = ['but', 'however', 'yet', 'though', 'actually', 'wait', 'haha', 'lol', 'oops'];
    let found = false;
    for (const pattern of selfAwarePatterns) {
      if (countPatternMatches(subject, pattern) > 0) {
        found = true;
        selfAwareEvidence = `Self-awareness cue "${pattern}" present`;
        break;
      }
    }
    selfAwareMet = found;
    if (!found) {
      selfAwareEvidence = `No self-aware humor signals found (but, however, wait, oops, etc.)`;
    }
  }

  const presentCount = markerResults.filter((r) => r.present).length;
  const coverageScore = (presentCount / markers.length) * 100;
  const passed = coverageScore >= minCoverage && selfAwareMet;

  const findings: typeof rule.findings = [];

  if (!passed) {
    if (coverageScore < minCoverage) {
      findings.push({
        rule_id: rule.id,
        evaluator: rule.evaluator,
        outcome: ruleOutcome,
        message:
          rule.message ??
          `Humor/personality insufficient: ${presentCount}/${markers.length} markers present (${coverageScore.toFixed(1)}%). ` +
          `Required: ${minCoverage}%. Missing: ${markerResults.filter((r) => !r.present).map((r) => r.marker.label ?? r.marker.id).join(', ')}`,
      });
    }
    if (requireSelfAware && !selfAwareMet) {
      findings.push({
        rule_id: rule.id,
        evaluator: rule.evaluator,
        outcome: ruleOutcome,
        message:
          rule.message ??
          `Self-aware humor required but missing: ${selfAwareEvidence}. Include moments of contradiction or knowing humor.`,
      });
    }
  } else if (verbose) {
    for (const result of markerResults) {
      findings.push({
        rule_id: rule.id,
        evaluator: rule.evaluator,
        outcome: 'info',
        message: `${result.marker.label ?? result.marker.id}: ${result.present ? 'present — ' + result.evidence : 'absent'}`,
      });
    }
    if (requireSelfAware) {
      findings.push({
        rule_id: rule.id,
        evaluator: rule.evaluator,
        outcome: 'info',
        message: `Self-aware humor: ${selfAwareEvidence}`,
      });
    }
  }

  return { score: passed ? 100 : coverageScore, findings };
};
