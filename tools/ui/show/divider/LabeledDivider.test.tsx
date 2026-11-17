// tools/ui/show/divider/LabeledDivider.test.tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LabeledDivider } from './LabeledDivider';

describe('LabeledDivider', () => {
  it('prerenders a separator with the centred text between two rules', () => {
    const html = renderToStaticMarkup(<LabeledDivider text="or" />);
    expect(html).toContain('role="separator"');
    expect(html).toContain('>or<');
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(2);
  });

  it('without text it is one plain rule', () => {
    const html = renderToStaticMarkup(<LabeledDivider />);
    expect(html).toContain('role="separator"');
    expect(html).not.toContain('<span');
  });
});
