import React, { useCallback, useRef, useState } from 'react';
import { Button, Card, Container, Spinner, Text } from '@trillion/ui';
import rows from '../records/workshop-account-tool-records.json' with { type: 'json' };
import words from '../read-data/screen-words.json' with { type: 'json' };

export const h = React.createElement;

/** This screen's copy: its own words, with the shared ones it falls back to. */
export const wordsFor = slug => ({ ...words.shared, ...words[slug] });

/** This tool's own row payload: its screen's DATA (labels, choices, shows) stays in the row and is read here, never copied. */
export function rowOf(id) {
  const row = rows.records.find(record => record.payload?.id === id);
  if (!row) throw new Error(`The tool row ${id} is not in this folder's records.`);
  return row.payload;
}

export const minutes = seconds => {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

/** A key the run is sent under. The same key comes back for the same run, so a retry after a failure reuses it. */
const newKey = tool => `${tool}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;

/**
 * Runs one tool through the screen's declared `run` request. The state is idle, running, done or failed; a failed run
 * keeps its key so Try again repeats the same run rather than starting a second one.
 */
export function useToolRun(host, tool) {
  const [state, setState] = useState({ status: 'idle' });
  const keyRef = useRef(null);
  const run = useCallback(async input => {
    keyRef.current ??= newKey(tool);
    setState({ status: 'running' });
    try {
      const raw = await host.call('run', { request_key: keyRef.current, tool, input });
      const result = raw?.structuredContent ?? raw?.result ?? raw;
      keyRef.current = null;
      setState({ status: 'done', result });
      return result;
    } catch (error) {
      setState({ status: 'failed', error });
      return null;
    }
  }, [host, tool]);
  const reset = useCallback(() => { keyRef.current = null; setState({ status: 'idle' }); }, []);
  return { state, run, reset };
}

export function Screen({ title, about, children }) {
  return h(Container, { layout: 'vertical', gap: 'lg' },
    h(Container, { layout: 'vertical', gap: 'xs' },
      h(Text, { variant: 'heading-xs' }, title),
      about ? h(Text, { variant: 'body', color: 'muted' }, about) : null,
    ),
    children,
  );
}

export function Section({ label, children }) {
  return h(Card, { className: 'ai-session-section' },
    h(Container, { layout: 'vertical', gap: 'md' },
      label ? h(Text, { variant: 'label', color: 'muted' }, label) : null,
      children,
    ),
  );
}

export function Working({ words }) {
  return h(Container, { layout: 'horizontal', gap: 'sm', alignItems: 'center', role: 'status' },
    h(Spinner, { size: 'sm', 'aria-label': words.working }),
    h(Text, { variant: 'body', color: 'muted' }, words.working),
  );
}

export function Failed({ words, onRetry }) {
  return h(Card, { role: 'alert' },
    h(Container, { layout: 'vertical', gap: 'sm' },
      h(Text, { variant: 'body', color: 'error' }, words.failed),
      onRetry ? h(Button, { variant: 'outline', size: 'sm', onClick: onRetry }, words.tryAgain) : null,
    ),
  );
}
