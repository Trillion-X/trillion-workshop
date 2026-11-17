import React, { useRef, useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const emptyFinding = id => ({ id, method: '', candidate: '', examples: '', context: '', origin: '', groups: [] });
const safeObject = value => {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
};
const cleanFindings = value => Array.isArray(value)
  ? value.filter(row => row && typeof row === 'object' && typeof row.id === 'string').map(row => ({
    ...emptyFinding(row.id),
    method: typeof row.method === 'string' ? row.method : '',
    candidate: typeof row.candidate === 'string' ? row.candidate : '',
    examples: typeof row.examples === 'string' ? row.examples : '',
    context: typeof row.context === 'string' ? row.context : '',
    origin: typeof row.origin === 'string' ? row.origin : '',
    groups: Array.isArray(row.groups) ? row.groups.filter(key => content.groups.includes(key)) : [],
  })) : [];

function Lesson({ surfaceInput, host }) {
  const nextId = useRef(0);
  const [findings, setFindings] = useState([]);
  const [investigations, setInvestigations] = useState({});
  const [account, setAccount] = useState('');
  const [action, setAction] = useState('');
  const [resultTooLong, setResultTooLong] = useState(false);
  const [transferTooLong, setTransferTooLong] = useState(false);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm068-insight-stacking',
    onRestore: record => {
      const restored = safeObject(record.result);
      const rows = cleanFindings(restored?.findings);
      setFindings(rows);
      nextId.current = rows.reduce((max, row) => {
        const match = /^finding-(\d+)$/.exec(row.id);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0);
      const transfer = safeObject(record.transfer);
      const incoming = transfer?.investigations;
      setInvestigations(incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {});
      setAccount(typeof transfer?.account === 'string' ? transfer.account : '');
      setAction(typeof transfer?.action === 'string' ? transfer.action : '');
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (words, level = 'h2', id) => h(Text, {
    as: level, id, variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, words);
  const p = (words, props = {}) => h(Text, { as: 'p', variant: 'body', ...props }, words);
  const field = ({ id, label, value, onChange, rows = 2 }) => h(Container, { gap: 'xs' },
    h(Text, { as: 'label', variant: 'body', htmlFor: id }, label),
    h(Textarea, {
      id, rows, autoGrow: true, maxHeight: rows > 2 ? 220 : 160, 'aria-label': label,
      value, disabled,
      'aria-invalid': resultTooLong || transferTooLong ? 'true' : undefined,
      'aria-describedby': resultTooLong || transferTooLong ? 'm068-practice-length-error' : undefined,
      onChange: event => onChange(event.target.value),
    }));
  const resultValue = rows => JSON.stringify({ findings: rows });
  const transferValue = (rows = findings, currentInvestigations = investigations, currentAccount = account, currentAction = action) => JSON.stringify({
    investigations: Object.fromEntries(rows.map(row => [row.id, currentInvestigations[row.id] ?? {}])),
    account: currentAccount,
    action: currentAction,
  });
  const sync = (rows = findings, currentInvestigations = investigations, currentAccount = account, currentAction = action) => {
    const result = resultValue(rows);
    const transfer = transferValue(rows, currentInvestigations, currentAccount, currentAction);
    const tooLongResult = result.length > 2000;
    const tooLongTransfer = transfer.length > 2000;
    setResultTooLong(tooLongResult);
    setTransferTooLong(tooLongTransfer);
    practice.markEdited();
    if (!tooLongResult) practice.setValue('result', result);
    return !tooLongResult && !tooLongTransfer;
  };
  const addFinding = () => {
    if (disabled) return;
    const row = emptyFinding(`finding-${nextId.current + 1}`);
    const next = [...findings, row];
    nextId.current += 1;
    setFindings(next);
    sync(next);
  };
  const updateFinding = (id, key, value) => {
    const next = findings.map(row => row.id === id ? { ...row, [key]: value } : row);
    setFindings(next);
    sync(next);
  };
  const toggleGroup = (id, group) => {
    const next = findings.map(row => row.id === id ? {
      ...row,
      groups: row.groups.includes(group) ? row.groups.filter(value => value !== group) : [...row.groups, group],
    } : row);
    setFindings(next);
    sync(next);
  };
  const updateInvestigation = (id, key, value) => {
    const next = { ...investigations, [id]: { ...(investigations[id] ?? {}), [key]: value } };
    setInvestigations(next);
    sync(findings, next);
  };
  const updateAccount = value => { setAccount(value); sync(findings, investigations, value, action); };
  const updateAction = value => { setAction(value); sync(findings, investigations, account, value); };
  const removeFinding = id => {
    const next = findings.filter(row => row.id !== id);
    const nextInvestigations = { ...investigations };
    delete nextInvestigations[id];
    setFindings(next);
    setInvestigations(nextInvestigations);
    sync(next, nextInvestigations);
  };
  const completeFindingCount = findings.filter(row => row.method.trim() && row.candidate.trim() && row.examples.trim()).length;
  const canSave = completeFindingCount > 0 && !resultTooLong && !transferTooLong && !practice.loading && !practice.saving;
  const findingCards = findings.length ? h(Container, { gap: 'md' }, ...findings.map((row, index) => {
    const review = investigations[row.id] ?? {};
    const short = String(index + 1);
    const update = (key, value) => updateFinding(row.id, key, value);
    const reviewField = (key, label, rows = 2) => field({
      id: `m068-${row.id}-${key}`,
      label,
      rows,
      value: typeof review[key] === 'string' ? review[key] : '',
      onChange: value => updateInvestigation(row.id, key, value),
    });
    return h(Container, { key: row.id, as: 'section', border: 'all', padding: 'md', gap: 'md', 'aria-labelledby': `m068-finding-${row.id}` },
      heading(`${content.labels.findings} ${short}`, 'h3', `m068-finding-${row.id}`),
      field({ id: `m068-${row.id}-method`, label: content.labels.method, value: row.method, onChange: value => update('method', value) }),
      field({ id: `m068-${row.id}-candidate`, label: content.labels.candidate, value: row.candidate, onChange: value => update('candidate', value) }),
      field({ id: `m068-${row.id}-examples`, label: content.labels.examples, value: row.examples, rows: 3, onChange: value => update('examples', value) }),
      field({ id: `m068-${row.id}-context`, label: content.labels.context, value: row.context, onChange: value => update('context', value) }),
      field({ id: `m068-${row.id}-origin`, label: content.labels.origin, value: row.origin, onChange: value => update('origin', value) }),
      h(Container, { gap: 'sm', role: 'group', 'aria-label': content.labels.groups },
        h(Text, { as: 'p', variant: 'body' }, content.labels.groups),
        h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm' }, ...content.groups.map(group => h(Button, {
          key: group, variant: row.groups.includes(group) ? 'primary' : 'secondary',
          'aria-pressed': row.groups.includes(group), disabled,
          onClick: () => toggleGroup(row.id, group),
        }, content.groupLabels[group])))),
      heading(content.labels.investigate, 'h3'),
      reviewField('context', content.labels.contextDifference),
      reviewField('wording', content.labels.wording),
      reviewField('constraints', content.labels.constraints),
      reviewField('preference', content.labels.preference, 3),
      h(Button, { variant: 'secondary', disabled, onClick: () => removeFinding(row.id) }, content.labels.remove));
  })) : p(content.labels.needFindings);
  const example = h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm068-example-heading' },
    heading(content.example.title, 'h2', 'm068-example-heading'),
    p(content.example.first),
    p(content.example.second),
    p(content.example.account),
    p(content.example.action));
  const source = h(Container, { as: 'details', border: 'all', padding: 'md', gap: 'sm' },
    h(Text, { as: 'summary', variant: 'heading-md' }, content.labels.sourceTitle),
    p(content.labels.sourceExcerpt));
  const save = h(Container, { as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm068-private-heading' },
    heading('Private practice', 'h2', 'm068-private-heading'),
    p(content.labels.private),
    resultTooLong || transferTooLong ? h(Text, { as: 'p', id: 'm068-practice-length-error', role: 'alert' }, content.labels.oversize) : null,
    h(Button, {
      variant: 'primary', disabled: !canSave,
      onClick: () => practice.save({ transfer: transferValue() }),
    }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
    practice.status ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
    practice.locked ? p(content.feedback.retryPending) : null);

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm068-findings-heading' },
      heading(content.labels.findings, 'h2', 'm068-findings-heading'),
      p('Keep each method, example and context together. Mark a finding in more than one group when the evidence supports it.'),
      findingCards,
      h(Button, { variant: 'secondary', disabled, onClick: addFinding }, content.labels.add)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm068-account-heading' },
      heading('Combine without hiding differences', 'h2', 'm068-account-heading'),
      field({ id: 'm068-account', label: content.labels.account, value: account, rows: 3, onChange: updateAccount }),
      field({ id: 'm068-action', label: content.labels.action, value: action, rows: 2, onChange: updateAction })),
    save,
    example,
    source);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
