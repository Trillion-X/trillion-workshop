// tools/run-experiments/read-data/candidate-set-schema.ts
//
// Purpose: Schema for `selection-surface` records (candidate sets) and
// `validateCandidateSet`. A selection-surface is the DATA record that pairs
// an address with a set of N self-describing candidates and the decider
// program that will choose among them.
//
// Non-negotiable invariants:
//   - Candidate cardinality is 0..∞. "One vs A/B vs multivariate vs a thousand
//     variants" is purely how many candidate DATA rows you author — never a
//     code mode or branch. N=0 = empty/unresolved, N=1 = static (today's
//     behavior), N≥2 = experiment. All treated identically by the evaluator.
//   - `tie_rule_ref` points to another decider record (a tie-break IS a
//     degenerate decider, e.g. "score by candidate order"). NEVER a `kind`
//     enum. An absent tie_rule_ref defaults to candidate order.
//   - `material_ref` on a candidate is an open string — the render seam is
//     generic; what a material ref points to is the render layer's concern.
//   - No Society vocabulary in this file: no "ab_test", "experiment_id",
//     "variant", "bucket", "segment". Plain names only.
//
// Dependencies: pure — zero I/O imports.

// ---------------------------------------------------------------------------
// Candidate (one option in the set)
// ---------------------------------------------------------------------------

/**
 * One candidate in a selection-surface.
 *
 * `candidate_id`  — stable identifier within this surface (e.g. "a", "b").
 *                   Used as the key in CandidateScoresNode.candidate_scores
 *                   and in DecisionTranscript.winner_id.
 * `material_ref`  — open string pointer to the material/content this candidate
 *                   resolves to (e.g. "material:mc-headline-a"). The render
 *                   layer resolves this — the evaluator is blind to it.
 * `label`         — optional human-readable name (UI / debug only).
 * Additional fields are allowed (open record) — self-describing per candidate.
 */
export interface Candidate {
  candidate_id: string;
  material_ref: string;
  label?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// SelectionSurface (entity: "selection-surface")
// ---------------------------------------------------------------------------

/**
 * A selection-surface record: the DATA record that makes an address
 * observer-conditioned. Stored at the address the resolver reads.
 *
 * `entity_type`          — must be "selection-surface".
 * `address`              — the resolver address this surface is associated with
 *                          (e.g. "page:/master-class"). The resolver looks up
 *                          a surface at this address before deciding.
 * `decider_program_ref`  — ref to the DeciderProgram that scores candidates
 *                          (e.g. "decider:traffic-source-headline").
 * `tie_rule_ref`         — optional ref to another decider used when scores
 *                          tie. Absent = first-in-array wins (candidate order).
 * `candidates`           — ordered array of self-describing candidates (0..∞).
 *                          N=0: empty state (resolver returns nothing).
 *                          N=1: static (degenerate — always picks the one candidate).
 *                          N≥2: observer-conditioned selection.
 * `epoch`                — optional version token. When the decider or candidate
 *                          set changes, bumping the epoch creates a new decision
 *                          epoch so existing assignments are not reused for a
 *                          structurally different surface. Open string (e.g.
 *                          ISO timestamp, content hash, integer).
 * `label`                — optional human-readable surface name (UI only).
 */
export interface SelectionSurface {
  entity_type: 'selection-surface';
  address: string;
  decider_program_ref: string;
  tie_rule_ref?: string;
  candidates: Candidate[];
  epoch?: string;
  label?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Result of `validateCandidateSet`. Lists every problem found (not just the
 * first) so callers can surface all issues at once.
 */
export interface CandidateSetValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a SelectionSurface record.
 *
 * Checks:
 *   1. entity_type === "selection-surface"
 *   2. address is a non-empty string
 *   3. decider_program_ref is a non-empty string
 *   4. candidates is an array (may be empty — N=0 is valid)
 *   5. Each candidate has a non-empty candidate_id (string) and non-empty
 *      material_ref (string)
 *   6. candidate_ids are unique within the set
 *   7. tie_rule_ref, when present, is a non-empty string
 */
export function validateCandidateSet(
  record: unknown,
): CandidateSetValidationResult {
  const errors: string[] = [];

  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, errors: ['SelectionSurface record must be a non-null object.'] };
  }

  const r = record as Record<string, unknown>;

  // 1. entity_type
  if (r['entity_type'] !== 'selection-surface') {
    errors.push(
      `entity_type must be "selection-surface"; got ${JSON.stringify(r['entity_type'])}.`,
    );
  }

  // 2. address
  if (typeof r['address'] !== 'string' || r['address'].trim().length === 0) {
    errors.push('address must be a non-empty string.');
  }

  // 3. decider_program_ref
  if (
    typeof r['decider_program_ref'] !== 'string' ||
    r['decider_program_ref'].trim().length === 0
  ) {
    errors.push('decider_program_ref must be a non-empty string.');
  }

  // 4. candidates is array
  if (!Array.isArray(r['candidates'])) {
    errors.push('candidates must be an array (may be empty for N=0 state).');
  } else {
    const candidates = r['candidates'] as unknown[];
    const seenIds = new Set<string>();

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (c == null || typeof c !== 'object' || Array.isArray(c)) {
        errors.push(`candidates[${i}] must be a non-null object.`);
        continue;
      }
      const cObj = c as Record<string, unknown>;

      // 5a. candidate_id
      if (
        typeof cObj['candidate_id'] !== 'string' ||
        cObj['candidate_id'].trim().length === 0
      ) {
        errors.push(`candidates[${i}].candidate_id must be a non-empty string.`);
      } else {
        // 6. uniqueness
        const id = cObj['candidate_id'] as string;
        if (seenIds.has(id)) {
          errors.push(`candidates[${i}].candidate_id "${id}" is duplicated — candidate_ids must be unique.`);
        }
        seenIds.add(id);
      }

      // 5b. material_ref
      if (
        typeof cObj['material_ref'] !== 'string' ||
        cObj['material_ref'].trim().length === 0
      ) {
        errors.push(`candidates[${i}].material_ref must be a non-empty string.`);
      }
    }
  }

  // 7. tie_rule_ref (optional)
  if (r['tie_rule_ref'] !== undefined) {
    if (typeof r['tie_rule_ref'] !== 'string' || r['tie_rule_ref'].trim().length === 0) {
      errors.push('tie_rule_ref, when present, must be a non-empty string.');
    }
  }

  return { valid: errors.length === 0, errors };
}
