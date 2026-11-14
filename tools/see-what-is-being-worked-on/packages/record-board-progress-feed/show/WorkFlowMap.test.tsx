import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { projectWorkFlowMap } from '../read-data/work-flow-map';
import { WorkFlowMap } from './WorkFlowMap';

describe('WorkFlowMap', () => {
  it('does not report a clear flow when its event feed is unavailable', () => {
    render(<WorkFlowMap items={[]} feedState="unavailable" />);
    expect(screen.getByText('The event feed is unavailable.')).toBeTruthy();
    expect(screen.getByText('There are no observations to check yet.')).toBeTruthy();
    expect(screen.queryByText('No missing source or task links in these records.')).toBeNull();
  });
  it('does not imply a task or transition that has not been recorded', () => {
    const items = projectWorkFlowMap([
      { id: 'message:1', source: { address: 'codex:thread:1', label: 'Codex task' }, producer: 'codex', occurredAtMs: 100, state: 'received', summary: 'Message received' },
    ], [{ address: 'x:bookmarks', label: 'X bookmarks' }], 200, 1000);
    render(<WorkFlowMap items={items} />);
    expect(screen.getByText('Message received')).toBeTruthy();
    expect(screen.getByText('No linked task recorded')).toBeTruthy();
    expect(screen.getByText('No event received from this source.')).toBeTruthy();
    expect(screen.queryByText('Task created')).toBeNull();
  });
});
