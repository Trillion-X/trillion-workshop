import React, { useState } from 'react';
import { Button, Container, Input, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const blankAttempt = { need: '', contributors: '', conditions: '' };
const parseObject = value => {
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; }
  catch { return null; }
};
const parseCents = value => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{0,2})?$/u.test(value)) return null;
  const [wholeText, fractionText = ''] = value.split('.');
  const whole = Number(wholeText);
  const fraction = Number(fractionText.padEnd(2, '0'));
  const cents = whole * 100 + fraction;
  return Number.isSafeInteger(cents) ? cents : null;
};
const money = cents => `$${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
const formatAmountField = value => typeof value === 'string' ? value : '';

function Lesson({ surfaceInput, host }) {
  const [members, setMembers] = useState(() => content.example.members.map(row => ({ ...row })));
  const [safetyNeed, setSafetyNeed] = useState(content.example.safetyNeed);
  const [attempt, setAttempt] = useState(blankAttempt);
  const [tooLong, setTooLong] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.labels.feedback,
    requestPrefix: 'm100-guild-co-op-model',
    onRestore: record => {
      const restored = parseObject(record.result);
      if (!restored) return;
      setAttempt(Object.fromEntries(Object.keys(blankAttempt).map(key => [key, typeof restored[key] === 'string' ? restored[key] : ''])));
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, { as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level] }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const totalPool = members.reduce((sum, row) => {
    const value = parseCents(row.contribution);
    return sum === null || value === null || !Number.isSafeInteger(sum + value) ? null : sum + value;
  }, 0);
  const needCents = parseCents(safetyNeed);
  const validAmounts = totalPool !== null && needCents !== null;
  const calculation = !validAmounts ? { kind: 'invalid' } : totalPool < needCents
    ? { kind: 'short', shortfall: needCents - totalPool, remainder: 0, each: 0, centsLeft: 0 }
    : (() => {
      const remainder = totalPool - needCents;
      const each = Math.floor(remainder / members.length);
      const centsLeft = remainder % members.length;
      return { kind: remainder === 0 ? 'zero' : 'funded', remainder, each, centsLeft };
    })();
  const setContribution = (id, value) => setMembers(rows => rows.map(row => row.id === id ? { ...row, contribution: value } : row));
  const updateAttempt = (key, value) => {
    const next = { ...attempt, [key]: value };
    setAttempt(next);
    const serialized = JSON.stringify(next);
    const over = serialized.length > 2000;
    setTooLong(over);
    practice.markEdited();
    if (!over) practice.setValue('result', serialized);
  };
  const field = ({ id, label, value, onChange, rows = 2, required = false }) => h(Container, { gap: 'xs' },
    h(Text, { as: 'label', variant: 'body', htmlFor: id }, label),
    h(Textarea, {
      id, rows, autoGrow: true, maxHeight: rows > 2 ? 220 : 160, value, disabled,
      'aria-required': required ? 'true' : undefined,
      'aria-invalid': tooLong ? 'true' : undefined,
      'aria-describedby': tooLong ? 'm100-practice-length-error' : undefined,
      onChange: event => onChange(event.target.value),
    }));
  const changeNeed = value => setSafetyNeed(value);
  const inputError = value => parseCents(value) === null ? 'Enter zero or a positive dollar amount with up to two decimal places.' : undefined;
  const memberFields = members.map(row => {
    const id = `m100-contribution-${row.id}`;
    const error = inputError(row.contribution);
    return h(Container, { key: row.id, gap: 'xs' },
      h(Input, {
        id, type: 'number', min: 0, step: '0.01',
        label: `${row.label} contribution ($)`, value: formatAmountField(row.contribution),
        'aria-invalid': error ? 'true' : undefined,
        'aria-describedby': error ? `${id}-error` : undefined,
        onChange: event => setContribution(row.id, event.target.value),
      }),
      error ? h(Text, { as: 'p', id: `${id}-error`, role: 'alert', variant: 'body' }, error) : null);
  });
  const isComplete = attempt.need.trim().length > 0 && attempt.contributors.trim().length > 0;
  const save = () => practice.save();
  const poolResult = calculation.kind === 'invalid'
    ? para('Enter nonnegative amounts in dollars with up to two decimal places to calculate the example.', { role: 'status', 'aria-live': 'polite' })
    : calculation.kind === 'short'
      ? h(Container, { gap: 'sm', role: 'status', 'aria-live': 'polite' },
        para(`${content.labels.result}: ${money(totalPool)} in the pool; ${money(needCents)} in identified top-up needs.`),
        para(`${content.labels.poolShort}: ${money(calculation.shortfall)}. No dividend is calculated. The source does not specify how to divide an insufficient pool among top-up needs.`))
      : calculation.kind === 'zero'
        ? h(Container, { gap: 'sm', role: 'status', 'aria-live': 'polite' },
          para(`${content.labels.result}: ${money(totalPool)} in the pool is used for ${money(needCents)} in modeled top-ups.`),
          para('Nothing remains for a dividend in this example.'))
        : h(Container, { gap: 'sm', role: 'status', 'aria-live': 'polite' },
          para(`${content.labels.result}: ${money(totalPool)} in the pool, minus ${money(needCents)} in modeled top-ups, leaves ${money(calculation.remainder)}.`),
          para(`${money(calculation.each)} per member for all ${members.length} members, including those who did not need a top-up.`),
          calculation.centsLeft > 0 ? para(`${calculation.centsLeft} cent${calculation.centsLeft === 1 ? '' : 's'} remain because the pool cannot be divided equally in whole cents. No rounding rule is supplied, so this amount is unresolved.`) : null);

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening),
      para('Future sales are not spendable contributions. A promise, available funds, and speculative proceeds are different things.')),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm100-example-heading' },
      heading(content.labels.example, 'h2', 'm100-example-heading'), para(content.example.note),
      h(Container, { as: 'ol', gap: 'sm' }, ...content.example.operations.map((operation, index) => h(Container, { as: 'li', key: operation.title, gap: 'xs' },
        heading(operation.title, 'h3', `m100-operation-${index + 1}`), para(operation.detail)))),
      h(Container, { gap: 'sm', role: 'group', 'aria-label': 'Member contributions', 'aria-describedby': 'm100-contributions-help' },
        para('Counts toward the pool. This value is an illustration, not an agreed commitment.', { id: 'm100-contributions-help' }),
        h(Container, { layout: 'responsive-split', gap: 'md' }, ...memberFields)),
      h(Container, { gap: 'xs' },
        h(Input, {
          id: 'm100-safety-need', type: 'number', min: 0, step: '0.01',
          label: content.labels.safetyNeed, value: safetyNeed,
          'aria-invalid': inputError(safetyNeed) ? 'true' : undefined,
          'aria-describedby': inputError(safetyNeed) ? 'm100-safety-need-error m100-safety-need-hint' : 'm100-safety-need-hint',
          onChange: event => changeNeed(event.target.value),
        }),
        inputError(safetyNeed) ? h(Text, { as: 'p', id: 'm100-safety-need-error', role: 'alert', variant: 'body' }, inputError(safetyNeed)) : null,
        para(content.labels.needHint, { id: 'm100-safety-need-hint' })),
      h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-label': content.labels.result },
        para(`${content.labels.pool}: ${validAmounts ? money(totalPool) : '—'}`),
        para(`${content.labels.memberCount}: ${members.length}`),
        para(`${content.labels.remainder}: ${validAmounts && calculation.kind !== 'short' ? money(calculation.remainder) : '—'}`),
        para(`${content.labels.equalShare}: ${validAmounts && calculation.kind !== 'short' ? `${money(calculation.each)} each` : '—'}`),
        poolResult),
      para(content.example.limits)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm100-practice-heading' },
      heading(content.labels.attempt, 'h2', 'm100-practice-heading'), para(content.labels.attemptPrompt),
      field({ id: 'm100-need', label: content.labels.need, value: attempt.need, onChange: value => updateAttempt('need', value), required: true }),
      field({ id: 'm100-contributors', label: content.labels.contributors, value: attempt.contributors, onChange: value => updateAttempt('contributors', value), required: true }),
      field({ id: 'm100-conditions', label: content.labels.conditions, value: attempt.conditions, onChange: value => updateAttempt('conditions', value), rows: 3 }),
      para(content.labels.private),
      !isComplete ? para(content.labels.missing) : null,
      tooLong ? h(Text, { as: 'p', id: 'm100-practice-length-error', role: 'alert' }, content.labels.oversize) : null,
      h(Button, { variant: 'primary', disabled: !isComplete || tooLong || practice.loading || practice.saving, onClick: save },
        practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
      practice.locked ? para(content.labels.feedback.retryPending) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle),
      para(content.source.excerpt), para(content.source.attribution), para(content.source.boundary)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
