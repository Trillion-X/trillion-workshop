// tools/ui/show/password-field/PasswordField.test.tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PasswordField } from './PasswordField';

afterEach(cleanup);

const words = { label: 'Password', showLabel: 'Show password', hideLabel: 'Hide password' };

describe('PasswordField', () => {
  it('prerenders a labelled password input with a named toggle and no link when none is given', () => {
    const html = renderToStaticMarkup(<PasswordField {...words} />);
    expect(html).toContain('type="password"');
    expect(html).toContain('<label');
    expect(html).toContain('aria-label="Show password"');
    expect(html).not.toContain('<a ');
  });

  it('the toggle switches the input between password and text and renames itself', () => {
    render(<PasswordField {...words} />);
    const input = screen.getByLabelText('Password') as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input.type).toBe('text');
    const hide = screen.getByRole('button', { name: 'Hide password' });
    expect(hide.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(hide);
    expect(input.type).toBe('password');
  });

  it('renders the forgot link in its slot and ties an error to the input', () => {
    render(<PasswordField {...words} forgot={{ label: 'Forgot password?', href: '/forgot' }} error="Too short" />);
    expect(screen.getByRole('link', { name: 'Forgot password?' }).getAttribute('href')).toBe('/forgot');
    const input = screen.getByLabelText('Password');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Too short');
  });
});
