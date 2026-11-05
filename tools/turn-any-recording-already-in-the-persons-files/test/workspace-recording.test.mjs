// The web Record and Formats screens' own decisions (src/workspace/recording.mjs): a format with a thought in it is the
// script shown and handed off, spoken words are followed through that script like a teleprompter, and a recording is
// kept by day with its transcript and handed to the person's AIs through a job row of src/queued-work.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarRecordingContext, correctedTranscriptJob, follow, heardWords, keptNames, liveStretch, liveWorkJob, meetingTurns, mirroredView, recordingJob, scriptFor, scriptFromWords, scriptSegments, scriptText, scriptWords, START, takeScript, teleprompterAt, teleprompterIsLive, transcriptFileText, transcriptNameBeside, writeScriptJob } from '../src/workspace/recording.mjs';
import settings from '../src/workspace/recording.json' with { type: 'json' };
import captureSources from '../parts/record-audio/read-data/capture-sources.json' with { type: 'json' };
import queued from '../../turn-a-button-press-like-ask-my-ai/src/queued-work.json' with { type: 'json' };
import surfaces from '../../shared-code/src/workspace/screens.mjs';
import { queuedWork } from '../../turn-a-button-press-like-ask-my-ai/src/queued-work.mjs';
import { handleContentFormatsRequest, makeContentFormats } from '../../shape-a-thought-into-my-content-formats/read-data/content-formats.mjs';
import { keepVoiceMemo } from '../src/voice-memos.mjs';
import voiceTools from '../from-old-trillion/records/workshop-voice-and-formats-tool-records.json' with { type: 'json' };
import { toolSurfaces } from '../../keep-and-wake-ai-sessions-on-this-computer/src/work-workshop.mjs';

const format = { id: 'hook-story', label: 'Hook / Story', slots: [{ id: 'hook', label: 'Hook', hint: 'Open on the surprise' }, { id: 'story', label: 'Story', hint: 'Tell what happened next' }, { id: 'lesson', label: 'Lesson' }], output: 'A short video' };

test('a thought becomes the first part; a part with nothing of theirs keeps the format words as what to write, never as words to read', () => {
  const script = scriptFor(format, '  My serve finally clicked ');
  assert.deepEqual(script.lines.map(line => [line.words, line.hint, line.theirs]), [['My serve finally clicked', 'Open on the surprise', true], ['', 'Tell what happened next', false], ['', 'Lesson', false]]);
  assert.equal(script.ready, false, 'a template with parts still to write is not a script to record');
  assert.deepEqual(script.missing, ['Story', 'Lesson']);
  assert.deepEqual(scriptSegments(script), ['My serve finally clicked'], 'the teleprompter never reads an instruction aloud');
  assert.equal(scriptText(script), 'Hook / Story: My serve finally clicked\nHook: My serve finally clicked\nStory: (still to write: Tell what happened next)\nLesson: (still to write: Lesson)');
  // No thought yet: nothing to read, every part says what to write.
  assert.equal(scriptFor(format, '').lines[0].words, '');
  assert.equal(scriptFor(format, '').lines[0].hint, 'Open on the surprise');
  assert.equal(scriptFor(format, '').ready, false);
  // Filled from their own material, every part has words: ready.
  assert.equal(scriptFor(format, 'Serve.', 'It clicked. Then I won. Then I taught it.').ready, true);
});

test('finished words are a script ready to read; empty words are not ready, never already read', () => {
  const script = scriptFromWords('My serve finally clicked. Tell what happened next. Lesson.', { label: 'Serve' });
  assert.equal(script.ready, true);
  assert.deepEqual(scriptSegments(script), ['My serve finally clicked.', 'Tell what happened next.', 'Lesson.']);
  const empty = scriptFromWords('   ');
  assert.equal(empty.ready, false);
  assert.deepEqual(empty.missing, ['Your script']);
  assert.deepEqual(scriptSegments(empty), []);
});

test('spoken words are followed through the script, skipping asides and never going back', () => {
  const script = scriptFromWords('My serve finally clicked. Tell what happened next. Lesson.');
  const words = scriptWords(scriptSegments(script));
  let place = follow(words, heardWords('Um, my SERVE finally'));
  assert.equal(place.said, 3, 'case, punctuation and an aside do not lose the place');
  place = follow(words, heardWords('clicked tell what'), place);
  assert.equal(place.said, 6);
  // A word from far ahead is not a jump: it stays within the lookahead.
  assert.equal(follow(words, heardWords('lesson'), START, 2).said, 0);
  assert.equal(follow(words, heardWords('my my my'), place).said, 6, 'repeating an earlier word never moves back');
  // Incremental: following in two halves reaches the same place as following at once.
  const heard = heardWords('my serve finally clicked tell what happened next lesson');
  assert.deepEqual(follow(words, heard.slice(4), follow(words, heard.slice(0, 4))), follow(words, heard));
  assert.deepEqual(teleprompterAt(follow(words, heard), words.length), { activeWordIndex: words.length - 1, spokenWordCount: words.length, progress: 1 });
  assert.deepEqual(teleprompterAt(START, 0), { activeWordIndex: 0, spokenWordCount: 0, progress: 0 });
});

test('the script words count the way the teleprompter counts them, so the highlighted word is the one followed', () => {
  const words = scriptWords(['Open — on it.', '  Next  ']);
  assert.equal(words.length, 5, 'a dash is a word the teleprompter draws, so it keeps its place');
  assert.equal(follow(words, heardWords('open on')).said, 3);
});

test('the teleprompter is visible only while video is actively recording', () => {
  const activeVideo = { mode: 'video', recording: true, paused: false, captureActive: true };
  assert.equal(teleprompterIsLive(activeVideo), true);
  assert.equal(teleprompterIsLive({ ...activeVideo, recording: false }), false, 'idle video mode hides it');
  assert.equal(teleprompterIsLive({ ...activeVideo, paused: true }), false, 'paused video hides it');
  assert.equal(teleprompterIsLive({ ...activeVideo, captureActive: false }), false, 'a stopped camera hides it immediately');
  assert.equal(teleprompterIsLive({ ...activeVideo, mode: 'audio' }), false, 'audio never shows the video prompter');
});

test('a recording is kept by day under the folder DATA names, its names safe from a format label', () => {
  const at = new Date(2026, 8, 29, 7, 5, 9);
  assert.deepEqual(keptNames(at, { extension: 'webm' }), { folder: `${settings.folder}/2026-09-29`, audio: '07.05.09.webm', transcript: '07.05.09 transcript.txt' });
  const named = keptNames(at, { formatLabel: 'Hook / Story', extension: 'm4a' });
  assert.equal(named.audio, '07.05.09 Hook - Story.m4a');
  assert.ok(!named.transcript.includes('/'));
  assert.equal(transcriptNameBeside('/Recordings/a.b/07.05.09 Hook.m4a'), '/Recordings/a.b/07.05.09 Hook transcript.txt');
  assert.equal(transcriptNameBeside('memo'), 'memo transcript.txt');
});

test('what the Record screen offers to record is the one recorder\'s sources, each with kinds to try', () => {
  assert.ok(settings.sources.length > 0);
  for (const offered of settings.sources) {
    const source = captureSources.sources.find(one => one.id === offered.id);
    assert.ok(source, `${offered.id} is a source of the one recorder`);
    assert.ok(offered.label && source.types.length && source.types.every(type => type.media_type && type.extension));
  }
  assert.equal(settings.audio_types, undefined, 'recording kinds live only with the one recorder');
});

test('the transcript file carries the script first and says so when nothing was heard', () => {
  const script = scriptFor(format, 'serve');
  assert.equal(transcriptFileText(''), '(Nothing was heard in this recording.)');
  assert.equal(transcriptFileText('hello there', script), `Script\n${scriptText(script)}\n\nWhat I said\nhello there`);
});

test('every job a screen sends is a queued-work row the Worker keeps, with every value its row names', () => {
  const script = scriptFor(format, 'My serve finally clicked');
  const jobs = [
    recordingJob({ audioFile: '/Recordings from the web/2026-09-29/07.05.09.webm', transcriptFile: '/Recordings from the web/2026-09-29/07.05.09 transcript.txt', seconds: 20 }),
    recordingJob({ audioFile: '/r/a.webm', transcriptFile: '/r/a transcript.txt', seconds: 150, script, source: { kind: 'note', label: 'note', id: 'note-17', title: 'Serve notes' } }),
    recordingJob({ audioFile: '/r/a.webm', transcriptFile: '/r/a transcript.txt', seconds: 30, shareFile: '1f:' + 'b'.repeat(64) }),
    writeScriptJob(script),
    correctedTranscriptJob({ audioFile: '/r/a.webm', transcriptFile: '/r/a transcript.txt' }),
    liveWorkJob(liveStretch({ final: 'we should look into Acme Robotics before the call on Friday', quiet: settings.live_work.quiet_seconds }), '2026-10-02T21:50:00.000Z'),
    recordingJob({ audioFile: '/r/t.webm', transcriptFile: '/r/t transcript.txt', seconds: 40, script: takeScript({ id: 'row-7', title: 'Leverage', values: { script: 'Leverage is a ratio. Raise it.' } }, { list_id: 'content-pieces' }) }),
  ];
  assert.deepEqual(jobs.map(job => job.job_id), Object.values(settings.jobs));
  assert.equal(jobs[0].context.minutes, '1');
  assert.equal(jobs[1].context.minutes, '3');
  const kept = new Map();
  const work = queuedWork({ eeaf: { read: id => kept.get(id) ?? null, write: writes => writes.forEach(row => kept.set(row.id, row.value)) }, now: () => new Date('2026-09-29T12:00:00Z') });
  jobs.forEach((job, index) => {
    const answer = work.queue({ ...job, press_key: `press-${index}` });
    const record = kept.get(answer.asked_id);
    assert.ok(queued.jobs.some(row => row.id === job.job_id));
    assert.doesNotMatch(record.job, /\{\w+\}/, `${job.job_id} fills every hole`);
  });
  assert.match(kept.get(work.queue({ ...jobs[3], press_key: 'again' }).asked_id).job, /1\. Hook: My serve finally clicked\n2\. Story/);
  assert.match(kept.get(work.queue({ ...jobs[1], press_key: 'source-job' }).asked_id).job, /note-17/);
});

test('a selected content source stays separate from spoken words, survives the script job, and remains optional', () => {
  const source = { kind: 'note', label: 'note', id: 'note-17', title: 'Serve notes' };
  const said = 'The serve finally clicked.';
  const script = scriptFor(format, 'Serve notes', 'The serve finally clicked.');
  const transcript = transcriptFileText(said, script, null, source);
  assert.match(transcript, /Source: note · Serve notes \(note:note-17\)/);
  assert.match(transcript, /What I said\nThe serve finally clicked\.$/);
  assert.doesNotMatch(transcript.slice(transcript.indexOf('What I said')), /note-17/);
  const job = recordingJob({ audioFile: '/r/serve.webm', transcriptFile: '/r/serve transcript.txt', seconds: 60, script, source });
  assert.deepEqual(JSON.parse(job.context.source_reference), source);
  const withoutSource = recordingJob({ audioFile: '/r/plain.webm', transcriptFile: '/r/plain.txt', seconds: 60, script });
  assert.equal('source_reference' in withoutSource.context, false);
  assert.equal(transcriptFileText(said, script), transcriptFileText(said, script, null, null));
  const correction = correctedTranscriptJob({ audioFile: '/r/serve.webm', transcriptFile: '/r/corrected.txt', source });
  assert.deepEqual(JSON.parse(correction.context.source_reference), source);
});

test('a take is the script of a list row, one sentence a line, and its job names that row', () => {
  const script = takeScript({ id: 'row-7', title: 'Leverage', values: { notes: 'x', script: 'Leverage is a ratio. Raise it, then raise it again!' } }, { list_id: 'content-pieces' });
  assert.deepEqual(script.lines.map(line => line.words), ['Leverage is a ratio.', 'Raise it, then raise it again!']);
  assert.equal(script.about, 'Leverage');
  assert.deepEqual(script.take, { list_id: 'content-pieces', row_id: 'row-7' });
  const job = recordingJob({ audioFile: '/r/t.webm', transcriptFile: '/r/t transcript.txt', seconds: 40, script });
  assert.equal(job.job_id, settings.jobs.recorded_take);
  assert.equal(job.context.row_id, 'row-7');
  assert.equal(job.context.list_id, 'content-pieces');
  assert.equal(takeScript({ id: 'empty', title: 'Nothing yet', values: { script: '   ' } }, { list_id: 'content-pieces' }), null);
  assert.equal(takeScript({ id: 'r', values: { body: 'Said here.' } }, { list_id: 'l', script_fields: ['body'] }).about, 'Said here.');
});

test('a script view that says mirror reads backwards for a glass in front of the lens', () => {
  assert.equal(mirroredView(settings.script_views.find(view => view.mirror)), true);
  assert.equal(mirroredView(settings.script_views.find(view => !view.mirror)), false);
});

test('Record and Formats are workspace screens, the one Record and Formats every device opens', () => {
  for (const entry of ['record', 'formats']) {
    const web = surfaces.surfaces.find(row => row.package_entry?.entry_name === entry);
    assert.ok(web, entry);
    assert.deepEqual(web.route_paths, [`/${entry}`]);
  }
});

test('every account has formats to read, so Formats is never empty for a new person', () => {
  const read = makeContentFormats({ store: { saved: () => null, putSaved: () => {} } }).read();
  assert.ok(read.formats.length > 0);
  for (const one of read.formats) assert.ok(Array.isArray(one.slots));
});

const store = () => { let saved = null; return makeContentFormats({ store: { saved: () => saved, putSaved: list => { saved = list; } } }); };
const post = (formats, path, body) => handleContentFormatsRequest(formats, new Request(`https://person${path}`, { method: 'POST', body: JSON.stringify(body) })).then(async answer => ({ status: answer.status, body: await answer.json() }));

test('a thought is shaped into every format, or the ones named in order, as the Formats screen shows it', async () => {
  const formats = store();
  const every = await formats.shape({ thought: ' My serve finally clicked ' });
  assert.equal(every.scripts.length, formats.read().formats.length);
  const [thread, blog] = (await formats.shape({ thought: 'My serve finally clicked', format_ids: ['x_thread', 'blog'] })).scripts;
  assert.deepEqual([thread.format_id, blog.format_id], ['x_thread', 'blog']);
  assert.equal(thread.lines[0].words, 'My serve finally clicked');
  assert.equal(thread.text, scriptText(scriptFor(formats.read().formats.find(one => one.id === 'x_thread'), 'My serve finally clicked')));
  await assert.rejects(formats.shape({ thought: 'x', format_ids: ['nope'] }), /no format "nope"/);
  await assert.rejects(formats.shape({ thought: '  ' }), /thought/);
  const answered = await post(formats, '/content-formats/shape', { thought: 'serve', format_ids: ['blog'] });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.scripts[0].about, 'serve');
  assert.equal((await post(formats, '/content-formats/shape', {})).status, 400);
});

test('a script is followed from the words heard and goes on from the place an earlier call reached', async () => {
  const formats = store();
  const words = 'My serve finally clicked. Then I won the set.';
  const first = formats.follow({ script: words, heard: 'um my serve' });
  assert.equal(first.said, 2);
  assert.equal(first.ready, true);
  const next = formats.follow({ script: words, heard: 'finally clicked', said: first.said });
  assert.equal(next.said, 4);
  assert.equal(next.done, false);
  assert.ok(next.progress > 0 && next.progress < 1);
  assert.ok(next.next_words.length > 0);
  assert.equal(formats.follow({ script: words, heard: 'x', said: 10_000 }).said, next.total, 'a place past the end is the end');
  assert.equal(formats.follow({ script: words, heard: 'x', said: 10_000 }).done, true);
  assert.equal((await post(formats, '/content-formats/follow', { script: 'my words', heard: 'my' })).body.said, 1);
  assert.equal((await post(formats, '/content-formats/follow', { format_id: 'nope', heard: '' })).status, 400);
});

test('an empty or unwritten script says it is not ready, and is never done', async () => {
  const formats = store();
  for (const asked of [{ script: '', heard: '' }, { script: '   ', heard: 'hello' }, { format_id: 'x_thread', about: '', heard: '' }, { format_id: 'x_thread', about: 'My serve finally clicked', heard: 'my serve' }]) {
    const answer = formats.follow(asked);
    assert.equal(answer.ready, false, JSON.stringify(asked));
    assert.equal(answer.done, false, JSON.stringify(asked));
    assert.equal(answer.said, 0);
    assert.ok(answer.missing.length > 0);
    assert.match(answer.message, /not ready/);
  }
});

test('a recording in files is kept as a voice memo the way the Record screen keeps one', async () => {
  const identity = `1f:${'a'.repeat(64)}`;
  const kept = [], asked = [];
  const deps = {
    open: async () => ({ name: '/Recordings from the web/2026-09-29/07.05.09 Hook - Story.webm', media_type: 'audio/webm' }),
    transcribe: async () => ({ text: 'my serve finally clicked', segments: [{ end: 12.5 }, { end: 95 }] }),
    keep: async file => { let text = ''; for await (const piece of await file.open()) text += new TextDecoder().decode(piece); kept.push({ ...file, text }); return { identity: `1f:${'b'.repeat(64)}`, name: file.name }; },
    formats: () => store().read().formats,
    queue: async (press, options) => { asked.push(press); items.push(options.item); return { asked_id: 'asked:1', repeated: false, said: 'Sent' }; },
    itemOf: found => (found === identity ? cameWith : null),
  };
  const items = [];
  let cameWith = null;
  const memo = await keepVoiceMemo({ identity }, deps);
  assert.equal(memo.transcript_file, '/Recordings from the web/2026-09-29/07.05.09 Hook - Story transcript.txt');
  assert.equal(kept[0].text, 'my serve finally clicked');
  assert.equal(kept[0].size, new TextEncoder().encode(kept[0].text).byteLength);
  assert.deepEqual(asked[0], { ...recordingJob({ audioFile: memo.audio_file, transcriptFile: memo.transcript_file, seconds: 95 }), press_key: `voice-memo:${identity}` });
  // Read from a script, with the words already heard: the transcript starts with the script and the job names it.
  await keepVoiceMemo({ identity, words: 'hello', seconds: 30, format_id: 'x_thread', about: 'serve' }, deps);
  assert.match(kept[1].text, /^Script\n[\s\S]*\n\nWhat I said\nhello$/);
  assert.equal(asked[1].job_id, settings.jobs.recorded_with_script);
  assert.deepEqual(items, [null, null], 'a recording kept by itself is its own item');
  // A recording that came with a message is part of that message's item, so its job joins the message's one job.
  cameWith = 'message:2026-10-02T16:51:41.030Z:7014a0bd034ab5e55eb38c34';
  await keepVoiceMemo({ identity, words: 'hello', seconds: 30 }, deps);
  assert.equal(items[2], cameWith);
  await assert.rejects(keepVoiceMemo({ identity, words: 'hello' }, deps), /seconds/);
  await assert.rejects(keepVoiceMemo({ identity: 'nope' }, deps), /identity/);
  await assert.rejects(keepVoiceMemo({ identity }, { ...deps, open: async () => ({ name: 'a.pdf', media_type: 'application/pdf' }) }), /not a recording/);
  // Silent footage still has pictures to inspect. Use the same key and message item as a spoken recording, without
  // making up words or a length. Silent audio still asks for no work.
  const handed = asked.length;
  const silent = await keepVoiceMemo({ identity }, { ...deps, open: async () => ({ name: '/Recordings/Cameras/2026-10-05/17.42.20 Sample.mp4', media_type: 'video/mp4' }), transcribe: async () => ({ text: '', segments: [] }) });
  assert.equal(silent.nothing_said, true);
  assert.equal(silent.transcript_file, '/Recordings/Cameras/2026-10-05/17.42.20 Sample transcript.txt');
  assert.equal(silent.words, '');
  assert.equal(asked.length, handed + 1, 'silent video is handed on for visual inspection');
  assert.deepEqual(asked[handed], { job_id: 'hand-silent-video', context: {
    audio_file: '/Recordings/Cameras/2026-10-05/17.42.20 Sample.mp4', audio_identity: identity, transcript_file: silent.transcript_file,
  }, press_key: `voice-memo:${identity}` });
  assert.equal(items[handed], cameWith, 'the same message owns the silent video too');
  assert.equal(silent.asked_id, 'asked:1');
  await keepVoiceMemo({ identity }, { ...deps, transcribe: async () => ({ text: '', segments: [] }) });
  assert.equal(asked.length, handed + 1, 'silent audio needs no visual analysis');
});

test('the Record and Formats jobs are Workshop tools with the app screens that do them', () => {
  const tools = voiceTools.records.map(row => row.payload);
  const entries = { 'shape-into-formats': 'formats', 'follow-a-script': 'record', 'keep-a-voice-memo': 'record' };
  const byAction = Object.fromEntries(tools.map(tool => [tool.invoke.action, tool.screen.entry]));
  for (const [action, entry] of Object.entries(entries)) assert.equal(byAction[action], entry, `${action} opens ${entry}`);
  for (const tool of tools) {
    assert.equal(tool.kind, 'ai-tool-descriptor');
    assert.equal(tool.screen.kind, 'app-entry');
    if (Object.hasOwn(entries, tool.invoke.action)) {
      assert.ok(surfaces.surfaces.some(row => row.package_entry?.entry_name === tool.screen.entry), `${tool.id} opens its shipped app screen`);
    } else {
      const [screen] = toolSurfaces([{ ...tool, tool_id: tool.id }]);
      assert.equal(screen?.id, tool.id, `${tool.id} gets its own placeable tool screen`);
      assert.equal(screen?.package_entry?.entry_name, 'tool-screen');
    }
    assert.ok(tool.verify.length);
  }
});

test('a recording made about something shared opens at /record/about/<share> and hands on the share with it', async () => {
  const share = '1f:' + 'a'.repeat(64);
  const opened = (await import('../../hand-off-jobs-between-agents/src/workspace/addresses.mjs')).screenAt(surfaces.surfaces, `/record/about/${share}`);
  assert.equal(opened.row.id, 'trillion.record');
  assert.deepEqual(opened.input, { share });
  const job = recordingJob({ audioFile: '/r/a.webm', transcriptFile: '/r/a transcript.txt', seconds: 40, shareFile: share });
  assert.deepEqual(job, { job_id: settings.jobs.recorded_about_share, context: { minutes: '1', audio_file: '/r/a.webm', transcript_file: '/r/a transcript.txt', share_file: share } });
  const row = queued.jobs.find(item => item.id === job.job_id);
  assert.ok(row, 'the job is a row of src/queued-work.json');
  const writes = [];
  const asked = queuedWork({ eeaf: { read: () => null, write: rows => writes.push(...rows) } }).queue({ ...job, press_key: `record:${share}` });
  assert.equal(asked.repeated, false);
  assert.match(writes[0].value.job, new RegExp(share));
  assert.match(writes[0].value.job, /to_agent/);
});

test('words heard while recording go to the AIs one finished turn at a time, a long turn in windows, never twice', () => {
  const rules = settings.live_work;
  const short = 'yes we should';
  assert.equal(liveStretch({ final: short }), null, 'a turn shorter than turn_min_words waits');
  assert.equal(liveStretch({ final: 'can you make it center', quiet: rules.quiet_seconds - 1 }), null, 'a short pause does not hand a fragment');
  assert.equal(liveStretch({ final: 'can you make it', quiet: rules.quiet_seconds }), null, 'a fragment shorter than quiet_min_words waits even after a pause');
  const asked = 'can you make it centered and put the character on the left of the label';
  assert.equal(liveStretch({ final: asked, quiet: rules.quiet_seconds }).words, asked, 'after a real pause the whole request goes as one job');
  const rest = Array.from({ length: rules.turn_min_words }, (_, index) => (index === 3 ? 'Acme Robotics' : `said${index}`)).join(' ');
  const turn = `${short} ${rest}`;
  const first = liveStretch({ final: turn });
  assert.deepEqual([first.start, first.words], [0, turn], 'the short turn joins the next one and both go together');
  assert.equal(liveStretch({ final: turn, handed: first.end }), null, 'a handed turn is never handed again');
  const long = Array.from({ length: rules.long_turn_words }, (_, index) => `word${index}`).join(' ');
  const window = liveStretch({ final: turn, hearing: long, handed: first.end });
  assert.equal(window.end - window.start, rules.long_turn_words, 'a long turn still being said is handed once long_turn_words gather');
  assert.equal(liveStretch({ final: `${turn} ${long}`, handed: window.end }), null, 'when that long turn ends, its handed words are not handed again');
  assert.match(window.earlier, /Acme Robotics/, 'the words before it travel as context');
  const job = liveWorkJob(window, '2026-10-02T21:50:00.000Z');
  assert.ok(job.context.heading.length <= rules.heading_chars);
});

test('one meeting recorded on several devices reads as one transcript, the same words heard twice kept once', () => {
  const kind = settings.meeting.item_kind;
  const item = (text, device, by, second) => ({ kind, body: { text, device, at: `2026-10-02T21:50:${String(second).padStart(2, '0')}.000Z` }, provenance: { by, added_at: `2026-10-02T21:50:${String(second).padStart(2, '0')}.500Z` } });
  const turns = meetingTurns([
    item('Can someone look up Olipop before Friday', 'phone', 'Sam', 1),
    item('can someone look up olipop before friday please', 'laptop', 'Casey', 2),
    item('I will send Dana the pilot plan tonight', 'laptop', 'Casey', 9),
    item('Can someone look up Olipop before Friday', 'phone', 'Sam', 50),
    { kind: 'message', body: { text: 'not a said turn' }, provenance: { by: 'Sam', added_at: '2026-10-02T21:50:03.000Z' } },
  ]);
  assert.equal(turns.length, 3, 'the turn both devices heard is kept once; a repeat long after is its own turn');
  assert.deepEqual(turns[0].devices, ['phone', 'laptop']);
  assert.deepEqual(turns[0].who, ['Sam', 'Casey']);
  assert.equal(turns[0].text, 'can someone look up olipop before friday please', 'the fuller wording is kept');
  assert.deepEqual(turns[1].who, ['Casey']);
});

test('a line heard again and again back to back reads once and is never handed to the AIs as work', async () => {
  const { loopFreeWords, withoutLoops, isMostlyRepeated } = await import('../../record-voice-and-meetings/read-data/heard-words.mjs');
  const line = 'Why one recorder beats three?';
  const looped = `Okay. Go ahead. ${Array.from({ length: 20 }, () => line).join(' ')} then we talk about lunch`;
  assert.equal(withoutLoops(looped), `Okay. Go ahead. ${line} then we talk about lunch`, 'twenty copies in a row read as one');
  assert.equal(withoutLoops('no, no, I said the plan'), 'no, no, I said the plan', 'a word said twice on purpose stays');
  const shown = loopFreeWords();
  const words = looped.split(' ');
  let last = '';
  for (let count = 1; count <= words.length; count += 1) last = shown(words.slice(0, count).join(' '));
  assert.equal(last, withoutLoops(looped), 'words that grow one at a time read the same as all at once');
  assert.equal(shown('something else entirely'), 'something else entirely', 'words that changed are read afresh');
  const heardLoop = Array.from({ length: 30 }, (_, index) => (index % 4 === 1 ? 'Why one recorder beat three?' : line)).join(' ');
  assert.ok(isMostlyRepeated(heardLoop), 'a misheard copy now and then still reads as one line on repeat');
  const stretch = liveStretch({ final: heardLoop, quiet: settings.live_work.quiet_seconds });
  assert.equal(stretch.repeated, true, 'a stretch that is one line on repeat is passed over');
  const talk = Array.from({ length: settings.live_work.turn_min_words }, (_, index) => `word${index}`).join(' ');
  assert.equal(liveStretch({ final: talk }).repeated, false, 'someone talking is handed as said');
});

test('meeting identity survives transcript saving, correction and the existing recording job', () => {
  const event = { id: 'google-calendar:review-1', title: 'Design review\nMeeting', starts_at: '2026-10-14T10:00:00-07:00', source: 'google-calendar', space_id: 'pursuit-1' };
  const context = calendarRecordingContext(event);
  assert.equal(context.title, 'Design review Meeting');
  assert.equal(context.starts_at, '2026-10-14T17:00:00.000Z');
  assert.equal(calendarRecordingContext({ ...event, starts_at: 'invalid' }), null);
  for (const words of ['We will send the brief.', 'Corrected: we will send the brief.']) {
    const transcript = transcriptFileText(words, null, context);
    assert.match(transcript, /Calendar entry: google-calendar:review-1/);
    assert.match(transcript, /Pursuit: pursuit-1/);
    assert.ok(transcript.endsWith(words));
  }
  const job = recordingJob({ audioFile: '/r/review.webm', transcriptFile: '/r/review.txt', seconds: 60, calendarEvent: context });
  assert.deepEqual(JSON.parse(job.context.calendar_context), context);
  const kept = new Map();
  const work = queuedWork({ eeaf: { read: id => kept.get(id) ?? null, write: writes => writes.forEach(row => kept.set(row.id, row.value)) } });
  const answer = work.queue({ ...job, press_key: 'meeting-context' });
  assert.match(kept.get(answer.asked_id).job, /google-calendar:review-1/);
});

