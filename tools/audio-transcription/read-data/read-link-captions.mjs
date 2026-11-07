/** Whether a page refused the link reader itself (an old copy it no longer answers), which updating the reader fixes. */
export const refusedThisCopy = error => /\b(403|Forbidden|Sign in|confirm you|not a bot)\b/i.test(String(error?.message ?? error));

const seconds = stamp => {
  const parts = String(stamp).trim().replace(',', '.').split(':').map(Number);
  return parts.reduce((sum, part) => sum * 60 + part, 0);
};

/**
 * The words of a WebVTT captions file as { text, segments }: cue tags and timing are taken out, and a line a rolling
 * caption repeats in the next cue is kept once, so automatic captions read as the speech, not as each line three times.
 */
export function captionWords(vtt) {
  const segments = [];
  let last = '';
  for (const block of String(vtt).replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const at = lines.findIndex(line => line.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at].split('-->').map(side => side.trim().split(/\s+/)[0]);
    for (const raw of lines.slice(at + 1)) {
      const line = raw.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
      if (!line || line === last) continue;
      last = line;
      segments.push({ start: seconds(from), end: seconds(to), text: line });
    }
  }
  return { text: segments.map(segment => segment.text).join(' '), segments };
}
