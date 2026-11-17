// tools/ui/show/form-alert/FormAlert.test.tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FormAlert } from './FormAlert';

afterEach(cleanup);

describe('FormAlert', () => {
  it('prerenders standalone as an alert with a hidden icon, the title and the line', () => {
    const html = renderToStaticMarkup(<FormAlert title="Wrong code" message="Ask for a new one." />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('Wrong code');
    expect(html).toContain('Ask for a new one.');
    expect(html).not.toContain('<button');
  });

  it('renders the next action as a button that takes focus and fires', () => {
    const onAction = vi.fn();
    render(<FormAlert title="Link expired" action={{ label: 'Send a new link', onAction }} />);
    const btn = screen.getByRole('button', { name: 'Send a new link' });
    expect(document.activeElement).toBe(btn);
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
