import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json' with { type: 'json' };

const h = React.createElement;

function Lesson({ surfaceInput, host }) {
  const [view, setView] = useState('target');
  const [outcome, setOutcome] = useState(null);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [missing, setMissing] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields: ['prediction'], messages: content.feedback,
    requestPrefix: 'm144-prediction',
    onRestore: record => {
      if (typeof record.prediction === 'string') { setDraft(record.prediction); setDirty(false); }
    },
  });
  const unavailable = practice.loading || practice.locked;
  const tooLong = draft.length > 2000;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const para = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const update = value => {
    setDraft(value);
    setDirty(true);
    setMissing(false);
    practice.markEdited();
    practice.setValue('prediction', value);
  };
  const save = () => {
    if (!draft.trim()) { setMissing(true); return; }
    if (tooLong) return;
    practice.setValue('prediction', draft);
    return practice.save().then(saved => { if (saved) setDirty(false); return saved; });
  };
  const saveWork = practice.saving ? 'pending'
    : practice.status === content.feedback.saved && !dirty ? 'done'
      : [content.feedback.conflict, content.feedback.saveFailure, content.feedback.readbackFailure].includes(practice.status) ? 'error' : null;
  const fieldError = tooLong ? 'm144-prediction-length-error' : undefined;
  const sourcePanel = h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
    h(Text, { as: 'summary' }, content.labels.source),
    para(content.labels.sourceQuote, { wrap: 'preserve' }),
    para(content.labels.sourceLocator),
    para(content.labels.sourceDisclosure));
  return h(Container, { as: 'main', maxWidth: '5xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), para(content.opening)),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm144-comparison-heading' },
      heading(content.labels.comparison, 'h2', 'm144-comparison-heading'),
      para(content.labels.comparisonIntro),
      para(content.labels.comparisonDisclosure),
      h(Container, { as: 'div', role: 'group', 'aria-label': content.labels.comparison, layout: 'responsive-split', gap: 'sm' },
        ...[['target', content.labels.targetMode], ['prediction', content.labels.predictionMode]].map(([key, label]) => h(Button, {
          key, variant: view === key ? 'primary' : 'secondary', 'aria-pressed': view === key,
          onClick: () => setView(key),
        }, label))),
      heading(view === 'target' ? content.labels.targetHeading : content.labels.predictionHeading, 'h3'),
      para(view === 'target' ? content.labels.targetText : content.labels.predictionText),
      para(view === 'target' ? content.labels.targetEffect : content.labels.predictionEffect),
      h(Container, { as: 'div', role: 'group', 'aria-label': content.labels.evidenceQuestion, layout: 'responsive-split', gap: 'sm' },
        ...[['selected', content.labels.selectLabel], ['missed', content.labels.missLabel]].map(([key, label]) => h(Button, {
          key, variant: outcome === key ? 'primary' : 'secondary', 'aria-pressed': outcome === key,
          onClick: () => setOutcome(key),
        }, label))),
      para(outcome === 'selected' ? content.labels.selectedEffect
        : outcome === 'missed' ? content.labels.missedEffect : content.labels.outcomePrompt, { role: 'status', 'aria-live': 'polite' })),
    h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm144-practice-heading' },
      heading(content.labels.practice, 'h2', 'm144-practice-heading'),
      para(content.labels.practiceIntro),
      h(Textarea, {
        id: 'm144-prediction', label: content.labels.practice,
        rows: 7, autoGrow: true, maxHeight: 300, value: draft, disabled: unavailable,
        'aria-invalid': tooLong || undefined,
        'aria-describedby': fieldError,
        onChange: event => update(event.currentTarget.value),
      }),
      tooLong ? para(content.labels.length, { id: 'm144-prediction-length-error', role: 'alert' }) : null,
      para(content.labels.private),
      h(Button, {
        variant: 'primary', fullWidth: true, work: saveWork,
        doneLabel: content.labels.done,
        disabled: practice.loading,
        pendingLabel: content.labels.saving,
        errorLabel: practice.locked ? content.labels.retry : content.labels.save,
        onClick: save,
      }, practice.saving ? content.labels.saving : practice.locked ? content.labels.retry : content.labels.save),
      missing ? para(content.labels.missing, { role: 'alert' }) : null,
      practice.status && !tooLong && !(dirty && practice.status === content.feedback.saved)
        ? para(practice.status, { role: 'status', 'aria-live': 'polite' }) : null,
      practice.locked ? para(content.feedback.retryPending, { role: 'status', 'aria-live': 'polite' }) : null),
    sourcePanel);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
