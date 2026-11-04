// tools/listen-for-a-while/read-data/voice-session.mjs
//
// PURPOSE
//   Bounds an always-listening voice session so listening never runs on unnoticed: it starts when asked (a wake phrase in
//   the transcript, or start()), refreshes on each utterance, and ends on silence, on its longest length, or on a
//   spoken dismissal. Capture and recognition stay with their own owners (listen-for-a-while.mjs, a wake-word or voice-activity
//   program); this decides only whether the words heard belong to a session and when the session is over.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: no phrase, number or sentence is in this file; all are read-data/voice-session.json.
//   2. A session that is not active hears nothing: heard() returns the words unhandled (`handle: false`) and keeps no text.
//   3. Time comes from the caller's clock, and every call re-checks the limits first, so a late call cannot be handled by a
//      session whose time has already run out.
//
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const voiceSettings = () => JSON.parse(readFileSync(join(HERE, 'voice-session.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const wordsOf = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean);
const startsWith = (words, phrase) => phrase.length > 0 && phrase.every((word, at) => words[at] === word);
const endsWith = (words, phrase) => phrase.length > 0 && words.length >= phrase.length && phrase.every((word, at) => words[words.length - phrase.length + at] === word);

/** One session over the settings and a clock. Returns { start, heard, tick, state }. */
export function makeVoiceSession({ settings = voiceSettings(), now = () => Date.now() } = {}) {
  const wake = settings.wake_phrases.map(wordsOf);
  const dismissals = settings.dismissal.phrases.map(wordsOf);
  const leadIn = new Set(settings.dismissal.lead_in.flatMap(wordsOf));
  let began = null, last = null, ended = null;

  const finish = (reason, said) => { began = null; last = null; ended = reason; return { active: false, ended: reason, said }; };
  /** Ends the session if its time is over; returns the ending or null. */
  const tick = () => {
    if (began === null) return null;
    const at = now();
    if (at - began >= settings.max_seconds * 1000) return finish('long', fill(settings.words.stopped_long, { seconds: settings.max_seconds }));
    if (at - last >= settings.idle_seconds * 1000) return finish('idle', fill(settings.words.stopped_idle, { seconds: settings.idle_seconds }));
    return null;
  };
  const begin = () => { began = now(); last = began; ended = null; return { active: true, said: settings.words.started }; };

  return {
    start() { tick(); return began === null ? begin() : { active: true, said: settings.words.started }; },
    /** The words just heard: { active, handle, text?, ended?, said }. A dismissal ends the session and is not handled. */
    heard(text) {
      const over = tick();
      const words = wordsOf(text);
      if (!words.length) return { active: began !== null, handle: false, ...(over ?? {}), said: over?.said ?? settings.words.empty };
      if (began === null) {
        const at = wake.findIndex(phrase => phrase.length && words.some((_, from) => startsWith(words.slice(from), phrase)));
        if (at < 0) return { active: false, handle: false, ...(over ?? {}), said: over?.said ?? settings.words.not_listening };
        // The words after the wake phrase belong to the session already.
        const from = words.findIndex((_, i) => startsWith(words.slice(i), wake[at]));
        const rest = words.slice(from + wake[at].length).join(' ');
        const opened = begin();
        return rest ? { ...opened, handle: true, text: rest } : { ...opened, handle: false };
      }
      const dismissed = dismissals.some(phrase => {
        if (words.length === phrase.length) return startsWith(words, phrase);
        const lead = words.slice(0, words.length - phrase.length);
        return endsWith(words, phrase) && lead.every(word => leadIn.has(word));
      });
      if (dismissed) return { ...finish('dismissed', settings.words.stopped_dismissed), handle: false };
      last = now();
      return { active: true, handle: true, text: words.join(' ') };
    },
    tick,
    state() { tick(); return { active: began !== null, ended, began, last }; },
  };
}
