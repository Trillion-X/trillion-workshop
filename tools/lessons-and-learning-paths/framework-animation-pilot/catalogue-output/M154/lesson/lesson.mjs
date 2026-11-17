import React, { useState } from 'react';
import { Button, ChoiceTiles, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;
const blankDraft = () => ({ disposition: '', result: '', steward: '', feedback: '' });

function parseRecord(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      disposition: typeof parsed.disposition === 'string' ? parsed.disposition : '',
      result: typeof parsed.result === 'string' ? parsed.result : '',
      steward: typeof parsed.steward === 'string' ? parsed.steward : '',
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '',
    };
  } catch { return null; }
}

function Lesson({ surfaceInput, host }) {
  const [stepId, setStepId] = useState(content.steps[0].id);
  const [formId, setFormId] = useState(content.labels.forms[0].id);
  const [draft, setDraft] = useState(blankDraft);
  const [missing, setMissing] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm154-useful-result',
    onRestore: record => {
      const restored = parseRecord(record.result);
      if (restored) setDraft(restored);
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const selectedStep = content.steps.find(step => step.id === stepId) ?? content.steps[0];
  const selectedForm = content.labels.forms.find(form => form.id === formId) ?? content.labels.forms[0];
  const selectedDisposition = content.dispositions.find(item => item.id === draft.disposition);
  const tabs = content.steps.map(step => ({ id: step.id, label: step.label, icon: step.icon }));
  const formTabs = content.labels.forms.map(form => ({ id: form.id, label: form.label, icon: form.icon, description: form.description }));
  const actionTiles = content.dispositions.map(item => ({ id: item.id, label: item.label, description: item.description }));
  const serialized = JSON.stringify(draft);
  const tooLong = serialized.length > 2000 || practice.status === content.feedback.length;
  const longestField = ['result', 'steward', 'feedback'].sort((a, b) => draft[b].length - draft[a].length)[0];
  const requiredMissing = key => missing && !draft[key].trim();
  const update = change => {
    setMissing(false);
    practice.markEdited();
    change();
  };
  const setDisposition = item => update(() => setDraft(previous => ({ ...previous, disposition: item.id })));
  const setField = key => event => update(() => setDraft(previous => ({ ...previous, [key]: event.target.value })));
  const field = (key, label) => h(Container, { key, gap: 'xs' }, h(Textarea, {
    key,
    id: `m154-${key}`,
    label,
    rows: 2,
    autoGrow: true,
    maxHeight: 180,
    value: draft[key],
    disabled,
    'aria-invalid': requiredMissing(key) || (tooLong && longestField === key) ? true : undefined,
    'aria-describedby': requiredMissing(key) ? 'm154-missing-error'
      : tooLong && longestField === key ? 'm154-length-error' : undefined,
    onChange: setField(key),
  }), tooLong && longestField === key ? para(content.feedback.length, {
    id: 'm154-length-error', role: 'alert', 'aria-live': 'polite',
  }) : null);
  const save = async () => {
    if (!draft.disposition || !draft.result.trim() || !draft.steward.trim() || !draft.feedback.trim()) {
      setMissing(true);
      return false;
    }
    if (tooLong) return false;
    practice.setValue('result', serialized);
    return practice.save();
  };

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { as: 'header', gap: 'sm' }, heading(content.title, 'h1', 'm154-title'), para(content.opening)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm154-sequence-heading' },
      h(Container, { gap: 'sm' }, heading('Follow the result', 'h2', 'm154-sequence-heading'), para(content.labels.sequence)),
      h(ChoiceTiles, {
        tiles: tabs,
        chosen: selectedStep.id,
        onPick: step => setStepId(step.id),
        kind: 'tabs',
        label: 'Seven parts of the continuation decision',
      }),
      h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm154-selected-step' },
        heading(selectedStep.label, 'h3', 'm154-selected-step'),
        para(selectedStep.source),
        para(selectedStep.prompt),
        para(selectedStep.check))),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm154-compare-heading' },
      h(Container, { gap: 'sm' }, heading(content.labels.comparison, 'h2', 'm154-compare-heading'), para(content.labels.comparisonIntro)),
      h(ChoiceTiles, {
        tiles: formTabs,
        chosen: selectedForm.id,
        onPick: form => setFormId(form.id),
        kind: 'tabs',
        label: 'Forms for keeping the drill useful',
      }),
      h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm154-form-heading' },
        heading(selectedForm.label, 'h3', 'm154-form-heading'),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'md' },
          h(Container, { gap: 'xs' }, heading('Added benefit', 'h3'), para(selectedForm.benefit)),
          h(Container, { gap: 'xs' }, heading('Total burden', 'h3'), para(selectedForm.burden)),
          h(Container, { gap: 'xs' }, heading('What must be true', 'h3'), para(selectedForm.mustBeTrue))))),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm154-disposition-heading' },
      h(Container, { gap: 'sm' }, heading('Choose a disposition', 'h2', 'm154-disposition-heading'),
        para('Use the source options to compare what continuing the result would ask of an actual steward. No choice is automatic.')),
      h(ChoiceTiles, {
        tiles: actionTiles,
        chosen: draft.disposition || null,
        onPick: setDisposition,
        kind: 'radio',
        label: 'Choose a disposition (required for private practice)',
        disabled,
      }),
      selectedDisposition ? h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm154-commitment-heading' },
        heading('What this disposition commits to', 'h3', 'm154-commitment-heading'),
        para(selectedDisposition.description)) : null),
    h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
      h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.source),
      para(content.labels.sourceQuote), para(content.labels.sourceLocator),
      para(content.labels.sourceAttribution), para(content.labels.sourceBoundary)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm154-practice-heading' },
      h(Container, { gap: 'sm' }, heading(content.labels.practice, 'h2', 'm154-practice-heading'),
        para(content.labels.practiceIntro), para(content.labels.privateNote)),
      h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm154-practice-fields' },
        heading('Private practice', 'h3', 'm154-practice-fields'),
        field('result', content.labels.resultLabel),
        field('steward', content.labels.stewardLabel),
        field('feedback', content.labels.feedbackLabel),
        missing ? para(content.feedback.missing, { id: 'm154-missing-error', role: 'alert', 'aria-live': 'polite' }) : null,
        h(Button, {
          variant: 'primary',
          fullWidth: true,
          disabled: practice.loading || practice.saving || (!practice.locked && tooLong),
          onClick: () => void save(),
        }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
        practice.status && !tooLong ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
        practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null)));
}

export function mount(element, { surfaceInput = {}, host } = {}) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
