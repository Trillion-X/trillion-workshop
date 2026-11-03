// tools/draw-a-change-as-a-diagram/do-work/sanitize-error-text.ts
//
// PURPOSE
//   The single gate between a raw failure message and anything a person reads. Words written for a person pass, with
//   internal detail (stack frames, paths, addresses, hashes, JSON dumps) stripped out; words written for a program or
//   an AI (an identifier first, snake_case or camelCase names, prefixed ids, web addresses, status codes, a browser's
//   own error, a paragraph) are never shown: the caller's plain fallback is shown instead. Every failure surface reads
//   through it: the shared failed state (src/workspace/failure.ts), the workspace's refusals (src/workspace/api.ts),
//   SafeErrorCard and the recording panels.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure and browser-safe: no React, no DOM.
//   2. A message that looks written for a program is replaced whole, never half-shown.
//   3. The gate never invents a reason: what it cannot pass becomes the caller's fallback.

/** Substring shapes that mean "internal detail": replaced, never shown. */
const INTERNAL_PATTERNS: RegExp[] = [
  /\bat\s+\S+\s+\(.*?\)/g,          // stack frames: at fn (file:line)
  /(?:\/[\w.@-]+){2,}/g,            // absolute/relative multi-segment paths
  /\b[a-z-]+::\S+/gi,               // internal addresses like name::scope::id
  /\b0x[0-9a-f]{2,}:[0-9a-f]{8,}\b/gi, // content hashes
  /\b[0-9a-f]{32,}\b/gi,            // long hex ids
  /\{[\s\S]{40,}\}/g,               // embedded JSON dumps
  /\bError:\s*/g,                   // raw error prefixes
];

/** Internal product vocabulary and identifier labels that never belong in copy. */
const INTERNAL_COPY_SIGNATURE =
  /\b(?:production|canonical)\s+artifact\b|\b(?:payload|receipt|projection|acceptance proof)\b|\b(?:request|provider|result|job|artifact|correlation|resource|remote[_ -]?object)[_ -]?(?:ref|id|token)\b/i;

/** Shapes that mean the message was written for a program or an AI, not a person: the whole message is replaced. */
const WRITTEN_FOR_A_PROGRAM: RegExp[] = [
  /^[a-z]/,                                     // starts with an identifier ("reply is not something ...")
  /\b[a-z0-9]+_[a-z0-9_]+\b/i,                  // snake_case names
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/,                // camelCase names
  /\b[a-z][a-z0-9-]*:[A-Za-z0-9_-]{3,}/,        // prefixed ids (tool:x, source:..., message:...)
  /\b[0-9a-f]{8,}\b/i,                          // hex ids and references
  /https?:\/\//i,                               // web addresses
  /\(\d{3}\)/,                                  // status codes
  /[{}<>[\]`]/,                                 // code and markup
  /\b(?:undefined|null|NaN|TypeError|SyntaxError|ReferenceError|Failed to fetch|Load failed|NetworkError|fetch failed|ECONN\w*|ETIMEDOUT)\b/,
  // Platform words never reach a person: the hosting platform's failure messages read as plain English but are about
  // its own machinery ("Durable Object is overloaded. Requests queued for too long.").
  /\b(?:Durable Object|Worker|isolate|overloaded|queued for too long|Network connection lost|reset because its code was updated|maximum database size|exceeded (?:its )?(?:CPU|memory|resource|time))\b/i,
];

/** The longest message shown as it is; anything longer was written to be read by an AI. */
const LONGEST = 240;

/**
 * The words a person may read for a raw failure message: the message with internal detail stripped when it was written
 * for a person, else `fallback`.
 */
export function sanitizeErrorText(raw: string | null | undefined, fallback = 'Something went wrong.'): string {
  const given = typeof raw === 'string' ? raw.trim() : '';
  if (!given || given.length > LONGEST) return fallback;
  if (INTERNAL_COPY_SIGNATURE.test(given) || WRITTEN_FOR_A_PROGRAM.some(pattern => pattern.test(given))) return fallback;
  let text = given;
  for (const pattern of INTERNAL_PATTERNS) text = text.replace(pattern, '');
  text = text.replace(/\s{2,}/g, ' ').replace(/\s+([.,])/g, '$1').trim();
  if (text.length < 8) return fallback;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The words a person may read for anything a failure threw: its message through the gate, else `fallback`. The one way
 * any screen turns a caught error into words (test/no-raw-error-text guards that no screen reads `.message` itself);
 * the raw message still goes to logs and to the person's AI, never to the screen.
 */
export function errorWords(error: unknown, fallback?: string): string {
  return sanitizeErrorText(error instanceof Error ? error.message : typeof error === 'string' ? error : null, fallback);
}
