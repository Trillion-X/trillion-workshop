import React, { useState } from 'react';
import { Button, Container, Text, Textarea, mountReactSurface } from '@trillion/ui';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import content from './lesson-content.json';

const h = React.createElement;
const relationKeys = ['causal', 'practical', 'value', 'assumed'];
const emptyLink = id => ({ id, reason: '', relation: 'assumed', check: '', finding: '' });

function parseResult(value) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.statement === 'string' && Array.isArray(parsed.links)) {
      return {
        statement: parsed.statement,
        links: parsed.links.filter(row => row && typeof row.id === 'string').map(row => ({
          id: row.id,
          reason: typeof row.reason === 'string' ? row.reason : '',
          relation: relationKeys.includes(row.relation) ? row.relation : 'assumed',
          check: typeof row.check === 'string' ? row.check : '',
          finding: typeof row.finding === 'string' ? row.finding : '',
        })),
      };
    }
  } catch { /* Keep an older plain-text result visible as the starting statement. */ }
  return { statement: typeof value === 'string' ? value : '', links: [] };
}

function parseTransfer(value) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return {
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : '',
      response: typeof parsed.response === 'string' ? parsed.response : '',
    };
  } catch { /* A malformed endpoint stays blank; the starting statement is still restored. */ }
  return { endpoint: '', response: '' };
}

function Lesson({ surfaceInput, host }) {
  const [statement, setStatement] = useState('');
  const [links, setLinks] = useState([]);
  const [endpoint, setEndpoint] = useState('');
  const [response, setResponse] = useState('');
  const [nextId, setNextId] = useState(1);
  const practice = useLessonPractice({
    host,
    surfaceInput,
    fields: ['result'],
    messages: content.feedback,
    requestPrefix: 'm048-because-of-chains',
    onRestore: record => {
      const restored = parseResult(record.result);
      setStatement(restored.statement);
      setLinks(restored.links);
      const greatestId = restored.links.reduce((maximum, row) => {
        const match = /^reason-(\d+)$/.exec(row.id);
        return match ? Math.max(maximum, Number(match[1])) : maximum;
      }, 0);
      setNextId(greatestId + 1);
      const restoredTransfer = parseTransfer(record.transfer);
      setEndpoint(restoredTransfer.endpoint);
      setResponse(restoredTransfer.response);
    },
  });
  const disabled = practice.loading || practice.locked;
  const heading = (text, level = 'h2', id) => h(Text, {
    as: level,
    id,
    variant: ({ h1: 'heading-xl', h2: 'heading-lg', h3: 'heading-md' })[level],
  }, text);
  const p = text => h(Text, { as: 'p', variant: 'body' }, text);
  const label = (text, id) => h(Text, { as: 'label', variant: 'body', htmlFor: id }, text);
  const setStatementValue = value => {
    practice.markEdited();
    setStatement(value);
    practice.setValue('result', JSON.stringify({ statement: value, links }));
  };
  const updateLink = (id, key, value) => {
    practice.markEdited();
    const next = links.map(row => row.id === id ? { ...row, [key]: value } : row);
    setLinks(next);
    practice.setValue('result', JSON.stringify({ statement, links: next }));
  };
  const addLink = () => {
    practice.markEdited();
    const next = [...links, emptyLink(`reason-${nextId}`)];
    setLinks(next);
    practice.setValue('result', JSON.stringify({ statement, links: next }));
    setNextId(value => value + 1);
  };
  const removeLink = id => {
    practice.markEdited();
    const next = links.filter(row => row.id !== id);
    setLinks(next);
    practice.setValue('result', JSON.stringify({ statement, links: next }));
  };
  const setEndpointValue = value => { practice.markEdited(); setEndpoint(value); };
  const setResponseValue = value => { practice.markEdited(); setResponse(value); };

  const sourcePanel = h(Container, {
    as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm048-source',
  }, heading(content.labels.source, 'h2', 'm048-source'), p(content.teaching.sourceSummary));
  const example = content.teaching.example;
  const examplePanel = h(Container, {
    as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm048-example',
  },
  heading(content.labels.example, 'h2', 'm048-example'),
  p(`Statement: ${example.statement}`), p(`Reason: ${example.reason}`), p(example.relationship),
  p(`Check: ${example.check}`), p(`What it could show: ${example.finding}`), p(`Response: ${example.response}`));

  const linkCards = links.length ? links.map((row, index) => h(Container, {
    key: row.id,
    as: 'section',
    border: 'all',
    padding: 'md',
    gap: 'sm',
    'aria-labelledby': `m048-link-heading-${row.id}`,
  },
  heading(`${content.labels.link} ${index + 1}`, 'h3', `m048-link-heading-${row.id}`),
  h(Container, { gap: 'xs' },
    label(content.labels.link, `m048-reason-${row.id}`),
    h(Textarea, {
      id: `m048-reason-${row.id}`,
      rows: 2,
      autoGrow: true,
      maxHeight: 160,
      'aria-label': `${content.labels.link} ${index + 1}`,
      value: row.reason,
      disabled,
      onChange: event => updateLink(row.id, 'reason', event.target.value),
    })),
  h(Container, { gap: 'xs' },
    h(Text, { as: 'span', variant: 'body', id: `m048-relation-label-${row.id}` }, content.labels.relation),
    h(Container, { layout: 'horizontal', wrap: 'wrap', gap: 'sm', role: 'group', 'aria-label': content.labels.relation },
      ...relationKeys.map(key => h(Button, {
        key,
        variant: row.relation === key ? 'primary' : 'secondary',
        'aria-pressed': row.relation === key,
        disabled,
        onClick: () => updateLink(row.id, 'relation', key),
      }, content.labels[key])))),
  h(Container, { gap: 'xs' },
    label(content.labels.check, `m048-check-${row.id}`),
    h(Textarea, {
      id: `m048-check-${row.id}`,
      rows: 2,
      autoGrow: true,
      maxHeight: 160,
      value: row.check,
      disabled,
      onChange: event => updateLink(row.id, 'check', event.target.value),
    })),
  h(Container, { gap: 'xs' },
    label(content.labels.finding, `m048-finding-${row.id}`),
    h(Textarea, {
      id: `m048-finding-${row.id}`,
      rows: 2,
      autoGrow: true,
      maxHeight: 160,
      value: row.finding,
      disabled,
      onChange: event => updateLink(row.id, 'finding', event.target.value),
      placeholder: content.labels.emptyFinding,
    })),
  h(Button, { variant: 'secondary', disabled, onClick: () => removeLink(row.id) }, `${content.labels.remove} ${index + 1}`)))
    : p(content.labels.addFirst);

  const save = h(Container, {
    as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm048-private',
  },
  heading(content.labels.private, 'h2', 'm048-private'),
  p(content.labels.privateHelp),
  h(Button, {
    variant: 'primary',
    disabled: practice.loading || practice.saving || !statement.trim()
      || JSON.stringify({ statement, links }).length > 2000,
    onClick: () => practice.save({
      transfer: JSON.stringify({ endpoint, response }),
    }),
  }, practice.saving ? content.labels.busy : practice.locked ? content.labels.retry : content.labels.save),
  practice.status ? h(Text, { as: 'p', role: 'status', 'aria-live': 'polite' }, practice.status) : null,
  practice.locked ? p(content.feedback.retryPending) : null);

  return h(Container, { as: 'main', maxWidth: '4xl', marginX: 'auto', width: 'full', padding: 'lg', gap: 'lg' },
    h(Container, { gap: 'sm' }, heading(content.title, 'h1'), p(content.opening)),
    h(Container, { as: 'section', gap: 'md', 'aria-labelledby': 'm048-chain-heading' },
      heading('Build a chain', 'h2', 'm048-chain-heading'),
      h(Container, { gap: 'xs' },
        label(content.labels.statement, 'm048-statement'),
        p(content.labels.statementHelp),
        h(Textarea, {
          id: 'm048-statement',
          rows: 2,
          autoGrow: true,
          maxHeight: 160,
          value: statement,
          disabled,
          onChange: event => setStatementValue(event.target.value),
        })),
      linkCards,
      h(Button, { variant: 'secondary', disabled, onClick: addLink }, content.labels.add),
      h(Container, {
        as: 'section', border: 'all', padding: 'md', gap: 'sm', 'aria-labelledby': 'm048-endpoint',
      },
      heading(content.labels.endpoint, 'h3', 'm048-endpoint'),
      p('Stop when the next question adds no useful information. A practical need, a value conflict, an assumption or an open question can each be an endpoint.'),
      h(Container, { gap: 'xs' },
        label(content.labels.stopReason, 'm048-stop'),
        h(Textarea, {
          id: 'm048-stop', rows: 2, autoGrow: true, maxHeight: 160, value: endpoint, disabled,
          onChange: event => setEndpointValue(event.target.value),
        })),
      h(Container, { gap: 'xs' },
        label(content.labels.response, 'm048-response'),
        p(content.labels.responseHelp),
        h(Textarea, {
          id: 'm048-response', rows: 3, autoGrow: true, maxHeight: 200, value: response, disabled,
          onChange: event => setResponseValue(event.target.value),
        })))),
    examplePanel,
    sourcePanel,
    save);
}

export function mount(element, { surfaceInput, host }) {
  return mountReactSurface(element, h(Lesson, { surfaceInput, host }));
}
