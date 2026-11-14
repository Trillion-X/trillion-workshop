import React, { useState } from 'react';
import { Button, Container, Input, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const freshScenarios = () => [
  { id: 'scenario-1', name: 'Source assumptions at 2%', omitted: '400', taxMultiplier: '2', realReturn: '2' },
  { id: 'scenario-2', name: 'Source assumptions at 3%', omitted: '400', taxMultiplier: '2', realReturn: '3' },
  { id: 'scenario-3', name: 'Source assumptions at 6%', omitted: '400', taxMultiplier: '2', realReturn: '6' },
  { id: 'scenario-4', name: 'Current costs only', omitted: '0', taxMultiplier: '1', realReturn: '3' },
];
const freshInputs = () => ({ monthly: '2000', dependents: '0', dependentCost: '0' });
const decimal = value => {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const whole = value => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const amount = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
function restore(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || !parsed.inputs || !Array.isArray(parsed.scenarios)) return null;
    const inputs = parsed.inputs;
    if (!['monthly', 'dependents', 'dependentCost'].every(key => typeof inputs[key] === 'string')) return null;
    const scenarios = parsed.scenarios.filter(row => row && typeof row.id === 'string'
      && typeof row.name === 'string' && typeof row.omitted === 'string'
      && typeof row.taxMultiplier === 'string' && typeof row.realReturn === 'string').slice(0, 5);
    return scenarios.length ? {
      inputs, scenarios,
      outcome: typeof parsed.outcome === 'string' ? parsed.outcome : '',
      check: typeof parsed.check === 'string' ? parsed.check : '',
    } : null;
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [inputs, setInputs] = useState(freshInputs);
  const [scenarios, setScenarios] = useState(freshScenarios);
  const [outcome, setOutcome] = useState('');
  const [check, setCheck] = useState('');
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['result'], messages: content.feedback,
    requestPrefix: 'm069-financial-number',
    onRestore: record => {
      const saved = restore(record.result);
      if (!saved) return;
      setInputs(saved.inputs);
      setScenarios(saved.scenarios);
      setOutcome(saved.outcome);
      setCheck(saved.check);
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', ...props }, words);
  const mark = action => {
    practice.markEdited();
    action();
  };
  const setInput = key => event => mark(() => setInputs(previous => ({ ...previous, [key]: event.target.value })));
  const setScenario = (id, key) => event => mark(() => setScenarios(previous => previous.map(row => row.id === id
    ? { ...row, [key]: event.target.value } : row)));
  const baseMonthly = decimal(inputs.monthly);
  const dependents = whole(inputs.dependents);
  const dependentCost = decimal(inputs.dependentCost);
  const baseValid = baseMonthly !== null && dependents !== null && dependentCost !== null;
  const rowResult = row => {
    const omitted = decimal(row.omitted);
    const multiplier = decimal(row.taxMultiplier);
    const realReturn = decimal(row.realReturn);
    if (!baseValid || omitted === null || multiplier === null || multiplier < 1 || realReturn === null || realReturn <= 0) return null;
    const annualNet = (baseMonthly + omitted + dependents * dependentCost) * 12;
    const annualGross = annualNet * multiplier;
    const target = annualGross / (realReturn / 100);
    if (![annualNet, annualGross, target].every(Number.isFinite)) return null;
    return { annualNet, annualGross, target };
  };
  const allValid = baseValid && scenarios.length > 0 && scenarios.every(row => rowResult(row));
  const addScenario = () => {
    if (scenarios.length >= 5 || disabled) return;
    mark(() => setScenarios(previous => [...previous, {
      id: `scenario-${Date.now()}`, name: 'New scenario', omitted: '0', taxMultiplier: '1', realReturn: '3',
    }]));
  };
  const save = () => {
    if (!allValid || !outcome.trim() || !check.trim()) return;
    const record = JSON.stringify({ inputs, scenarios, outcome, check });
    practice.setValue('result', record);
    return practice.save();
  };
  const numericInput = (key, label, value, update, hint, inputMode = 'decimal', validation = {}) => h(Container, {
    key, gap: 'xs',
  }, h(Input, {
    type: 'text', inputMode, label, value, disabled,
    hint,
    'aria-invalid': validation.invalid ? true : undefined,
    'aria-describedby': validation.invalid ? validation.describedBy : undefined,
    onChange: update,
  }), validation.invalid ? para(validation.message, { id: validation.describedBy, role: 'alert' }) : null);
  const tooLong = practice.status === content.feedback.length;

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm069-inputs-heading' },
      heading('Estimate annual spending', 'h2', 'm069-inputs-heading'),
      para('Keep every amount in the same currency. Monthly estimates are annualized by multiplying by 12.'),
      numericInput('monthly', content.labels.monthly, inputs.monthly, setInput('monthly'), undefined, 'decimal', {
        invalid: baseMonthly === null, message: content.labels.invalidInput, describedBy: 'm069-monthly-error',
      }),
      h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md' },
        numericInput('dependents', content.labels.dependents, inputs.dependents, setInput('dependents'), undefined, 'numeric', {
          invalid: dependents === null, message: content.labels.countInput, describedBy: 'm069-dependent-count-error',
        }),
        numericInput('dependent-cost', content.labels.dependentCost, inputs.dependentCost, setInput('dependentCost'), undefined, 'decimal', {
          invalid: dependentCost === null, message: content.labels.invalidInput, describedBy: 'm069-dependent-cost-error',
        }))),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm069-scenarios-heading' },
      h(Container, { gap: 'xs' }, heading(content.labels.scenarios, 'h2', 'm069-scenarios-heading'), para(content.labels.assumptionNote)),
      ...scenarios.map((row, index) => {
        const computed = rowResult(row);
        const returnNumber = decimal(row.realReturn);
        const invalidReturn = returnNumber === null || returnNumber <= 0;
        const returnErrorId = `m069-return-error-${row.id}`;
        const omittedNumber = decimal(row.omitted);
        const invalidOmitted = omittedNumber === null;
        const omittedErrorId = `m069-omitted-error-${row.id}`;
        const taxNumber = decimal(row.taxMultiplier);
        const invalidTaxMultiplier = taxNumber === null || taxNumber < 1;
        const taxErrorId = `m069-tax-error-${row.id}`;
        const display = (label, value) => para(`${label}: ${value}`);
        return h(Container, {
          key: row.id, as: 'section', border: 'all', padding: 'md', gap: 'sm',
          'aria-labelledby': `m069-scenario-heading-${index}`,
        },
        heading(row.name || `Scenario ${index + 1}`, 'h3', `m069-scenario-heading-${index}`),
        numericInput(`name-${row.id}`, content.labels.scenarioName, row.name, setScenario(row.id, 'name'), undefined, 'text'),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md' },
          numericInput(`omitted-${row.id}`, content.labels.omitted, row.omitted, setScenario(row.id, 'omitted'), undefined, 'decimal', {
            invalid: invalidOmitted, message: content.labels.invalidInput, describedBy: omittedErrorId,
          }),
          numericInput(`tax-${row.id}`, content.labels.taxMultiplier, row.taxMultiplier, setScenario(row.id, 'taxMultiplier'), 'Example: 1 = no gross-up; 2 = double annual spending.', 'decimal', {
            invalid: invalidTaxMultiplier, message: content.labels.invalidTaxMultiplier, describedBy: taxErrorId,
          }),
          numericInput(`return-${row.id}`, content.labels.realReturn, row.realReturn, setScenario(row.id, 'realReturn'), undefined, 'decimal', {
            invalid: invalidReturn,
            message: content.labels.invalidReturn,
            describedBy: invalidReturn ? returnErrorId : undefined,
          })),
        computed ? h(Container, { border: 'all', padding: 'sm', gap: 'xs', 'aria-label': `${row.name || `Scenario ${index + 1}`} result` },
          display(content.labels.annualNet, `${amount(computed.annualNet)} per year`),
          display(content.labels.annualGross, `${amount(computed.annualGross)} per year`),
          display(content.labels.target, `${amount(computed.target)} in the same currency as expenses`))
          : null,
        scenarios.length > 1 ? h(Button, {
          variant: 'secondary', disabled, onClick: () => mark(() => setScenarios(previous => previous.filter(item => item.id !== row.id))),
        }, `${content.labels.removeScenario} ${index + 1}`) : null);
      }),
      scenarios.length < 5 ? h(Button, { variant: 'secondary', disabled, onClick: addScenario }, content.labels.addScenario) : null),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm069-purpose-heading' },
      heading(content.labels.reflection, 'h2', 'm069-purpose-heading'),
      h(Textarea, {
        label: content.labels.outcome, rows: 3, autoGrow: true, maxHeight: 220,
        value: outcome, disabled, 'aria-invalid': tooLong ? true : undefined,
        'aria-describedby': tooLong ? 'm069-practice-length-error' : undefined,
        onChange: event => mark(() => setOutcome(event.target.value)),
      }),
      h(Textarea, {
        label: content.labels.check, rows: 3, autoGrow: true, maxHeight: 220,
        value: check, disabled, 'aria-invalid': tooLong ? true : undefined,
        'aria-describedby': tooLong ? 'm069-practice-length-error' : undefined,
        onChange: event => mark(() => setCheck(event.target.value)),
      }),
      para(content.labels.private),
      h(Button, { variant: 'primary', errorLabel: content.labels.retry,
        disabled: practice.loading || practice.saving
        || (!practice.locked && (!allValid || !outcome.trim() || !check.trim())), onClick: save },
        practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      tooLong ? para(practice.status, { id: 'm069-practice-length-error', role: 'alert' }) : null,
      practice.status && !tooLong ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm069-example-heading' },
      heading(content.example.title, 'h2', 'm069-example-heading'), para(content.example.body)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm069-source-heading' },
      heading(content.labels.source, 'h2', 'm069-source-heading'),
      para(content.source.excerpt), para(content.source.manuscript), para(content.source.boundary)));
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
