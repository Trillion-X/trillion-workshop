/** The part of a media file an address asks for, read from the address itself: the W3C media fragment `#t=start,end`
 * (seconds, `npt:` allowed, `hh:mm:ss` or `mm:ss` allowed, either side may be left out), then YouTube's own `start`/`end`
 * or `t` query words. A browser video plays a fragment natively; players that do not (an embedded YouTube player) read it
 * here, so a lesson that is one stretch of a long video is just that video's address with its stretch on it.
 * Answers null when the address names no part or names one that cannot be (an end at or before its start).
 */
export type MediaSpan = { start: number; end?: number };

function secondsOf(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const text = value.trim().replace(/^npt:/, '').replace(/s$/, '');
  if (text === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(text);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const words = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+))?$/.exec(text);
  if (words && words.slice(1).some(Boolean)) return Number(words[1] ?? 0) * 3600 + Number(words[2] ?? 0) * 60 + Number(words[3] ?? 0);
  return undefined;
}

function spanOf(start: number | undefined, end: number | undefined): MediaSpan | null {
  if (start === undefined && end === undefined) return null;
  const from = start ?? 0;
  if (!Number.isFinite(from) || from < 0) return null;
  if (end === undefined) return from > 0 ? { start: from } : null;
  if (!Number.isFinite(end) || end <= from) return null;
  return { start: from, end };
}

export function mediaSpanOf(address: string | null | undefined): MediaSpan | null {
  if (!address) return null;
  let url: URL;
  try {
    url = new URL(address, 'http://localhost');
  } catch {
    return null;
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, '')).get('t');
  if (fragment !== null) {
    const [start, end] = fragment.split(',');
    return spanOf(secondsOf(start), secondsOf(end));
  }
  const start = secondsOf(url.searchParams.get('start') ?? url.searchParams.get('t'));
  return spanOf(start, secondsOf(url.searchParams.get('end')));
}
