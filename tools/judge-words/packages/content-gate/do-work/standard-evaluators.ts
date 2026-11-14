// packages/content-gate/do-work/standard-evaluators.ts
//
// Purpose: Four DATA-configured generic evaluators covering the complete space
// of structural and textual content gating without any domain vocabulary.
// All are pure functions: no I/O, deterministic, zero side effects.
//
// Non-negotiable invariants:
//  - No switch/if on rule kinds — each evaluator reads only its own config.
//  - Config shapes are open Records; unknown keys are silently ignored.
//  - `pattern` covers forbid, require, banned-word, required-keyword via config alone.
//  - Partial scoring (required-kinds) must return intermediate scores, not 0/100.
//  - All scores clamped to [0, 100].
//  - `unit` in length-bound is an open string: "char" and "word" are built-in
//    counters; an unknown unit falls back to char count (no throw). New units
//    are future DATA-selected counters — do NOT add a closed union type.
//  - `pattern` (text/forbid) emits one finding per match PER BLOCK, carrying
//    block_index + in-block offset + match, so callers can pinpoint the exact
//    block and character position. `suggested_replacement` is forwarded from
//    rule.config.replacement when present (enables auto_fix outcomes).

import type { Evaluator, EvaluatorOutput, EvaluatorRegistry } from '@/packages/content-gate/do-work/evaluator';
import type { Finding, GateRule, GateSubject } from '@/packages/content-gate/read-data/gate-types';
import { emotionSignalEvaluator } from '@/packages/content-gate/do-work/evaluators/emotion-signal';
import { frameworkCoverageEvaluator } from '@/packages/content-gate/do-work/evaluators/framework-coverage';
import { retentionProtocolEvaluator } from '@/packages/content-gate/do-work/evaluators/retention-protocol';
import { voiceIntonationEvaluator } from '@/packages/content-gate/do-work/evaluators/voice-intonation';
import { humorAndPersonalityEvaluator } from '@/packages/content-gate/do-work/evaluators/humor-and-personality';
import {
  addressedReferenceEvaluator,
  inferenceCaptureQualificationEvaluator,
  sourceSpanCoverageEvaluator,
  writingProfileCoverageEvaluator,
} from '@/packages/content-gate/do-work/evaluators/provenance-and-capture';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

// ---------------------------------------------------------------------------
// 1. pattern
//    config: { target: "text" | "block-kind", pattern: string, flags?: string,
//               mode: "forbid" | "require", replacement?: string }
//
//  target=text, mode=forbid:
//    Iterates each block independently. Each regex match within a block emits
//    a finding with block_index, in-block offset, and match. If
//    config.replacement is present, the finding carries suggested_replacement.
//    score = any matches found across all blocks ? 0 : 100.
//  target=text, mode=require:
//    At least one match required across all blocks. score = match ? 100 : 0.
//  target=block-kind, mode=forbid:
//    Regex tested against the SET of block kinds; any match = failure (score 0).
//  target=block-kind, mode=require:
//    At least one block kind matches the pattern; score = match ? 100 : 0.
// ---------------------------------------------------------------------------

const patternEvaluator: Evaluator = (
  subject: GateSubject,
  rule: GateRule,
): EvaluatorOutput => {
  const cfg = rule.config as {
    target?: string;
    pattern?: string;
    flags?: string;
    mode?: string;
    replacement?: string;
    block_kinds?: string[];
    normalize_nfkc?: boolean;
    normalize_whitespace?: boolean;
  };

  const target = cfg.target ?? 'text';
  const patternSrc = cfg.pattern ?? '';
  const flags = cfg.flags ?? '';
  const mode = cfg.mode ?? 'forbid';
  const replacement = cfg.replacement;
  const ruleOutcome = rule.outcome ?? 'block';
  if ((cfg.block_kinds !== undefined && (!Array.isArray(cfg.block_kinds) || cfg.block_kinds.some((kind) => typeof kind !== 'string')))
    || (cfg.normalize_nfkc !== undefined && typeof cfg.normalize_nfkc !== 'boolean')
    || (cfg.normalize_whitespace !== undefined && typeof cfg.normalize_whitespace !== 'boolean')) {
    return { score: 0, findings: [{ rule_id: rule.id, evaluator: rule.evaluator, outcome: ruleOutcome,
      message: rule.message ?? 'Invalid pattern scope or normalization configuration.' }] };
  }
  const selectedBlocks = subject.blocks.map((block, index) => ({ block, index }))
    .filter(({ block }) => cfg.block_kinds === undefined || cfg.block_kinds.includes(block.kind));
  const normalize = (text: string) => {
    let normalized = cfg.normalize_nfkc ? text.normalize('NFKC') : text;
    if (cfg.normalize_whitespace) normalized = normalized.replace(/\s+/gu, ' ').trim();
    return normalized;
  };

  let re: RegExp;
  try {
    re = new RegExp(patternSrc, flags);
  } catch {
    return {
      score: 0,
      findings: [
        {
          rule_id: rule.id,
          evaluator: rule.evaluator,
          outcome: ruleOutcome,
          message: `Invalid regex pattern "${patternSrc}": ${rule.message ?? 'pattern error'}`,
        },
      ],
    };
  }

  if (target === 'block-kind') {
    const kinds = subject.blocks.map((b) => b.kind);
    const anyMatch = kinds.some((k) => re.test(k));
    if (mode === 'forbid') {
      if (!anyMatch) return { score: 100, findings: [] };
      const matched = kinds.filter((k) => re.test(k));
      return {
        score: 0,
        findings: matched.map((k) => ({
          rule_id: rule.id,
          evaluator: rule.evaluator,
          outcome: ruleOutcome,
          message: rule.message ?? `Block kind "${k}" is forbidden by pattern "${patternSrc}"`,
          locator: { kind: k },
        })),
      };
    } else {
      // require
      if (anyMatch) return { score: 100, findings: [] };
      return {
        score: 0,
        findings: [
          {
            rule_id: rule.id,
            evaluator: rule.evaluator,
            outcome: ruleOutcome,
            message: rule.message ?? `No block kind matches required pattern "${patternSrc}"`,
          },
        ],
      };
    }
  }

  // target === 'text'

  if (mode === 'forbid') {
    const findings: Finding[] = [];

    // Ensure global flag so exec-loop finds ALL matches within each block.
    const globalFlags = flags.includes('g') ? flags : flags + 'g';
    let globalRe: RegExp;
    try {
      globalRe = new RegExp(patternSrc, globalFlags);
    } catch {
      globalRe = new RegExp(patternSrc, 'g');
    }

    // Iterate PER BLOCK — populates block_index and in-block offset.
    for (const { block, index: blockIdx } of selectedBlocks) {
      const blockText = normalize(block.text);
      globalRe.lastIndex = 0; // reset before each block

      let m: RegExpExecArray | null;
      while ((m = globalRe.exec(blockText)) !== null) {
        const finding: Finding = {
          rule_id: rule.id,
          evaluator: rule.evaluator,
          outcome: ruleOutcome,
          message: rule.message ?? `Forbidden pattern "${patternSrc}" found: "${m[0]}"`,
          locator: {
            block_index: blockIdx,
            kind: block.kind,
            ...(cfg.normalize_nfkc || cfg.normalize_whitespace ? {} : { offset: m.index }),
            match: m[0],
            ...(cfg.normalize_nfkc || cfg.normalize_whitespace ? { offset_basis: 'normalized' } : {}),
          },
        };
        if (replacement !== undefined) {
          finding.suggested_replacement = replacement;
        }
        findings.push(finding);
        // Guard against zero-width matches causing infinite loop.
        if (m[0].length === 0) globalRe.lastIndex++;
      }
    }

    return { score: findings.length > 0 ? 0 : 100, findings };
  } else {
    // require — test across the flattened text (at least one match anywhere)
    const fullText = selectedBlocks.map(({ block }) => normalize(block.text)).join('\n');
    if (re.test(fullText)) return { score: 100, findings: [] };
    return {
      score: 0,
      findings: [
        {
          rule_id: rule.id,
          evaluator: rule.evaluator,
          outcome: ruleOutcome,
          message: rule.message ?? `Required pattern "${patternSrc}" not found`,
        },
      ],
    };
  }
};

// ---------------------------------------------------------------------------
// 2. required-kinds
//    config: { kinds: string[] }
//    Each listed kind that is absent = one finding. Partial scoring:
//    score = (present / total) * 100. Empty kinds list = 100.
// ---------------------------------------------------------------------------

const requiredKindsEvaluator: Evaluator = (
  subject: GateSubject,
  rule: GateRule,
): EvaluatorOutput => {
  const cfg = rule.config as { kinds?: string[] };
  const required = cfg.kinds ?? [];
  const ruleOutcome = rule.outcome ?? 'block';

  if (required.length === 0) return { score: 100, findings: [] };

  const present = new Set(subject.blocks.map((b) => b.kind));
  const missing = required.filter((k) => !present.has(k));

  const score = clamp(((required.length - missing.length) / required.length) * 100);

  const findings: Finding[] = missing.map((k) => ({
    rule_id: rule.id,
    evaluator: rule.evaluator,
    outcome: ruleOutcome,
    message: rule.message ?? `Required block kind "${k}" is absent`,
    locator: { kind: k },
  }));

  return { score, findings };
};

// ---------------------------------------------------------------------------
// 3. kind-order
//    config: { order: string[] }
//    The in-`order` subsequence of subject block kinds (preserving subject
//    order) must appear in the same relative order as `order`.
//    Any out-of-order pair = finding (score 0). In-order or absent = score 100.
// ---------------------------------------------------------------------------

const kindOrderEvaluator: Evaluator = (
  subject: GateSubject,
  rule: GateRule,
): EvaluatorOutput => {
  const cfg = rule.config as { order?: string[]; value_field?: string; block_kinds?: string[] };
  const order = cfg.order ?? [];
  const ruleOutcome = rule.outcome ?? 'block';

  const valueField = cfg.value_field ?? 'kind';
  if (typeof valueField !== 'string' || !valueField.trim()
    || !Array.isArray(order) || order.some((value) => typeof value !== 'string')
    || (cfg.block_kinds !== undefined && (!Array.isArray(cfg.block_kinds)
      || cfg.block_kinds.some((kind) => typeof kind !== 'string')))) {
    return { score: 0, findings: [{ rule_id: rule.id, evaluator: rule.evaluator, outcome: ruleOutcome,
      message: rule.message ?? 'Invalid kind-order field or scope configuration.' }] };
  }

  if (order.length === 0) return { score: 100, findings: [] };

  // Build ordered list of kinds present in subject that appear in `order`.
  const scopedBlocks = subject.blocks.filter((block) => cfg.block_kinds === undefined || cfg.block_kinds.includes(block.kind));
  if (scopedBlocks.some((block) => typeof block[valueField] !== 'string')) {
    return { score: 0, findings: [{ rule_id: rule.id, evaluator: rule.evaluator, outcome: ruleOutcome,
      message: rule.message ?? `Block value field "${valueField}" is missing or is not a string.` }] };
  }
  const subjectKinds = scopedBlocks.map((block) => block[valueField] as string);
  const filtered = subjectKinds.filter((k) => order.includes(k));

  // Check: filtered must be a subsequence of `order` in relative order.
  // Strategy: walk `order` left-to-right; each kind in `filtered` must
  // appear in NON-DECREASING position in `order`. Cursor advances TO the
  // matched position (not past it) so repeated blocks of the same kind
  // (e.g. two consecutive `authority` blocks in a real script) are in-order.
  // (Defect fixed 2026-07-04: `pos + 1` enforced strictly-increasing, failing
  // legitimate repeats — caught by the real Federer-ad fixture.)
  let orderCursor = 0;
  let violated = false;
  for (const k of filtered) {
    const pos = order.indexOf(k, orderCursor);
    if (pos === -1) {
      violated = true;
      break;
    }
    orderCursor = pos;
  }

  if (!violated) return { score: 100, findings: [] };

  return {
    score: 0,
    findings: [
      {
        rule_id: rule.id,
        evaluator: rule.evaluator,
        outcome: ruleOutcome,
        message:
          rule.message ??
          `Block kinds are out of required order. Expected: [${order.join(', ')}], found: [${filtered.join(', ')}]`,
      },
    ],
  };
};

// ---------------------------------------------------------------------------
// 4. length-bound
//    config: { target: "text" | "block-kind", kind?: string,
//               min?: number, max?: number, unit?: string }
//    target=text: measures the full flattened text (or a specific block kind).
//    target=block-kind: counts the number of blocks of that kind.
//    unit: open string. Built-in counters: "char" (default) and "word".
//    An unknown unit falls back to char count — never throws.
// ---------------------------------------------------------------------------

function countUnits(text: string, unit: string): number {
  if (unit === 'word') {
    const trimmed = text.trim();
    if (trimmed.length === 0) return 0;
    return trimmed.split(/\s+/).length;
  }
  // Default (includes "char" and any unknown unit): character count.
  return text.length;
}

const lengthBoundEvaluator: Evaluator = (
  subject: GateSubject,
  rule: GateRule,
): EvaluatorOutput => {
  const cfg = rule.config as {
    target?: string;
    kind?: string;
    min?: number;
    max?: number;
    unit?: string;
  };

  const target = cfg.target ?? 'text';
  const unit = cfg.unit ?? 'char';
  const min = cfg.min;
  const max = cfg.max;
  const ruleOutcome = rule.outcome ?? 'block';

  let measured: number;
  let description: string;

  if (target === 'block-kind') {
    const kind = cfg.kind ?? '';
    measured = subject.blocks.filter((b) => b.kind === kind).length;
    description = `count of "${kind}" blocks`;
  } else {
    // text — optionally filtered to a specific block kind
    const blocks =
      cfg.kind != null
        ? subject.blocks.filter((b) => b.kind === cfg.kind)
        : subject.blocks;
    const text = blocks.map((b) => b.text).join('\n');
    measured = countUnits(text, unit);
    description =
      cfg.kind != null
        ? `${unit} count of "${cfg.kind}" blocks`
        : `${unit} count of all text`;
  }

  const findings: Finding[] = [];

  if (min != null && measured < min) {
    findings.push({
      rule_id: rule.id,
      evaluator: rule.evaluator,
      outcome: ruleOutcome,
      message:
        rule.message ??
        `${description} is ${measured} — below minimum ${min} ${unit}s`,
    });
  }
  if (max != null && measured > max) {
    findings.push({
      rule_id: rule.id,
      evaluator: rule.evaluator,
      outcome: ruleOutcome,
      message:
        rule.message ??
        `${description} is ${measured} — above maximum ${max} ${unit}s`,
    });
  }

  return { score: findings.length > 0 ? 0 : 100, findings };
};

// ---------------------------------------------------------------------------
// Registry export
// ---------------------------------------------------------------------------

/**
 * Standard evaluator registry — a default capability pack, not a closed
 * universe. Pass this (or a superset) to evaluateGate.
 * Extend by spreading: { ...standardEvaluators, 'ai-quality': myEvaluator }.
 */
export const standardEvaluators: EvaluatorRegistry = {
  pattern: patternEvaluator,
  'required-kinds': requiredKindsEvaluator,
  'kind-order': kindOrderEvaluator,
  'length-bound': lengthBoundEvaluator,
  'emotion-signal': emotionSignalEvaluator,
  'framework-coverage': frameworkCoverageEvaluator,
  'retention-protocol': retentionProtocolEvaluator,
  'voice-intonation': voiceIntonationEvaluator,
  'humor-and-personality': humorAndPersonalityEvaluator,
  'has-addressed-reference': addressedReferenceEvaluator,
  'source-span-coverage': sourceSpanCoverageEvaluator,
  'writing-profile-coverage': writingProfileCoverageEvaluator,
  'inference-capture-qualification': inferenceCaptureQualificationEvaluator,
};
