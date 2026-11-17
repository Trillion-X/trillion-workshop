import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = Object.keys(content.practice);

function Lesson({ surfaceInput, host }) {
  const [activity, setActivity] = useState('');
  const [phase, setPhase] = useState('choose');
  const [choice, setChoice] = useState('');
  const [report, setReport] = useState('');
  const [noticing, setNoticing] = useState({ sound: '', sensation: '', thought: '' });
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({
    host, surfaceInput, fields, messages: content.feedback, requestPrefix: 'm034-settling-scan',
  });
  const disabled = practice.loading || practice.locked;
  const paragraph = words => words ? h(Text, { as: 'p', variant: 'body' }, words) : null;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const rememberChoice = next => {
    if (disabled) return;
    practice.markEdited();
    const task = activity.trim() || 'a task I chose';
    setChoice(next);
    setReport('');
    practice.setValue('step', task);
    practice.setValue('comparison', next === 'scan'
      ? `I chose a brief scan before ${task}.`
      : `I chose to start ${task} directly; no scan was needed.`);
    if (next === 'scan') {
      setPhase('scan');
      practice.setValue('observation', 'I chose to notice what was already present; I did not need to change it.');
    } else {
      setPhase('ready');
      practice.setValue('observation', 'I chose a direct start and skipped the scan.');
    }
  };
  const markStarted = () => {
    if (disabled) return;
    practice.markEdited();
    const task = activity.trim() || 'the task I chose';
    setPhase('started');
    practice.setValue('result', `I marked myself as started on ${task}.`);
  };
  const stopScan = () => {
    if (disabled) return;
    practice.markEdited();
    setPhase('stopped');
    practice.setValue('observation', 'I stopped or skipped the scan.');
    practice.setValue('result', 'I did not mark a task start in this interaction.');
  };
  const changeNoticing = (key, value) => {
    const next = { ...noticing, [key]: value };
    setNoticing(next);
    practice.setValue('observation', [
      'I chose to notice what was already present; I did not need to change it.',
      ...['sound', 'sensation', 'thought'].map(item => `${content.labels[item]}: ${next[item]}`),
    ].join('\n'));
  };
  const options = (label, rows, selected, onChoose) => h(Container, {
    layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': label,
  }, ...rows.map(row => h(Button, {
    key: row.id, variant: selected === row.id ? 'primary' : 'secondary',
    'aria-pressed': selected === row.id, disabled,
    onClick: () => onChoose(row.id),
  }, row.label)));

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), paragraph(content.opening)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm034-start-heading' },
      heading('Choose a task', 'h2', 'm034-start-heading'),
      h(Container, { gap: 'xs' },
        h(Text, { as: 'label', variant: 'body', htmlFor: 'm034-activity' }, content.labels.activity),
        h(Textarea, {
          id: 'm034-activity', rows: 1, autoGrow: true, maxHeight: 80, maxLength: 500,
          value: activity, disabled,
          onChange: event => {
            const next = event.target.value;
            setActivity(next);
            practice.setValue('step', next);
          },
        })),
      options('Choose how to begin', [
        { id: 'scan', label: content.labels.scan }, { id: 'direct', label: content.labels.direct },
      ], choice, id => rememberChoice(id)),
      phase === 'scan'
        ? h(Container, { border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': 'm034-noticing-heading' },
            heading(content.labels.noticing, 'h3', 'm034-noticing-heading'),
            paragraph('Sit comfortably. Notice a sound, a bodily sensation, and a thought if you want. Thoughts may remain or wander; there is nothing to clear or change.'),
            ...[
              ['sound', content.labels.sound], ['sensation', content.labels.sensation], ['thought', content.labels.thought],
            ].map(([key, label]) => h(Container, { key, gap: 'xs' },
              h(Text, { as: 'label', variant: 'body', htmlFor: `m034-${key}` }, label),
              h(Textarea, {
                id: `m034-${key}`, rows: 1, autoGrow: true, maxHeight: 96, maxLength: 500,
                value: noticing[key], disabled,
                onChange: event => changeNoticing(key, event.target.value),
              }))),
            h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm' },
              h(Button, { variant: 'primary', disabled, onClick: markStarted }, content.labels.begin),
              h(Button, { variant: 'secondary', disabled, onClick: () => rememberChoice('direct') }, content.labels.skip),
              h(Button, { variant: 'secondary', disabled, onClick: stopScan }, content.labels.stop)))
        : null,
      phase === 'ready'
        ? h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm' },
            h(Button, { variant: 'primary', disabled, onClick: markStarted }, content.labels.begin),
            choice === 'direct' ? null : h(Button, { variant: 'secondary', disabled, onClick: () => rememberChoice('direct') }, content.labels.skip))
        : null,
      phase === 'started'
        ? h(Container, { gap: 'sm' },
            h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, 'You marked the task as started.'),
            heading(content.labels.report, 'h3', 'm034-report-heading'),
            options(content.labels.reportGroup, content.reports, report, id => {
              const row = content.reports.find(item => item.id === id);
              setReport(id);
              practice.markEdited();
              practice.setValue('revision', `For this task, I reported: ${row.label}.`);
            }),
            report ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' },
              `Your report: ${content.reports.find(row => row.id === report).label}.`) : null)
        : null,
      phase === 'stopped'
        ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, 'You stopped or skipped the scan. You can end here or choose a direct start; nothing needs to be completed.')
        : null,
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm034-practice-heading' },
      heading(content.labels.practice, 'h2', 'm034-practice-heading'),
      ...fields.map(key => {
        const id = `m034-practice-${key}`;
        const missing = attemptedSave && !practice.values[key].trim();
        return h(Container, { key, gap: 'xs' },
          h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, {
            id, rows: 3, autoGrow: true, maxHeight: 240, maxLength: 2000, required: true,
            'aria-invalid': missing ? 'true' : undefined,
            'aria-describedby': missing ? 'm034-practice-feedback' : undefined,
            value: practice.values[key], disabled,
            onChange: event => practice.setValue(key, event.target.value),
          }));
      }),
      practice.loading ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, 'Loading your saved private notes.') : null,
      practice.locked ? paragraph(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary', work: null, disabled: practice.loading || practice.saving,
        onClick: () => { setAttemptedSave(true); return practice.save(); },
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? h(Text, { as: 'p', id: 'm034-practice-feedback', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
    ),
  );
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
