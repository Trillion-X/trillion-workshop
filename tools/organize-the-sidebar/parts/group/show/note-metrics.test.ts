import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { stripHtml, textMetrics } from '../../../show/note-metrics.ts';

describe('note-metrics', () => {
  it('counts words, sentences, and average words per sentence', () => {
    const m = textMetrics('Hello world. How are you?');
    expect(m.words).toBe(5);
    expect(m.sentences).toBe(2);
    expect(m.avgWordsPerSentence).toBe(2.5);
  });

  it('collapses runs of terminators into one sentence each', () => {
    const m = textMetrics('Wait!!! Really??');
    expect(m.words).toBe(2);
    expect(m.sentences).toBe(2);
  });

  it('words present but no terminator counts as one sentence', () => {
    const m = textMetrics('just a fragment with no ending');
    expect(m.words).toBe(6);
    expect(m.sentences).toBe(1);
    expect(m.avgWordsPerSentence).toBe(6);
  });

  it('empty / whitespace text is all zeros', () => {
    for (const text of ['', '   ', '\n\t  ']) {
      const m = textMetrics(text);
      expect(m).toEqual({
        chars: text.length,
        words: 0,
        sentences: 0,
        avgWordsPerSentence: 0,
        readingSeconds: 0,
      });
    }
  });

  it('reading seconds derive from a custom wpm', () => {
    // 6 words at 60 wpm = 1 word/sec = 6 seconds
    expect(textMetrics('one two three four five six', { wpm: 60 }).readingSeconds).toBe(6);
    // default 200 wpm: 200 words => 60s; 6 words => round(1.8) = 2s
    expect(textMetrics('one two three four five six').readingSeconds).toBe(2);
    // zero words => zero regardless of wpm
    expect(textMetrics('   ', { wpm: 60 }).readingSeconds).toBe(0);
  });

  it('stripHtml removes tags, decodes entities, and collapses whitespace', () => {
    expect(stripHtml('<p>Hello&nbsp;&amp; welcome</p>')).toBe('Hello & welcome');
    expect(stripHtml('a &lt;b&gt; c')).toBe('a <b> c');
    expect(stripHtml('  <div>\n  spaced   out\t</div>  ')).toBe('spaced out');
    expect(stripHtml('<span class="x" data-y="z">tagged</span>')).toBe('tagged');
  });

  it('chars is the raw input length, not the stripped length', () => {
    const raw = '<b>Hi</b>';
    expect(textMetrics(raw).chars).toBe(raw.length);
    expect(textMetrics(raw).chars).toBe(9);
    expect(textMetrics(stripHtml(raw)).chars).toBe(2);
  });
});
