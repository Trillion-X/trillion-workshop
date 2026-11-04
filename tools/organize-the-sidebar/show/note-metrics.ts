export interface TextMetrics {
  readonly chars: number;
  readonly words: number;
  readonly sentences: number;
  readonly avgWordsPerSentence: number;
  readonly readingSeconds: number;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function textMetrics(text: string, opts?: { readonly wpm?: number }): TextMetrics {
  const chars = text.length;
  const words = text.split(/\s+/).filter((token) => token.length > 0).length;
  const terminators = text.match(/[.!?]+/g);
  const sentences = words === 0 ? 0 : terminators ? terminators.length : 1;
  const avgWordsPerSentence = sentences > 0 ? words / sentences : 0;
  const wpm = opts?.wpm ?? 200;
  const readingSeconds = words === 0 ? 0 : Math.round(words / (wpm / 60));
  return { chars, words, sentences, avgWordsPerSentence, readingSeconds };
}
