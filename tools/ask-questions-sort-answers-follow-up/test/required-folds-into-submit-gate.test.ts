// Regression proof for the L063 category fix (plan 2026-07-01-required-flag-folds-into-submit-gate):
// buildFillScreenModel folds the descriptor-level `required` flag into the submit-gate rules, so
// `required: true` alone blocks submit (allValid), not just the native input attribute. An explicit
// `validation.required` (including `false`) takes precedence. Before this fix, a question with
// `required: true` and no `validation` silently did NOT gate — the trap that broke quiz-me and the
// practice-session template.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { buildFillScreenModel } from '../read-data/fill-screen-model.ts';
import {
  indexCapabilities,
  type QuestionDescriptor,
  type QuestionTypeCapability,
} from '../read-data/question-descriptor.ts';

const CAPS: QuestionTypeCapability[] = [
  { questionTypeId: 'text', inputComponentKey: 'text', coerce: 'string', validate: { rules: { required: false } } },
  { questionTypeId: 'rating', inputComponentKey: 'rating', coerce: 'number', validate: { rules: { required: false, min: 1, max: 5 } } },
];
const REG = indexCapabilities(CAPS);

describe('descriptor.required folds into the submit gate (allValid)', () => {
  it('required:true WITHOUT validation blocks submit when empty (the previously-broken case)', () => {
    const qs: QuestionDescriptor[] = [{ questionId: 'name', questionTypeId: 'text', label: 'Name', required: true }];
    const empty = buildFillScreenModel(qs, REG, {}, { revealErrors: true });
    expect(empty.allValid).toBe(false);
    expect(empty.firstInvalidId).toBe('name');
    const filled = buildFillScreenModel(qs, REG, { name: 'Ada' }, { revealErrors: true });
    expect(filled.allValid).toBe(true);
  });

  it('an explicit validation.required:false OVERRIDES descriptor.required:true (does not block)', () => {
    const qs: QuestionDescriptor[] = [
      { questionId: 'opt', questionTypeId: 'text', label: 'Optional', required: true, validation: { required: false } },
    ];
    const empty = buildFillScreenModel(qs, REG, {}, { revealErrors: true });
    expect(empty.allValid).toBe(true);
  });

  it('descriptor.required folds alongside a validation bounds override (both apply)', () => {
    // required from the descriptor flag + max:10 from the per-question validation → both enforced.
    const qs: QuestionDescriptor[] = [
      { questionId: 'focus', questionTypeId: 'rating', label: 'Focus (1-10)', required: true, validation: { min: 1, max: 10 } },
    ];
    expect(buildFillScreenModel(qs, REG, {}, { revealErrors: true }).allValid).toBe(false); // required, empty
    expect(buildFillScreenModel(qs, REG, { focus: 8 }, { revealErrors: true }).allValid).toBe(true); // 8 ok via override max:10
    expect(buildFillScreenModel(qs, REG, { focus: 11 }, { revealErrors: true }).allValid).toBe(false); // > max:10
    const row = buildFillScreenModel(qs, REG, { focus: 8 }).rows[0];
    expect(row.rules).toMatchObject({ required: true, min: 1, max: 10 });
  });

  it('a question with no required flag anywhere stays optional', () => {
    const qs: QuestionDescriptor[] = [{ questionId: 'notes', questionTypeId: 'text', label: 'Notes' }];
    expect(buildFillScreenModel(qs, REG, {}, { revealErrors: true }).allValid).toBe(true);
  });
});
