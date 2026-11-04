// src/workspace/recording.mjs
//
// PURPOSE
//   What the web app's Record and Formats screens decide without a browser, the same way the iPhone decides it
//   (ios/Shared/TrillionRecordingData.swift): a content format with the person's thought dropped in becomes a script
//   (its first part carries the thought, every later part is what to say next in the format's own words); spoken words
//   are followed through that script like a teleprompter; and a finished recording is named in the person's Files
//   (one folder per day under recording.json's folder) with its transcript, then handed to their AIs as one job row of
//   src/queued-work.json. Which recording kind the browser makes, and its file ending, is the one recorder's
//   (parts/record-audio/show/record-in-the-browser.ts).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A format's parts come from the account (GET /work/api/content-formats); nothing here names a format or a part.
//   2. Following is incremental: `follow` takes the place reached so far and only the words heard since, so the final
//      words are read once and the words still being heard are laid on top without moving the kept place.
//   3. The place in a script never moves backwards and never passes its last word.
//   4. A kept name never holds a folder separator from a format's label, so a label cannot move the file elsewhere.
//   5. The script handed off and the script shown are one value: `scriptFor` builds both.
//   6. A way of reading a script (recording.json script_views) is DATA: which of a part's fields show, joined how and
//      cut to how many words. The place is always followed through the full script's words, so changing the view never
//      moves the reader's place; the view only decides what is drawn for it.
//   7. A recording that was cut or added to is a list of spans of the one recording made (`edit`, seconds), in the order
//      they play. Every edit returns a new list; spans never overlap their own recording time and never run past it.
//   8. A take (`takeScript`) is a script like any other, read from a list row: the teleprompter, the kept name and the
//      job handed on read it the same way, and only `take` tells the job which row it came from.

import settings from './recording.json' with { type: 'json' };
import { isMostlyRepeated } from '../../../record-voice-and-meetings/read-data/heard-words.mjs';

const clean = value => (typeof value === 'string' ? value.trim() : '');

// How many of the person's own sentences one part of a format carries at most, so a long recording reads as a script.
const SENTENCES_PER_PART = 2;

/** Words split into sentences: each ends at . ! ? or a line break, and keeps its own punctuation. */
export const sentencesOf = words => (clean(words).match(/[^.!?\n]+(?:[.!?]+|$)/g) ?? []).map(clean).filter(Boolean);

/**
 * A content format filled with the person's own words: what they read while they record, and what their AI writes.
 * `thought` (what they typed) and `material` (the words of their own recording, note or pursuit) are split into
 * sentences and spread across the format's parts in order, at most SENTENCES_PER_PART each. With only a thought, its
 * whole text fills the first part. A part nothing of theirs fills keeps no words: its `hint` (the format's own
 * instruction for it) says what to write there, and is never read aloud as if it were the script. `ready` is true only
 * when every part has words to read; `missing` names the parts still to write.
 */
export function scriptFor(format, thought, material = '') {
  const about = clean(thought);
  const slots = format.slots ?? [];
  const sentences = [...(about && clean(material) ? [about] : []), ...sentencesOf(material)].slice(0, slots.length * SENTENCES_PER_PART);
  // Spread evenly, so enough sentences fill every part (a part is left without words only when sentences run out).
  const count = sentences.length, parts = Math.max(1, slots.length);
  const from = index => (count >= parts ? Math.floor(index * count / parts) : Math.min(index, count));
  const lines = slots.map((part, index) => {
    const own = count ? sentences.slice(from(index), from(index + 1)).join(' ') : index === 0 ? about : '';
    return { id: part.id, label: part.label, words: own, hint: clean(part.hint) || part.label, theirs: Boolean(own) };
  });
  return {
    ...readiness(lines),
    format_id: format.id,
    format_label: format.label,
    // What it is about: the thought, or the first of their own sentences when it was filled from their material.
    about: about || sentences[0] || '',
    lines,
    input: format.input ?? null,
    process: format.process ?? [],
    output: format.output ?? null,
  };
}

/** Whether a script can be read aloud: every line has words. Missing lines are named by their labels. */
function readiness(lines) {
  const missing = lines.filter(line => !clean(line.words)).map(line => line.label);
  return { ready: lines.length > 0 && missing.length === 0, missing };
}

/** The script as plain text, kept beside a recording made with it. A part still to write shows what to write there. */
export function scriptText(script) {
  return [script.format_label + (script.about ? `: ${script.about}` : ''), ...script.lines.map(line => `${line.label}: ${line.words || `(still to write: ${line.hint ?? line.label})`}`)].join('\n');
}

/**
 * Finished words, typed or written by an AI, as a script to read: one line per sentence, named `label`. Empty words are
 * a script that is not ready (ready false), never an empty script that is already read.
 */
export function scriptFromWords(words, { id = 'words', label = 'Your script' } = {}) {
  const sentences = sentencesOf(words);
  const lines = sentences.map((sentence, index) => ({ id: `line-${index + 1}`, label: String(index + 1), words: sentence, theirs: true }));
  return {
    format_id: `words:${id}`,
    format_label: clean(label) || 'Your script',
    about: sentences[0] ?? '',
    lines,
    ...readiness(lines),
    ...(lines.length ? {} : { missing: [clean(label) || 'Your script'] }),
    input: null,
    process: [],
    output: null,
  };
}

/**
 * One take of a run (recording.json takes): a row of a list's saved view whose words in one of `script_fields` are the
 * script, split into sentences, one line each. It is named after the row's title and remembers its list and row, so
 * the kept take is handed on as that row's take. A row with no words in those fields is no take (null).
 */
export function takeScript(row, { list_id, script_fields = settings.takes.script_fields } = {}) {
  const words = script_fields.map(field => clean(row?.values?.[field])).find(Boolean) ?? '';
  const sentences = sentencesOf(words);
  if (!sentences.length) return null;
  const title = clean(row.title) || sentences[0];
  return {
    format_id: `take:${list_id}:${row.id}`,
    format_label: title,
    about: title,
    lines: sentences.map((sentence, index) => ({ id: `line-${index + 1}`, label: String(index + 1), words: sentence, theirs: true })),
    ready: true,
    missing: [],
    input: null,
    process: [],
    output: null,
    take: { list_id, row_id: row.id },
  };
}

/** The script's parts in order, each the words to say, as the teleprompter's segments. */
export const scriptSegments = script => script.lines.filter(line => clean(line.words)).map(line => line.words);

/** A word as it is compared: lower case letters and digits only, so punctuation and case never break a match. */
export const comparable = word => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The script's words, ready to follow, in the order the teleprompter counts them. */
export const scriptWords = segments => segments.flatMap(segment => segment.split(/\s+/)).filter(Boolean).map(comparable);

/** Words heard, split and made comparable. */
export const heardWords = text => clean(text).split(/\s+/).map(comparable).filter(Boolean);

/**
 * The next stretch of words heard while recording to hand to the person's AIs, or null while none is ready
 * (recording.json live_work). A finished turn (the words become final) is handed once it holds turn_min_words new
 * words; shorter turns wait and join the next one. A turn still being said is handed once long_turn_words have
 * gathered, so a long monologue is acted on before it ends. `handed` is how many words were already handed, so a
 * stretch is never handed twice. Returns { start, end, words, repeated } with words as said; `repeated` says the stretch
 * is mostly one line on repeat (parts/record-audio/read-data/heard-words.json), which is passed over, never handed.
 */
export function liveStretch({ final, hearing = '', handed = 0, quiet = 0 }, rules = settings.live_work) {
  const said = text => String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const finished = said(final);
  const all = [...finished, ...said(hearing)];
  const end = finished.length - handed >= rules.turn_min_words ? finished.length
    : all.length - handed >= rules.long_turn_words ? all.length
    : quiet >= rules.quiet_seconds && all.length - handed >= rules.quiet_min_words ? all.length : null;
  if (end === null) return null;
  const words = all.slice(handed, end).join(' ');
  return { start: handed, end, words, earlier: all.slice(Math.max(0, handed - rules.earlier_words), handed).join(' '), repeated: isMostlyRepeated(words) };
}

/** The job that hands one stretch of words heard while recording (liveStretch) to the person's AIs, with what the AIs
 *  already did earlier in the same recording (the newest already_kept lines), so the same work is never started twice. */
export function liveWorkJob(stretch, started, already = [], rules = settings.live_work) {
  const heading = stretch.words.length > rules.heading_chars ? `${stretch.words.slice(0, rules.heading_chars - 1).trimEnd()}…` : stretch.words;
  return { job_id: settings.jobs.live_words, context: { heading, words: stretch.words, earlier: stretch.earlier || 'Nothing yet: this is the start.', already: already.slice(-rules.already_kept).join('\n') || 'nothing yet', started } };
}

/**
 * One meeting's turns from every device recording it (space items of kind meeting.item_kind, each { text, device, at }),
 * in the order they reached the space, with the same words heard by two devices within same_words_within_seconds kept
 * once: the longer wording wins and both devices and names stay on the turn. Returns [{ at, text, devices, who }].
 */
export function meetingTurns(items, rules = settings.meeting) {
  const overlap = (a, b) => {
    const left = new Set(heardWords(a));
    const right = heardWords(b);
    const shared = right.filter(word => left.has(word)).length;
    return shared / Math.max(1, Math.min(left.size, right.length));
  };
  const said = items
    .filter(item => item?.kind === rules.item_kind && typeof item.body?.text === 'string' && item.body.text.trim())
    .map(item => ({ order: Date.parse(item.provenance?.added_at ?? item.body.at), at: Date.parse(item.body.at ?? item.provenance?.added_at), text: item.body.text.trim(), device: String(item.body.device ?? ''), who: item.provenance?.by ?? '' }))
    .sort((a, b) => a.order - b.order);
  const turns = [];
  for (const one of said) {
    const same = turns.find(turn => !turn.devices.includes(one.device) && Math.abs(turn.at - one.at) <= rules.same_words_within_seconds * 1000 && overlap(turn.text, one.text) >= rules.same_words_share);
    if (!same) { turns.push({ at: one.at, text: one.text, devices: [one.device], who: [one.who].filter(Boolean) }); continue; }
    same.devices.push(one.device);
    if (one.who && !same.who.includes(one.who)) same.who.push(one.who);
    if (one.text.length > same.text.length) same.text = one.text;
  }
  return turns;
}

/** The start of following a script: nothing said yet. */
export const START = Object.freeze({ said: 0 });

/**
 * Follows `heard` (words heard since `from`) through `script` (scriptWords): each heard word is looked for in the next
 * `lookahead` words of the script from the current place, and a match moves the place just past it. A word the script
 * does not hold nearby (an aside, a misheard word) leaves the place where it was.
 */
export function follow(script, heard, from = START, lookahead = settings.follow_lookahead_words) {
  let said = from.said;
  for (const word of heard) {
    const end = Math.min(script.length, said + lookahead);
    for (let at = said; at < end; at += 1) {
      if (script[at] && script[at] === word) { said = at + 1; break; }
    }
  }
  return { said };
}

/** What the teleprompter draws for a place in a script of `total` words. */
export function teleprompterAt(place, total) {
  if (total === 0) return { activeWordIndex: 0, spokenWordCount: 0, progress: 0 };
  return { activeWordIndex: Math.min(place.said, total - 1), spokenWordCount: place.said, progress: place.said / total };
}

/** The ways a script can be read (recording.json script_views), the first being the one that opens. */
export const scriptViews = () => settings.script_views;

/** Whether a way of reading draws the script mirrored, for a teleprompter's glass (its row's `mirror`). */
export const mirroredView = view => view?.mirror === true;

// A part's words cut to `count` words, marked as cut when anything was left out.
const firstWords = (words, count) => {
  const all = clean(words).split(/\s+/).filter(Boolean);
  return all.length > count ? `${all.slice(0, count).join(' ')}…` : all.join(' ');
};

/** What a view shows of each part of the script, in order (one teleprompter segment per part). */
export const viewSegments = (script, view) => script.lines.filter(line => clean(line.words)).map(line => view.show
  .map(field => (field === 'words' && view.words_up_to ? firstWords(line[field], view.words_up_to) : clean(line[field])))
  .filter(Boolean)
  .join(view.between ?? ' '));

// Words as the teleprompter counts them on screen: every run of characters between spaces.
const drawnWords = segment => segment.split(/\s+/).filter(Boolean).length;

/**
 * What the teleprompter draws for `place` (followed through the full script's words) in `view`: the view's segments,
 * the word to light up and how many words are behind it. The part being read is found from the place, and the light
 * moves through that part's drawn words in step with how far through the part the reader is.
 */
export function teleprompterInView(script, view, place) {
  const segments = viewSegments(script, view);
  const followed = scriptSegments(script).map(segment => scriptWords([segment]).length);
  const drawn = segments.map(drawnWords);
  const totalFollowed = followed.reduce((sum, count) => sum + count, 0);
  const totalDrawn = drawn.reduce((sum, count) => sum + count, 0);
  if (!totalFollowed || !totalDrawn) return { segments, activeWordIndex: 0, spokenWordCount: 0, progress: 0 };
  if (place.said >= totalFollowed) return { segments, activeWordIndex: totalDrawn - 1, spokenWordCount: totalDrawn, progress: 1 };
  let part = 0;
  let followedBefore = 0;
  let drawnBefore = 0;
  while (part < followed.length - 1 && place.said >= followedBefore + followed[part]) {
    followedBefore += followed[part];
    drawnBefore += drawn[part];
    part += 1;
  }
  const through = followed[part] ? (place.said - followedBefore) / followed[part] : 0;
  const within = Math.min(Math.max(0, drawn[part] - 1), Math.floor(through * drawn[part]));
  const active = Math.min(totalDrawn - 1, drawnBefore + within);
  return { segments, activeWordIndex: active, spokenWordCount: active, progress: place.said / totalFollowed };
}

// ---------------------------------------------------------------------------------------------------------------------
// A recording cut and added to: a list of spans of the one recording made, in the order they play.

const EDGE = 0.05;

/** The whole recording made so far, as one span. */
export const wholeRecording = seconds => (seconds > 0 ? [{ from: 0, to: seconds }] : []);

/** How long the edited recording plays, in seconds. */
export const editLength = edit => edit.reduce((sum, span) => sum + (span.to - span.from), 0);

/** The edit with each span that goes on exactly where the one before it ended joined to it, so a recording paused
 *  and resumed without an edit is still one span: the recording as it was made. */
const joined = edit => edit.reduce((spans, span) => {
  const last = spans[spans.length - 1];
  if (last && Math.abs(last.to - span.from) <= 1e-6) return [...spans.slice(0, -1), { from: last.from, to: span.to }];
  return [...spans, span];
}, []);

/** Whether the edit plays the recording made exactly as it was made (nothing cut, nothing moved). */
export const isWholeRecording = (edit, seconds) => edit.length === 1 && edit[0].from <= EDGE && Math.abs(edit[0].to - seconds) <= EDGE;

/** The edit with `start`..`end` (seconds of the edited recording) taken out. */
export function cutFrom(edit, start, end) {
  const [low, high] = [Math.max(0, Math.min(start, end)), Math.max(start, end)];
  const kept = [];
  let at = 0;
  for (const span of edit) {
    const length = span.to - span.from;
    const spanStart = at;
    const spanEnd = at + length;
    at = spanEnd;
    if (spanEnd <= low || spanStart >= high) { kept.push(span); continue; }
    if (low > spanStart) kept.push({ from: span.from, to: span.from + (low - spanStart) });
    if (high < spanEnd) kept.push({ from: span.from + (high - spanStart), to: span.to });
  }
  return joined(kept.filter(span => span.to - span.from > 1e-6));
}

/** The edit with `added` (a span of the recording made) played from `at` (seconds of the edited recording). */
export function insertInto(edit, at, added) {
  if (added.to - added.from <= 1e-6) return edit;
  const place = Math.max(0, Math.min(at, editLength(edit)));
  const result = [];
  let walked = 0;
  let placed = false;
  for (const span of edit) {
    const length = span.to - span.from;
    if (!placed && place <= walked + length) {
      const into = place - walked;
      if (into > 1e-6) result.push({ from: span.from, to: span.from + into });
      result.push(added);
      if (length - into > 1e-6) result.push({ from: span.from + into, to: span.to });
      placed = true;
    } else result.push(span);
    walked += length;
  }
  if (!placed) result.push(added);
  return joined(result);
}

/** The words of an edited recording: the words heard (each with the second it was heard at in the recording made),
 *  kept when their second is inside a span, in the order the spans play. */
export const wordsOfEdit = (edit, timedWords) => edit
  .flatMap(span => timedWords.filter(word => word.at > span.from - EDGE && word.at <= span.to + EDGE).map(word => word.word))
  .join(' ');

/** The words that were added to `final` since `known` words were timed, each timed at `at` seconds. */
export function timeNewWords(timed, final, at) {
  const words = clean(final).split(/\s+/).filter(Boolean);
  if (words.length <= timed.length) return timed;
  return [...timed, ...words.slice(timed.length).map(word => ({ word, at }))];
}

/** The name an edited recording is kept under, beside the recording it was made from (`audioName`). */
export const editedName = audioName => `${audioName.replace(/\.[^./]*$/, '')}${settings.edited.suffix}.wav`;

/** The video script is useful only while its camera capture is actively recording. */
export const teleprompterIsLive = ({ mode, recording, paused, captureActive }) => mode === 'video' && recording && !paused && captureActive;

const two = value => String(value).padStart(2, '0');
// A label as part of a file name: never a folder separator, never a control character.
const nameSafe = value => clean(value).replace(/[/\\\u0000-\u001f\u007f]+/g, '-');

/**
 * Where a recording started at `startedAt` is kept (local time, like the iPhone): the day's folder, and the audio and
 * transcript names inside it. A recording read from a script carries the format's label in its names.
 */
export function keptNames(startedAt, { formatLabel = null, extension, folder = settings.folder }) {
  const day = `${startedAt.getFullYear()}-${two(startedAt.getMonth() + 1)}-${two(startedAt.getDate())}`;
  const moment = `${two(startedAt.getHours())}.${two(startedAt.getMinutes())}.${two(startedAt.getSeconds())}`;
  const title = formatLabel ? ` ${nameSafe(formatLabel)}` : '';
  const audio = `${moment}${title}.${extension}`;
  return { folder: `${folder}/${day}`, audio, transcript: transcriptNameBeside(audio) };
}

/** The transcript kept beside an audio file (a name or a whole path): its ending swapped for " transcript.txt". */
export const transcriptNameBeside = audioName => `${audioName.replace(/\.[^./]*$/, '')} transcript.txt`;

/** The transcript file's words: the script first when there was one, then what was said. */
export function transcriptFileText(transcript, script = null, calendarEvent = null, source = null) {
  const said = clean(transcript) || '(Nothing was heard in this recording.)';
  const body = script ? `Script\n${scriptText(script)}\n\nWhat I said\n${said}` : said;
  const event = calendarRecordingContext(calendarEvent);
  const safeSourcePart = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 250) : '';
  const kind = safeSourcePart(source?.kind), id = safeSourcePart(source?.id);
  const sourceLine = source && typeof source === 'object' && kind && id
    ? `Source: ${safeSourcePart(source.label) || kind} · ${safeSourcePart(source.title) || id} (${kind}:${id})\n\n` : '';
  return `${sourceLine}${event ? `Calendar item: ${event.title}\nCalendar entry: ${event.id}\nStarts: ${event.starts_at}\n${event.space_id ? `Pursuit: ${event.space_id}\n` : ''}\n` : ''}${body}`;
}

/** Keep only the bounded calendar identity supplied by the event opener, including in device recovery. */
export function calendarRecordingContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const line = (text, max) => typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
  const id = line(value.id, 250), title = line(value.title, 200), starts = Date.parse(value.starts_at);
  if (!id || !title || !Number.isFinite(starts)) return null;
  return { id, title, starts_at: new Date(starts).toISOString(), source: line(value.source, 80), space_id: line(value.space_id, 200) || null };
}

/** Whole minutes, at least one, the way the handoff says how long a recording is. */
export const minutesOf = seconds => String(Math.max(1, Math.round(seconds / 60)));

/** The job a kept recording hands the person's AIs (a row of src/queued-work.json), with the values its row names. */
export function recordingJob({ audioFile, transcriptFile, seconds, script = null, shareFile = null, calendarEvent = null, source = null }) {
  const context = { minutes: minutesOf(seconds), audio_file: audioFile, transcript_file: transcriptFile };
  // Made about something shared: the share's own record says what to do, where it goes and who takes it.
  if (shareFile) return { job_id: settings.jobs.recorded_about_share, context: { ...context, share_file: shareFile } };
  if (!script) {
    const event = calendarRecordingContext(calendarEvent);
    return { job_id: settings.jobs.recorded, context: { ...context, ...(event ? { calendar_context: JSON.stringify(event) } : {}) } };
  }
  // One take of a run: the row it was read from is named, so the AI makes its draft and marks that row.
  if (script.take) return { job_id: settings.jobs.recorded_take, context: { ...context, about: script.about, list_id: script.take.list_id, row_id: script.take.row_id } };
  return { job_id: settings.jobs.recorded_with_script, context: { ...context, format_label: script.format_label, about: script.about || script.format_label, ...(source ? { source_reference: JSON.stringify(source) } : {}) } };
}

/** The job that tells the person's AIs a kept recording's words were corrected, and where the corrected words are. */
export const correctedTranscriptJob = ({ audioFile, transcriptFile, source = null }) => ({ job_id: settings.jobs.corrected, context: { audio_file: audioFile, transcript_file: transcriptFile, ...(source ? { source_reference: JSON.stringify(source) } : {}) } });

/** The job that asks the person's AIs to write a script out in their voice; with no thought, about what matters most
 * to them now (recording.json write_without_thought). */
export function writeScriptJob(script) {
  return {
    job_id: settings.jobs.write_script,
    context: {
      format_label: script.format_label,
      about: script.about || settings.write_without_thought,
      parts: script.lines.map((line, index) => `${index + 1}. ${line.label}: ${line.words || `(write this: ${line.hint ?? line.label})`}`).join('\n'),
    },
  };
}
