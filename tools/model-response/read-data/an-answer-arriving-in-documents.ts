// packages/model-response/read-data/an-answer-arriving-in-documents.ts
//
// PURPOSE
// Some answers are sent as they are written, which means they do not arrive as
// one document but as a run of them, each carrying the next few words. This
// reads that run.
//
// It lives here because this package is the one that knows what an answer looks
// like. Two callers need it and neither should own it: the owner that reads the
// finished answer, and the owner that puts the words on screen while they are
// still arriving. A second copy of this would be a second set of rules for
// reading the same bytes, one line apart.
//
// NON-NEGOTIABLE INVARIANTS
//   - No provider, vendor or model name. WHERE the words sit inside one of
//     these documents is DATA handed in as a path.
//   - A half-written document at the end is skipped, not an error. Deliveries
//     are spaced on a timer and an answer does not pause for them.

export type AnswerPath = readonly unknown[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Walk a path of keys and array positions into a decoded document. */
export function valueAtPath(value: unknown, path: AnswerPath): unknown {
  return path.reduce<unknown>((current, step) => {
    if (typeof step === 'number') return Array.isArray(current) ? current[step] : undefined;
    return isRecord(current) ? current[String(step)] : undefined;
  }, value);
}

/** Every document in the run that can be read, in the order they were written.
 *  The two shapes in the wild are a line beginning `data:` and a bare document
 *  per line; both are covered by trying each line and keeping what parses. */
export function documentsInTheRun(text: string): unknown[] {
  const documents: unknown[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const document = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (!document || document === '[DONE]') continue;
    try {
      documents.push(JSON.parse(document));
    } catch {
      // Half written. The delivery that completes it will carry it whole.
    }
  }
  return documents;
}

/** The words written so far, joined. Only words are taken: a path that lands
 *  on a number or an object contributes nothing, because the alternative is
 *  putting "[object Object]" in front of a reader. */
export function wordsInTheRun(text: string, textPath: AnswerPath): string {
  if (textPath.length === 0) return '';
  const found: string[] = [];
  for (const document of documentsInTheRun(text)) {
    const piece = valueAtPath(document, textPath);
    if (typeof piece === 'string') found.push(piece);
  }
  return found.join('');
}

/**
 * The run folded back into ONE document shaped exactly like a single answer.
 *
 * This is what lets everything downstream stay unchanged. An answer that was
 * streamed and an answer that was not are the same object by the time anyone
 * reads it, so response paths, structured-output validation and every other
 * rule keep working without learning that streaming exists.
 *
 * The last document is used as the frame because it carries the closing
 * details a provider only knows at the end, such as why it stopped.
 */
export function oneAnswerFromTheRun(text: string, textPath: AnswerPath): unknown {
  const documents = documentsInTheRun(text);
  if (documents.length === 0) return {};
  const frame = structuredClone(documents[documents.length - 1]);
  const words = wordsInTheRun(text, textPath);
  const containing = textPath.slice(0, -1);
  const last = textPath[textPath.length - 1];
  const parent = valueAtPath(frame, containing);
  if (isRecord(parent)) parent[String(last)] = words;
  else if (Array.isArray(parent) && typeof last === 'number') parent[last] = words;
  return frame;
}

/**
 * Read as much of a JSON document as has been written so far.
 *
 * An answer asked for as structured JSON streams as JSON text, so the words a
 * person should see are the VALUE of one field inside a document whose closing
 * brace has not arrived yet. `JSON.parse` refuses that until the very end,
 * which puts either nothing or raw braces on screen. This reads every value that
 * is complete, keeps a string that is still being written, and stops at the
 * first thing it cannot read yet. A number or word cut off at the end is left
 * out rather than guessed, because `12` may still become `123`.
 */
export function readUnfinishedJson(text: string): unknown {
  let at = 0;
  let stopped = false;
  const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

  const skipSpace = () => {
    while (at < text.length && ' \t\n\r'.includes(text[at])) at += 1;
    if (at >= text.length) stopped = true;
  };

  const readString = (): string => {
    at += 1;
    let out = '';
    while (at < text.length) {
      const character = text[at];
      if (character === '"') {
        at += 1;
        return out;
      }
      if (character !== '\\') {
        out += character;
        at += 1;
        continue;
      }
      const next = text[at + 1];
      if (next === undefined) break;
      if (next === 'u') {
        const hex = text.slice(at + 2, at + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        at += 6;
        continue;
      }
      out += escapes[next] ?? next;
      at += 2;
    }
    stopped = true;
    return out;
  };

  const readWord = (): unknown => {
    const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(at));
    // Touching the end means it may not be finished.
    if (!match || at + match[0].length >= text.length) {
      stopped = true;
      return undefined;
    }
    at += match[0].length;
    return JSON.parse(match[0]);
  };

  const readObject = (): Record<string, unknown> => {
    at += 1;
    const out: Record<string, unknown> = {};
    for (;;) {
      skipSpace();
      if (stopped) return out;
      if (text[at] === '}') { at += 1; return out; }
      if (text[at] === ',') { at += 1; continue; }
      if (text[at] !== '"') { stopped = true; return out; }
      const key = readString();
      if (stopped) return out;
      skipSpace();
      if (stopped || text[at] !== ':') { stopped = true; return out; }
      at += 1;
      const value = readValue();
      if (value !== undefined) out[key] = value;
      if (stopped) return out;
    }
  };

  const readArray = (): unknown[] => {
    at += 1;
    const out: unknown[] = [];
    for (;;) {
      skipSpace();
      if (stopped) return out;
      if (text[at] === ']') { at += 1; return out; }
      if (text[at] === ',') { at += 1; continue; }
      const value = readValue();
      if (value !== undefined) out.push(value);
      if (stopped) return out;
    }
  };

  function readValue(): unknown {
    skipSpace();
    if (stopped) return undefined;
    const character = text[at];
    if (character === '{') return readObject();
    if (character === '[') return readArray();
    if (character === '"') return readString();
    return readWord();
  }

  return readValue();
}

/** The text at `path` inside a JSON answer that may still be arriving, or ''. */
export function textSoFarAt(text: string, path: AnswerPath): string {
  const found = valueAtPath(readUnfinishedJson(text), path);
  return typeof found === 'string' ? found : '';
}
