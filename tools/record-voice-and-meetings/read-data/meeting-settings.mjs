// parts/record-audio/read-data/meeting-settings.mjs
//
// PURPOSE
//   The one reader and writer of the meeting settings beyond when to start recording: who the notes go to, smart pages,
//   a calendar event for a recording made outside any event, the languages spoken, standing instructions for the
//   person's AIs, and words the speech model should spell right. They live in the same saved preference as the start
//   mode (meeting-start-settings.json preference_key), under meeting_notes, transcription and ai_instructions, so one
//   record carries every meeting setting and the start-mode writer (src/workspace/record-audio-screen.tsx) keeps them.
//   The Meeting recording screen draws them, src/account-transcription.mjs hears with them, and
//   src/share-destinations.mjs hands the chat instructions to the AI a share goes to.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every option, limit and word is DATA (meeting-settings.json); nothing here names a language, a scope or a
//      recipient.
//   2. Reading never throws: a missing or malformed saved value is the DATA default, and anything outside the DATA
//      options or limits is dropped, never guessed.
//   3. Writing changes only what the patch names; every other key of the saved preference (the start mode, its app
//      lists, anything a later version adds) is kept exactly.

import data from './meeting-settings.json' with { type: 'json' };
import start from './meeting-start-settings.json' with { type: 'json' };

export const MEETING_SETTINGS = data;
export const MEETING_SETTINGS_PREFERENCE = start.preference_key;

const record = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const optionIds = options => new Set(options.map(option => option.id));
const NOTE_RECIPIENTS = optionIds(data.notes.options);
const LANGUAGES = optionIds(data.languages.options);
const SCOPES = data.instructions.scopes.map(scope => scope.id);

/** A word as kept: trimmed, one line, within the DATA length; null when nothing is left. */
export function cleanWord(raw) {
  if (typeof raw !== 'string') return null;
  const word = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, data.limits.word_chars);
  return word || null;
}

function wordsOf(value) {
  const seen = new Set();
  const kept = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const word = cleanWord(raw);
    if (!word || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    kept.push(word);
    if (kept.length >= data.limits.words_count) break;
  }
  return kept;
}

function languagesOf(value) {
  return [...new Set(Array.isArray(value) ? value.filter(id => LANGUAGES.has(id)) : [])].slice(0, data.limits.languages_count);
}

/** The text as kept: at most the DATA length; never trimmed in the middle, so the person's own spacing stays. */
export const instructionText = value => (typeof value === 'string' ? value.slice(0, data.limits.instructions_chars) : '');

/** Every meeting setting beyond the start mode, from the saved preference value (any shape). */
export function decodeMeetingSettings(saved) {
  const root = record(saved);
  const notes = record(root.meeting_notes);
  const transcription = record(root.transcription);
  const instructions = record(root.ai_instructions);
  const toggle = id => (typeof notes[id] === 'boolean' ? notes[id] : data.toggles.find(row => row.id === id).default === true);
  const defaultScopes = data.instructions.scopes.filter(scope => scope.default).map(scope => scope.id);
  return {
    sendNotesTo: NOTE_RECIPIENTS.has(notes.send_to) ? notes.send_to : data.notes.default,
    smartPages: toggle('smart_pages'),
    adhocEvents: toggle('adhoc_events'),
    languages: languagesOf(transcription.languages),
    words: wordsOf(transcription.words),
    instructions: {
      text: instructionText(instructions.text),
      scopes: Array.isArray(instructions.scopes) ? SCOPES.filter(id => instructions.scopes.includes(id)) : defaultScopes,
    },
  };
}

/**
 * The saved preference with `patch` applied ({ sendNotesTo, smartPages, adhocEvents, languages, words, instructionText,
 * instructionScopes }, each optional). Every other key of `saved` is kept (invariant 3).
 */
export function withMeetingSettings(saved, patch) {
  const root = record(saved);
  const now = decodeMeetingSettings(saved);
  const next = {
    sendNotesTo: patch.sendNotesTo ?? now.sendNotesTo,
    smartPages: patch.smartPages ?? now.smartPages,
    adhocEvents: patch.adhocEvents ?? now.adhocEvents,
    languages: languagesOf(patch.languages ?? now.languages),
    words: wordsOf(patch.words ?? now.words),
    text: instructionText(patch.instructionText ?? now.instructions.text),
    scopes: SCOPES.filter(id => (patch.instructionScopes ?? now.instructions.scopes).includes(id)),
  };
  return {
    ...root,
    meeting_notes: { ...record(root.meeting_notes), send_to: NOTE_RECIPIENTS.has(next.sendNotesTo) ? next.sendNotesTo : data.notes.default,
      smart_pages: next.smartPages === true, adhoc_events: next.adhocEvents === true },
    transcription: { ...record(root.transcription), languages: next.languages, words: next.words },
    ai_instructions: { ...record(root.ai_instructions), text: next.text, scopes: next.scopes },
  };
}

/** The instruction words for one scope (data.instructions.scopes id), or '' when none are written or the scope is off. */
export function instructionsFor(saved, scope) {
  const { text, scopes } = decodeMeetingSettings(saved).instructions;
  return scopes.includes(scope) ? text.trim() : '';
}

/**
 * What the speech model is told before it hears a recording: the one chosen language (several means each recording's
 * language is detected) and the custom words as a short vocabulary line. Empty when the person set neither.
 */
export function hearingOptions(saved) {
  const { languages, words } = decodeMeetingSettings(saved);
  const vocabulary = [];
  let length = data.words.vocabulary_prefix.length;
  for (const word of words) {
    length += word.length + 2;
    if (length > data.limits.vocabulary_chars) break;
    vocabulary.push(word);
  }
  return {
    ...(languages.length === 1 ? { language: languages[0] } : {}),
    ...(vocabulary.length ? { initial_prompt: `${data.words.vocabulary_prefix}${vocabulary.join(', ')}.` } : {}),
  };
}

/** The calendar event for a recording made outside any event: its title and span, or null when the setting is off. */
export function adhocEventInput(saved, { startedAt, endedAt }) {
  if (!decodeMeetingSettings(saved).adhocEvents) return null;
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
  const time = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return { title: data.adhoc_event.title.replace('{time}', time), start: start.toISOString(), end: end.toISOString() };
}
