// packages/content-gate/do-work/evaluators/voice-intonation.ts
//
// Purpose: Evaluate script content for voice-intonation cues: deliberate pauses,
// dynamic range markers (loud/quiet), pacing variations (fast/slow), elongations,
// truncations, repetition for emphasis, and self-aware observations.
//
// Non-negotiable invariants:
//  - Intonation cues are text-based markers in the script (e.g., "[pause]", "[LOUD]").
//  - Post-filmed intonation (actual voice quality, timing) requires media analysis
//    and is documented as a post-film dependency, not script-predictive.
//  - Cues and patterns are DATA-configurable, never hardcoded.
//  - Pure function: no I/O, deterministic.

import type { Evaluator, EvaluatorOutput } from '@/packages/content-gate/do-work/evaluator';
import type { GateRule, GateSubject } from '@/packages/content-gate/read-data/gate-types';

interface IntonationCue {
  /** Cue name (e.g., "pause", "emphasis-repetition", "dynamic-range") */
  id: string;
  /** Human-readable label */
  label?: string;
  /** Patterns that signal this cue (regex, case-insensitive) */
  patterns: string[];
  /** Optional weight [0..100]. Default 1. */
  weight?: number;
}

interface VoiceIntonationConfig {
  /** Array of intonation cues */
  cues?: IntonationCue[];
  /** Minimum coverage percent. Default 0. */
  min_coverage?: number;
  /** Require 3x intentional repetition of a key word/phrase. Default false. */
  require_three_repetition?: boolean;
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

/**
 * Check if a word/phrase appears exactly 3 times (or more) across blocks.
 */
function hasThreeRepetition(subject: GateSubject, word: string): boolean {
  let count = 0;
  try {
    const pattern = new RegExp(`\\b${word}\\b`, 'i');
    for (const block of subject.blocks) {
      const matches = block.text.match(pattern);
      if (matches) {
        count += matches.length;
        if (count >= 3) return true;
      }
    }
  } catch {
    // Invalid regex.
  }
  return count >= 3;
}

/**
 * Find a word that appears 3+ times in the subject, or return null.
 */
function findThreeRepeatWord(subject: GateSubject): string | null {
  const fullText = subject.blocks.map((b) => b.text).join(' ');
  const words = fullText.toLowerCase().split(/\s+/);
  const wordCounts = new Map<string, number>();
  for (const word of words) {
    const clean = word.replace(/[^\w]/g, '');
    if (clean.length > 3) {
      wordCounts.set(clean, (wordCounts.get(clean) ?? 0) + 1);
    }
  }
  for (const [word, count] of wordCounts.entries()) {
    if (count >= 3) {
      return word;
    }
  }
  return null;
}

export const voiceIntonationEvaluator: Evaluator = (
  subject: GateSubject,
  rule: GateRule,
): EvaluatorOutput => {
  const cfg = rule.config as VoiceIntonationConfig;
  const cues = cfg.cues ?? [];
  const minCoverage = cfg.min_coverage ?? 0;
  const requireThreeRepetition = cfg.require_three_repetition ?? false;
  const verbose = cfg.verbose ?? false;

  if (cues.length === 0 && !requireThreeRepetition) {
    return { score: 100, findings: [] };
  }

  const ruleOutcome = rule.outcome ?? 'block';

  // Evaluate each cue.
  const cueResults: { cue: IntonationCue; present: boolean; evidence: string }[] = [];

  for (const cue of cues) {
    let found = false;
    let evidence = '';

    for (const patternSrc of cue.patterns) {
      const count = countPatternMatches(subject, patternSrc);
      if (count > 0) {
        found = true;
        evidence = `Pattern "${patternSrc}" found (${count} occurrence${count > 1 ? 's' : ''})`;
        break;
      }
    }

    cueResults.push({ cue, present: found, evidence });
  }

  // Check three-repetition requirement (orthogonal to cue coverage).
  let threeRepetitionMet = true;
  let threeRepeatWord = '';

  if (requireThreeRepetition) {
    const word = findThreeRepeatWord(subject);
    if (word) {
      threeRepetitionMet = true;
      threeRepeatWord = word;
    } else {
      threeRepetitionMet = false;
    }
  }

  const presentCount = cueResults.filter((r) => r.present).length;
  const cuesCoverageScore = cues.length === 0 ? 100 : (presentCount / cues.length) * 100;
  const passed = cuesCoverageScore >= minCoverage && threeRepetitionMet;

  const findings: typeof rule.findings = [];

  if (!passed) {
    if (cuesCoverageScore < minCoverage) {
      findings.push({
        rule_id: rule.id,
        evaluator: rule.evaluator,
        outcome: ruleOutcome,
        message:
          rule.message ??
          `Voice intonation cues insufficient: ${presentCount}/${cues.length} present (${cuesCoverageScore.toFixed(1)}%). ` +
          `Required: ${minCoverage}%. Missing: ${cueResults.filter((r) => !r.present).map((r) => r.cue.label ?? r.cue.id).join(', ')}`,
      });
    }
    if (requireThreeRepetition && !threeRepetitionMet) {
      findings.push({
        rule_id: rule.id,
        evaluator: rule.evaluator,
        outcome: ruleOutcome,
        message:
          rule.message ??
          `Three-repetition requirement not met. Script must emphasize a key word/phrase 3+ times.`,
      });
    }
  } else if (verbose) {
    for (const result of cueResults) {
      findings.push({
        rule_id: rule.id,
        evaluator: rule.evaluator,
        outcome: 'info',
        message: `${result.cue.label ?? result.cue.id}: ${result.present ? 'present — ' + result.evidence : 'absent'}`,
      });
    }
    if (requireThreeRepetition && threeRepeatWord) {
      findings.push({
        rule_id: rule.id,
        evaluator: rule.evaluator,
        outcome: 'info',
        message: `Three-repetition: Found word "${threeRepeatWord}" repeated 3+ times`,
      });
    }
  }

  return { score: passed ? 100 : cuesCoverageScore, findings };
};
