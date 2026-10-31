// packages/ask-questions-sort-answers-follow-up/read-data/validate-answer.test.ts
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  coerceAnswer,
  validateAnswer,
  type AnswerValidationRules,
} from '../read-data/validate-answer.ts';

describe('coerceAnswer', () => {
  it('coerces strings, passing empty through as ""', () => {
    expect(coerceAnswer('hi', 'string')).toEqual({ ok: true, value: 'hi' });
    expect(coerceAnswer(null, 'string')).toEqual({ ok: true, value: '' });
    expect(coerceAnswer(42, 'string')).toEqual({ ok: true, value: '42' });
  });

  it('coerces numbers and rejects non-numeric', () => {
    expect(coerceAnswer('3', 'number')).toEqual({ ok: true, value: 3 });
    expect(coerceAnswer(5, 'number')).toEqual({ ok: true, value: 5 });
    expect(coerceAnswer('abc', 'number')).toEqual({ ok: false });
    expect(coerceAnswer('', 'number')).toEqual({ ok: true, value: undefined });
  });

  it('coerces booleans from common truthy/falsy encodings', () => {
    expect(coerceAnswer('true', 'boolean')).toEqual({ ok: true, value: true });
    expect(coerceAnswer(0, 'boolean')).toEqual({ ok: true, value: false });
    expect(coerceAnswer('maybe', 'boolean')).toEqual({ ok: false });
  });
});

describe('validateAnswer — required / optional', () => {
  it('empty + optional = valid', () => {
    expect(validateAnswer('', 'string', { required: false }).ok).toBe(true);
    expect(validateAnswer(null, 'string', null).ok).toBe(true);
  });

  it('empty + required = invalid with default message', () => {
    const res = validateAnswer('', 'string', { required: true });
    expect(res.ok).toBe(false);
    expect(res.message).toBe('This question is required');
  });

  it('custom message overrides any failure message', () => {
    const rules: AnswerValidationRules = { required: true, message: 'Please answer this' };
    expect(validateAnswer('', 'string', rules).message).toBe('Please answer this');
  });
});

describe('validateAnswer — string bounds (text) ', () => {
  it('enforces min/max as LENGTH for strings', () => {
    expect(validateAnswer('ab', 'string', { min: 3 }).ok).toBe(false);
    expect(validateAnswer('abc', 'string', { min: 3 }).ok).toBe(true);
    expect(validateAnswer('abcdef', 'string', { max: 5 }).ok).toBe(false);
  });

  it('enforces pattern for strings', () => {
    const email: AnswerValidationRules = { pattern: '^[^@]+@[^@]+$' };
    expect(validateAnswer('a@b.com', 'string', email).ok).toBe(true);
    expect(validateAnswer('nope', 'string', email).ok).toBe(false);
  });

  it('treats an invalid regex as a validation failure, not a crash', () => {
    expect(validateAnswer('x', 'string', { pattern: '([' }).ok).toBe(false);
  });
});

describe('validateAnswer — number bounds (rating)', () => {
  const rating: AnswerValidationRules = { min: 1, max: 5 };
  it('enforces min/max as VALUE for numbers', () => {
    expect(validateAnswer(0, 'number', rating).ok).toBe(false);
    expect(validateAnswer(1, 'number', rating).ok).toBe(true);
    expect(validateAnswer(5, 'number', rating).ok).toBe(true);
    expect(validateAnswer(6, 'number', rating).ok).toBe(false);
  });

  it('rejects a non-numeric rating answer at the coercion gate', () => {
    expect(validateAnswer('star', 'number', rating).ok).toBe(false);
  });
});
