// tools/ui/show/code-boxes/CodeBoxes.test.tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CodeBoxes } from './CodeBoxes';

afterEach(cleanup);

const digitLabel = (position: number, length: number) => `Digit ${position} of ${length}`;

describe('CodeBoxes', () => {
  it('prerenders six numeric boxes, each labelled, the first asking for a one-time code', () => {
    const html = renderToStaticMarkup(<CodeBoxes label="Code" digitLabel={digitLabel} />);
    expect(html.match(/<input/g)).toHaveLength(6);
    expect(html.match(/inputMode="numeric"|inputmode="numeric"/gi)).toHaveLength(6);
    expect(html.match(/autoComplete="one-time-code"|autocomplete="one-time-code"/gi)).toHaveLength(1);
    expect(html).toContain('aria-label="Digit 1 of 6"');
    expect(html).toContain('aria-label="Digit 6 of 6"');
  });

  it('a paste fills every box, reports the code and completes once', () => {
    const onChange = vi.fn();
    const onComplete = vi.fn();
    render(<CodeBoxes label="Code" digitLabel={digitLabel} name="code" onChange={onChange} onComplete={onComplete} />);
    fireEvent.paste(screen.getByLabelText('Digit 3 of 6'), { clipboardData: { getData: () => '12 34-56' } });
    for (let i = 1; i <= 6; i += 1) {
      expect((screen.getByLabelText(`Digit ${i} of 6`) as HTMLInputElement).value).toBe(String(i));
    }
    expect(onChange).toHaveBeenLastCalledWith('123456');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('123456');
    expect(document.querySelector<HTMLInputElement>('input[type="hidden"][name="code"]')?.value).toBe('123456');
  });

  it('typing moves on, letters are ignored, backspace on an empty box steps back', () => {
    render(<CodeBoxes label="Code" digitLabel={digitLabel} />);
    const first = screen.getByLabelText('Digit 1 of 6') as HTMLInputElement;
    fireEvent.change(first, { target: { value: 'a' } });
    expect(first.value).toBe('');
    fireEvent.change(first, { target: { value: '7' } });
    expect(first.value).toBe('7');
    const second = screen.getByLabelText('Digit 2 of 6') as HTMLInputElement;
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'Backspace' });
    expect(first.value).toBe('');
    expect(document.activeElement).toBe(first);
  });
});
