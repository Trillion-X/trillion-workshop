import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const fields = ['prediction', 'observation', 'comparison', 'result', 'revision', 'step'];
const initialExample = content.componentExamples[0].id;

function Lesson({ surfaceInput, host }) {
  const [wholeAnswer, setWholeAnswer] = useState('');
  const [limitingPart, setLimitingPart] = useState('');
  const [componentAnswers, setComponentAnswers] = useState({});
  const [rebuildAnswer, setRebuildAnswer] = useState('');
  const [selectedExample, setSelectedExample] = useState(initialExample);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const practice = useLessonPractice({ host, surfaceInput, fields, messages: content.feedback, requestPrefix: 'm028-skill-reconstruction' });
  const text = (words, as = 'p', id) => words ? h(Text, {
    as, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md', p: 'body' })[as],
  }, words) : null;
  const interactiveDisabled = practice.loading || practice.locked;
  const selectedPractice = content.componentExamples.find(item => item.id === selectedExample);

  const chooseWhole = answer => {
    if (interactiveDisabled) return;
    practice.markEdited();
    setWholeAnswer(answer);
  };
  const chooseLimit = part => {
    if (interactiveDisabled) return;
    practice.markEdited();
    setLimitingPart(part);
  };
  const chooseComponent = (id, answer) => {
    if (interactiveDisabled) return;
    practice.markEdited();
    setComponentAnswers(current => ({ ...current, [id]: answer }));
  };
  const chooseRebuild = answer => {
    if (interactiveDisabled) return;
    practice.markEdited();
    setRebuildAnswer(answer);
  };

  const choiceRow = (label, options, selected, onChoose) => h(Container, {
    layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': label,
  }, ...options.map(option => h(Button, {
    key: option.id,
    variant: selected === option.id ? 'primary' : 'secondary',
    'aria-pressed': selected === option.id,
    disabled: interactiveDisabled,
    onClick: () => onChoose(option.id),
  }, option.label)));

  const groupDiagram = ({ groups, objectName, label, selectedAnswer }) => {
    let objectIndex = 0;
    return h(Container, {
      as: 'ol', layout: 'horizontal', wrap: true, alignItems: 'start', width: 'full', gap: 'xs', role: 'list', 'aria-label': label,
    }, ...groups.map(group => {
      const indexStart = objectIndex;
      objectIndex += group.count;
      const groupSelected = selectedAnswer === 'right';
      return h(Container, {
        as: 'li', key: group.label, layout: 'horizontal', gap: 'sm', alignItems: 'center',
        border: groupSelected ? 'all' : undefined, background: groupSelected ? 'secondary' : undefined,
        minWidth: '240px', padding: groupSelected ? 'sm' : 'xs', rounded: groupSelected ? 'md' : undefined,
        'aria-label': `${group.label}, ${group.count} ${objectName}s${groupSelected ? ', named by the selected group answer' : ''}`,
      },
      text(group.label, 'span'),
      groupSelected ? text('✓', 'span') : null,
      h(Container, {
        as: 'ol', layout: 'horizontal', gap: 'xs', role: 'list', 'aria-label': `${group.label}: ${group.count} individual ${objectName}s`,
      }, ...Array.from({ length: group.count }, (_, localIndex) => {
        const individualSelected = selectedAnswer === 'wrong' && indexStart + localIndex < 4;
        const selection = groupSelected ? 'inside the selected group' : individualSelected ? 'one of the four individuals named by the selected answer' : 'not named by the selected answer';
        return h(Container, {
          as: 'li', key: localIndex, width: '20px', heightPx: '20px', padding: 'none', border: 'all',
          background: individualSelected ? 'secondary' : 'tertiary',
          alignItems: 'center', justifyContent: 'center',
          'aria-label': `${objectName[0].toUpperCase()}${objectName.slice(1)} ${indexStart + localIndex + 1} in ${group.label}, ${selection}`,
        }, h(Text, { as: 'span', variant: 'caption', 'aria-hidden': 'true' }, '●'));
      })));
    }));
  };

  const wholeAttempt = content.wholeAttempt;
  const firstFeedback = wholeAnswer
    ? wholeAnswer === 'right'
      ? wholeAttempt.rightLabel
      : wholeAttempt.wrongLabel
    : '';
  const limitingFeedback = limitingPart
    ? limitingPart === 'calculation'
      ? content.limitingConnection.calculationFeedback
      : content.limitingConnection.mappingFeedback
    : '';
  const rebuild = content.rebuildTask;

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'xl' },
    h(Container, { gap: 'sm' }, text(content.title, 'h1'), text(content.opening)),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm028-whole-title' },
      text(content.labels.whole, 'h2', 'm028-whole-title'),
      text(content.labels.wholePrompt),
      h(Container, { layout: 'grid', gridColumns: 3, gap: 'sm', role: 'group', 'aria-label': 'Components and prerequisites in the whole task' },
        h(Container, { border: 'all', padding: 'sm', gap: 'xs', 'aria-label': 'Total: 24 markers' }, text('Total', 'span'), text('24 markers', 'span')),
        h(Container, { border: 'all', padding: 'sm', gap: 'xs', 'aria-label': 'Group size: 6 markers per carton' }, text('Group size', 'span'), text('6 markers per carton', 'span')),
        h(Container, { border: 'all', padding: 'sm', gap: 'xs', 'aria-label': 'Requested quantity: cartons' }, text('Requested quantity', 'span'), text('cartons', 'span')),
      ),
      text(content.labels.wholeChoices),
      choiceRow(content.labels.wholeChoices, [
        { id: 'wrong', label: wholeAttempt.wrongAnswer },
        { id: 'right', label: wholeAttempt.rightAnswer },
      ], wholeAnswer, chooseWhole),
      firstFeedback ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, firstFeedback) : null,
      wholeAnswer ? groupDiagram({
        groups: wholeAttempt.groups, objectName: 'marker', selectedAnswer: wholeAnswer,
        label: 'The 24 markers are arranged in four rows of six; the selected answer highlights four individuals or four cartons',
      }) : null,
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm028-limit-title' },
      text(content.labels.limit, 'h2', 'm028-limit-title'),
      text(content.labels.limitPrompt),
      h(Container, { layout: 'grid', gridColumns: 3, gap: 'sm', role: 'group', 'aria-label': content.labels.attempt },
        h(Container, { border: 'all', padding: 'sm', gap: 'xs' }, text('Question asks for', 'span'), text('cartons', 'span')),
        h(Container, { border: 'all', padding: 'sm', gap: 'xs' }, text('Calculation gives', 'span'), text('4 groups', 'span')),
        h(Container, { border: 'all', padding: 'sm', gap: 'xs' }, text('Example answer names', 'span'), text('markers', 'span')),
      ),
      choiceRow(content.labels.limit, [
        { id: 'calculation', label: content.limitingConnection.calculationChoice },
        { id: 'mapping', label: content.limitingConnection.mappingChoice },
      ], limitingPart, chooseLimit),
      limitingFeedback ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, limitingFeedback) : null,
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm028-component-title' },
      text(content.labels.componentPractice, 'h2', 'm028-component-title'),
      text(content.labels.componentIntro),
      choiceRow(content.labels.componentPractice, content.componentExamples.map(item => ({ id: item.id, label: item.title })), selectedExample, id => {
        if (interactiveDisabled) return;
        practice.markEdited();
        setSelectedExample(id);
      }),
      h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-label': selectedPractice.prompt },
        text(selectedPractice.prompt, 'h3'),
        text(selectedPractice.equation),
        choiceRow(selectedPractice.prompt, [
          { id: 'wrong', label: selectedPractice.wrongAnswer },
          { id: 'right', label: selectedPractice.rightAnswer },
        ], componentAnswers[selectedPractice.id] ?? '', answer => chooseComponent(selectedPractice.id, answer)),
        componentAnswers[selectedPractice.id]
          ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, componentAnswers[selectedPractice.id] === 'right' ? selectedPractice.rightFeedback : selectedPractice.wrongFeedback)
          : null,
      ),
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm028-rebuild-title' },
      text(content.labels.rebuild, 'h2', 'm028-rebuild-title'),
      text(content.labels.rebuildPrompt),
      text(rebuild.equation),
      choiceRow(content.labels.rebuild, [
        { id: 'wrong', label: rebuild.wrongAnswer },
        { id: 'right', label: rebuild.rightAnswer },
      ], rebuildAnswer, chooseRebuild),
      rebuildAnswer ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, rebuildAnswer === 'right' ? rebuild.rightFeedback : rebuild.wrongFeedback) : null,
      groupDiagram({
        groups: rebuild.groups, objectName: 'guest', selectedAnswer: rebuildAnswer,
        label: 'The 28 guests are arranged in four rows of seven; the selected answer highlights four individuals or four tables',
      }),
      h(Container, { gap: 'sm' },
        text(content.followThrough.success),
        text(content.followThrough.weakness),
      ),
    ),

    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm028-plan-title' },
      text(content.labels.plan, 'h2', 'm028-plan-title'),
      ...fields.map(key => {
        const id = `m028-practice-${key}`;
        const missing = attemptedSave && !practice.values[key].trim();
        return h(Container, { key, gap: 'xs' }, h(Text, { as: 'label', variant: 'body', htmlFor: id }, content.practice[key]),
          h(Textarea, {
            id, rows: 3, autoGrow: true, maxHeight: 240, maxLength: 2000, required: true,
            'aria-invalid': missing ? 'true' : undefined,
            'aria-describedby': missing ? 'm028-practice-feedback' : undefined,
            value: practice.values[key], disabled: practice.loading || practice.locked,
            onChange: event => practice.setValue(key, event.target.value),
          }));
      }),
      practice.loading ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, 'Loading your saved plan.') : null,
      practice.locked ? text(content.feedback.retryPending) : null,
      h(Button, {
        variant: 'primary', work: null, disabled: practice.loading || practice.saving,
        onClick: () => { setAttemptedSave(true); return practice.save(); },
      }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
      practice.status ? h(Text, { as: 'p', id: 'm028-practice-feedback', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
    ),
  );
}

export function mount(element, { surfaceInput, host }) { return mountReactSurface(element, h(Lesson, { surfaceInput, host })); }
