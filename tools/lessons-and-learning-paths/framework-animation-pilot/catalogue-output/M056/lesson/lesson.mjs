import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../parts/ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const supportKinds = ['reflection', 'practical', 'company', 'other'];
const emptyResult = () => ({ supportQuestion: '', supportPath: '', response: '' });
const emptyTransfer = () => ({
  specificQuality: '',
  roleQuestion: '',
  practicalHelp: '',
  companyOffer: '',
  otherRequest: '',
  continuation: '',
});

function restoreObject(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback();
  } catch { return fallback(); }
}

function Lesson({ surfaceInput, host }) {
  const [supportQuestion, setSupportQuestion] = useState('');
  const [supportPath, setSupportPath] = useState('');
  const [specificQuality, setSpecificQuality] = useState('');
  const [roleQuestion, setRoleQuestion] = useState('');
  const [practicalHelp, setPracticalHelp] = useState('');
  const [companyOffer, setCompanyOffer] = useState('');
  const [otherRequest, setOtherRequest] = useState('');
  const [continuation, setContinuation] = useState('');
  const [lengthError, setLengthError] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm056-worth-mentoring',
    onRestore: record => {
      const result = restoreObject(record.result, emptyResult);
      const transfer = restoreObject(record.transfer, emptyTransfer);
      setSupportQuestion(typeof result.supportQuestion === 'string' ? result.supportQuestion : '');
      setSupportPath(supportKinds.includes(result.supportPath) ? result.supportPath : '');
      setSpecificQuality(typeof transfer.specificQuality === 'string' ? transfer.specificQuality : '');
      setRoleQuestion(typeof transfer.roleQuestion === 'string' ? transfer.roleQuestion : '');
      setPracticalHelp(typeof transfer.practicalHelp === 'string' ? transfer.practicalHelp : '');
      setCompanyOffer(typeof transfer.companyOffer === 'string' ? transfer.companyOffer : '');
      setOtherRequest(typeof transfer.otherRequest === 'string' ? transfer.otherRequest : '');
      setContinuation(typeof transfer.continuation === 'string' ? transfer.continuation : '');
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (text, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, text);
  const p = (text, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, text);
  const label = (text, id) => h(Text, { as: 'label', variant: 'body', htmlFor: id }, text);

  const activeResponse = () => ({
    reflection: [specificQuality, roleQuestion].filter(Boolean).join('\n'),
    practical: practicalHelp,
    company: companyOffer,
    other: otherRequest,
  })[supportPath] ?? '';
  const resultValue = (nextQuestion = supportQuestion, nextPath = supportPath, response = activeResponse()) => JSON.stringify({
    supportQuestion: nextQuestion,
    supportPath: nextPath,
    response,
  });
  const transferValue = (overrides = {}) => JSON.stringify({
    specificQuality,
    roleQuestion,
    practicalHelp,
    companyOffer,
    otherRequest,
    continuation,
    ...overrides,
  });
  const setResult = (nextQuestion = supportQuestion, nextPath = supportPath, response = activeResponse(), transferOverrides = {}) => {
    const value = resultValue(nextQuestion, nextPath, response);
    setLengthError(value.length > 2000 || transferValue(transferOverrides).length > 2000);
    practice.setValue('result', value);
  };
  const updateQuestion = value => {
    practice.markEdited();
    setSupportQuestion(value);
    setResult(value);
  };
  const updatePath = value => {
    practice.markEdited();
    setSupportPath(value);
    setResult(supportQuestion, value, '');
  };
  const updateBranchField = (key, value) => {
    practice.markEdited();
    const setters = {
      specificQuality: setSpecificQuality,
      roleQuestion: setRoleQuestion,
      practicalHelp: setPracticalHelp,
      companyOffer: setCompanyOffer,
      otherRequest: setOtherRequest,
      continuation: setContinuation,
    };
    setters[key](value);
    if (key === 'continuation') {
      setLengthError(resultValue().length > 2000 || transferValue({ continuation: value }).length > 2000);
    } else {
      const nextResponse = key === 'specificQuality' || key === 'roleQuestion'
        ? [key === 'specificQuality' ? value : specificQuality, key === 'roleQuestion' ? value : roleQuestion].filter(Boolean).join('\n')
        : key === 'practicalHelp' && supportPath === 'practical' ? value
          : key === 'companyOffer' && supportPath === 'company' ? value
            : key === 'otherRequest' && supportPath === 'other' ? value
              : activeResponse();
      setResult(supportQuestion, supportPath, nextResponse, { [key]: value });
    }
  };
  const disabledSave = practice.loading || practice.saving || lengthError
    || (!supportQuestion.trim() && !supportPath);

  const pathCopy = {
    reflection: {
      instruction: 'Continue only if they welcome reflection. Name a quality you have actually seen; ask what the changed role means to them.',
    },
    practical: {
      instruction: content.labels.billExample,
    },
    company: {
      instruction: 'Offer time together without requiring them to explain, answer questions or feel differently.',
    },
    other: {
      instruction: 'They may want something else or no conversation. Let that answer stand.',
    },
  };
  const currentPath = pathCopy[supportPath];
  const field = (id, fieldLabel, value, onChange, rows = 2) => h(Container, { gap: 'xs' },
    label(fieldLabel, id),
    h(Textarea, {
      id,
      rows,
      autoGrow: true,
      maxHeight: rows > 2 ? 200 : 160,
      value,
      disabled,
      onChange: event => onChange(event.target.value),
    }));

  const branch = currentPath ? h(Container, {
    border: 'all', padding: 'md', gap: 'md',
  },
  p(currentPath.instruction),
  supportPath === 'reflection' ? h(Container, { gap: 'md' },
    field('m056-quality', content.labels.specificQuality, specificQuality, value => updateBranchField('specificQuality', value)),
    field('m056-role-question', content.labels.roleQuestion, roleQuestion, value => updateBranchField('roleQuestion', value)))
    : supportPath === 'practical' ? field('m056-practical-help', content.labels.practicalHelp, practicalHelp, value => updateBranchField('practicalHelp', value), 3)
      : supportPath === 'company' ? field('m056-company-offer', content.labels.companyOffer, companyOffer, value => updateBranchField('companyOffer', value), 3)
        : field('m056-other-request', content.labels.otherRequest, otherRequest, value => updateBranchField('otherRequest', value), 3),
  field('m056-continuation', content.labels.continuation, continuation, value => updateBranchField('continuation', value))) : null;

  const sourceDisclosure = h(Container, {
    as: 'details', border: 'all', padding: 'md', gap: 'sm',
  }, h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.source),
  p(content.teaching.sourceSummary), p(content.teaching.sourceLocator));
  const save = h(Container, { gap: 'sm' },
  p(content.labels.privateLimit),
  lengthError ? h(Text, { as: 'p', role: 'alert' }, content.labels.tooLong) : null,
  h(Button, {
    variant: 'primary',
    disabled: disabledSave,
    onClick: () => practice.save({ transfer: transferValue({}) }),
  }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
  practice.status ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
  practice.locked ? p(content.feedback.retryPending) : null);

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
    h(Container, { as: 'section', gap: 'md' },
      h(Container, { border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm056-scenario-heading' },
        heading(content.labels.scenario, 'h3', 'm056-scenario-heading'), p(content.teaching.scenario)),
      h(Container, { gap: 'xs' },
        label(content.labels.question, 'm056-support-question'),
        p(content.teaching.openingQuestion),
        h(Textarea, {
          id: 'm056-support-question',
          rows: 3,
          autoGrow: true,
          maxHeight: 200,
          value: supportQuestion,
          disabled,
          onChange: event => updateQuestion(event.target.value),
        })),
      h(Container, { gap: 'sm' },
        h(Text, { as: 'span', variant: 'body' }, content.labels.supportKind),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.supportKind },
          ...supportKinds.map(key => h(Button, {
            key,
            variant: supportPath === key ? 'primary' : 'secondary',
            'aria-pressed': supportPath === key,
            disabled,
            onClick: () => updatePath(key),
          }, content.labels[key]))),
        p(content.labels.choiceHelp)),
      branch),
    sourceDisclosure,
    save);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
