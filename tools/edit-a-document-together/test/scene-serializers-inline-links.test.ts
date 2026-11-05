import { describe, expect, it } from './vitest-shim.mjs';
import { encodeInlineLinkOpen } from '../read-data/inline-tokens.ts';
import { serializeInlineTextToHtml, serializeInlineTextToJsx } from '../do-work/scene-serializers.ts';

describe('scene serializer inline links', () => {
  it('preserves DATA-authored marks and style spans inside semantic safe anchors', () => {
    const marks = [{ id: 'em', open_marker: '**', close_marker: '**', render_tag: 'strong' }];
    const href = encodeInlineLinkOpen('https://example.org/docs');
    const style = `⟦style:${encodeURIComponent(JSON.stringify({ color: 'red' }))}⟧word⟦/style⟧`;
    const source = `before **${href}${style}⟦/link⟧** after`;
    expect(serializeInlineTextToHtml(source, marks)).toBe(
      'before <strong><a href="https://example.org/docs" target="_blank" rel="noopener noreferrer"><span style="color:red">word</span></a></strong> after',
    );
  });

  it('does not make unsafe stored URLs clickable', () => {
    const token = `⟦link:${encodeURIComponent('javascript:alert(1)')}⟧label⟦/link⟧`;
    expect(serializeInlineTextToHtml(token)).toBe(token);
    expect(serializeInlineTextToHtml(token)).not.toContain('<a ');
  });

  it('uses scene style units and emits the same link meaning as JSX', () => {
    const marks = [{ id: 'bold', open_marker: '**', close_marker: '**', render_tag: 'strong' }];
    const style = `⟦style:${encodeURIComponent(JSON.stringify({ font_size: 18, font_weight: 700 }))}⟧word⟦/style⟧`;
    const source = `**${encodeInlineLinkOpen('https://example.org/docs')}${style}⟦/link⟧**`;
    expect(serializeInlineTextToHtml(source, marks)).toContain('style="font-size:18px;font-weight:700"');
    expect(serializeInlineTextToJsx(source, marks)).toBe('<strong><a href={"https://example.org/docs"} target="_blank" rel="noopener noreferrer"><span style={{"fontSize":18,"fontWeight":700}}>{"word"}</span></a></strong>');
  });
});
