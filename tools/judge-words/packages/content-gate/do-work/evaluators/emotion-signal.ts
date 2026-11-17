// packages/content-gate/do-work/evaluators/emotion-signal.ts
//
// Purpose: Evaluate emotional impact signals in script content.
// Analyzes text for markers of emotional resonance: vulnerability, humor,
// relatability, nostalgia, intensity, and personal transformation.
//
// Non-negotiable invariants:
//  - Pure function: no I/O, deterministic, no side effects.
//  - Emotion markers are DATA-configurable (rule.config), never hardcoded.
//  - Scoring is based on marker presence + density, not interpretation.
//  - Unknown emotion categories are ignored (open system, not enum).
//  - Script-text only — true emotional impact requires filmed video analysis
//    (documented as post-film gate, not script-predictive).

import type { Evaluator, EvaluatorOutput } from '../evaluator';
import type { GateRule, GateSubject } from '../../read-data/gate-types';

interface EmotionSignalConfig {
  /** Map of emotion_key → { markers: string[], weight?: number } */
  emotions?: Record<string, { markers: string[]; weight?: number }>;
  /** Minimum weighted score to pass [0..100]. Default 0. */
  min_weighted_score?: number;
  /** Whether to report individual emotion findings (true) or aggregate only (false). Default true. */
  verbose?: boolean;
}

interface EmotionScore {
  emotion: string;
  marker_count: number;
  total_markers: number;
  weight: number;
  weighted_score: number;
}

/**
 * Count case-insensitive regex matches across all blocks.
 * Returns count of distinct matches found.
 */
function countMarkerMatches(subject: GateSubject, pattern: string): number {
  let count = 0;
  try {
    const re = new RegExp(`\\b${pattern}\\b`, 'i');
    for (const block of subject.blocks) {
      const matches = block.text.match(re);
      if (matches) {
        count += matches.length;
      }
    }
  } catch {
    // Invalid regex.
  }
  return count;
}

/**
 * Flatten all blocks into a single text for high-level marker searching.
 */
function flattenSubjectText(subject: GateSubject): string {
  return subject.blocks.map((b) => b.text).join('\n');
}

export const emotionSignalEvaluator: Evaluator = (
  subject: GateSubject,
  rule: GateRule,
): EvaluatorOutput => {
  const cfg = rule.config as EmotionSignalConfig;
  const emotionDefs = cfg.emotions ?? {};
  const minWeightedScore = cfg.min_weighted_score ?? 0;
  const verbose = cfg.verbose ?? true;

  if (Object.keys(emotionDefs).length === 0) {
    return { score: 100, findings: [] };
  }

  const ruleOutcome = rule.outcome ?? 'block';
  const emotionScores: EmotionScore[] = [];
  const fullText = flattenSubjectText(subject);

  let weightSum = 0;
  let weightedSum = 0;

  for (const [emotion, def] of Object.entries(emotionDefs)) {
    const markers = def.markers ?? [];
    const weight = def.weight ?? 1;
    weightSum += weight;

    if (markers.length === 0) {
      emotionScores.push({
        emotion,
        marker_count: 0,
        total_markers: 0,
        weight,
        weighted_score: 0,
      });
      continue;
    }

    let markerCount = 0;
    for (const markerSrc of markers) {
      const matches = countMarkerMatches(subject, markerSrc);
      markerCount += matches;
    }

    // Emotion score: presence-based. If ANY marker found, start at 70 points,
    // then add up to 30 more based on marker density.
    const emotionScore = markerCount === 0 ? 0 : Math.min(100, 70 + (markerCount / markers.length) * 30);

    emotionScores.push({
      emotion,
      marker_count: markerCount,
      total_markers: markers.length,
      weight,
      weighted_score: emotionScore,
    });

    weightedSum += emotionScore * weight;
  }

  // Aggregate weighted score.
  const aggregateScore = weightSum === 0 ? 100 : weightedSum / weightSum;
  const passed = aggregateScore >= minWeightedScore;

  const findings: typeof rule.findings = [];

  if (!passed) {
    findings.push({
      rule_id: rule.id,
      evaluator: rule.evaluator,
      outcome: ruleOutcome,
      message:
        rule.message ??
        `Emotional signals insufficient. Aggregate score: ${aggregateScore.toFixed(1)} / 100, required: ${minWeightedScore}. ` +
        emotionScores
          .map((es) => `${es.emotion}: ${es.marker_count}/${es.total_markers} markers (score ${es.weighted_score.toFixed(1)})`)
          .join(' | '),
    });
  } else if (verbose) {
    // When passed but verbose, emit informational findings per emotion.
    for (const es of emotionScores) {
      if (es.marker_count === 0) {
        findings.push({
          rule_id: rule.id,
          evaluator: rule.evaluator,
          outcome: 'info',
          message: `Emotion "${es.emotion}": no markers found (0 / ${es.total_markers})`,
        });
      }
    }
  }

  return { score: Math.min(100, aggregateScore), findings };
};
