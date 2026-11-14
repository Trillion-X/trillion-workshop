import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readActionGuards } from '../read-data/read-ai-action-guards';
import { ActionGuardPanel } from './ActionGuardPanel';

describe('ActionGuardPanel', () => {
  it('shows consumed usage and history without converting past approval into current permission', () => {
    const data = readActionGuards([
      { payload: { kind: 'ai-guard-limit', id: 'limit:send-message', limit: 1, used: 1 } },
      { payload: { kind: 'ai-guard-state', id: 'state:send-message', allowed: false } },
      { payload: { kind: 'ai-guard-decision', id: 'past:send-message', decision: 'approved' } },
    ]);
    const html = renderToStaticMarkup(<ActionGuardPanel data={data} />);
    expect(html).toContain('0 remaining.');
    expect(html).toContain('Limit reached');
    expect(html).toContain('Pauses first');
    expect(html).toContain('Past decisions do not grant permission for a new action.');
    expect(html).not.toContain('>Available<');
  });
});
