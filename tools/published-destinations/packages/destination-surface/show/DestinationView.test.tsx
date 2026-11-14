import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DestinationDescriptor } from '../read-data/read-destination';
import { DestinationSurface } from './DestinationView';
import { createDestinationSectionRegistry } from './destination-section-registry';

afterEach(cleanup);

function descriptor(presentation: string): DestinationDescriptor {
  return {
    ref: 'destination:test',
    statement: 'Your progress',
    sections: [{ presentation, body: 'Owner-published result' }],
  };
}

describe('DestinationSurface open section registry', () => {
  it('renders a registered owner-published section without browser evaluation', () => {
    render(<DestinationSurface descriptor={descriptor('text')} registry={createDestinationSectionRegistry()} />);
    expect(screen.getByText('Your progress')).toBeTruthy();
    expect(screen.getByText('Owner-published result')).toBeTruthy();
  });

  it('shows an honest accessible fallback and retry for an unknown open key', () => {
    const onRetry = vi.fn();
    render(
      <DestinationSurface
        descriptor={descriptor('future-unseen-presentation')}
        registry={createDestinationSectionRegistry()}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('This view is unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('accepts a new renderer by registration with zero dispatcher change', () => {
    const registry = createDestinationSectionRegistry();
    registry.register('future-unseen-presentation', ({ section }) => <p>{section.body} from extension</p>);
    render(<DestinationSurface descriptor={descriptor('future-unseen-presentation')} registry={registry} />);
    expect(screen.getByText('Owner-published result from extension')).toBeTruthy();
    expect(screen.queryByText('This view is unavailable.')).toBeNull();
  });
});
