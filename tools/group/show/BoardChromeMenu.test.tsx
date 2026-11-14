import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from '../../ui';
import { BoardChromeMenu } from './BoardChromeMenu';

afterEach(() => cleanup());

describe('BoardChromeMenu', () => {
  it('dismisses for a child dialog and stays closed when the dialog closes', () => {
    const groups = [{ label: 'Transfer', defaultOpen: true, children: <Button>Export</Button> }];
    const { rerender } = render(<BoardChromeMenu label="Board" groups={groups} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open board menu' }));
    expect(screen.getByText('Export')).not.toBeNull();
    rerender(<BoardChromeMenu label="Board" groups={groups} dismissWhen />);
    expect(screen.queryByText('Export')).toBeNull();
    rerender(<BoardChromeMenu label="Board" groups={groups} dismissWhen={false} />);
    expect(screen.queryByText('Export')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open board menu' }));
    expect(screen.getByText('Export')).not.toBeNull();
  });
  it('keeps grouped controls out of the persistent chrome until opened', () => {
    render(
      <BoardChromeMenu
        label="Add"
        groups={[
          { label: 'Create', defaultOpen: true, children: <Button>Note</Button> },
          { label: 'Custom actions', children: <Button>Generate</Button> },
        ]}
      />,
    );

    expect(screen.queryByText('Note')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open add menu' }));
    expect(screen.getByText('Note')).not.toBeNull();
    expect(screen.queryByText('Generate')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Custom actions' }));
    expect(screen.getByText('Generate')).not.toBeNull();
  });
});
