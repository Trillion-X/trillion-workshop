// tools/listen-for-a-while/test/voice-session.test.mjs
//
// A listening session is bounded by data (read-data/voice-session.json): it starts on a wake phrase or start(), is
// refreshed by speech, and ends on silence, on its longest length, or on a spoken dismissal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVoiceSession, voiceSettings } from '../read-data/voice-session.mjs';

const settings = voiceSettings();
const clockAt = () => { const clock = { at: Date.parse('2026-10-19T10:00:00Z') }; return { clock, now: () => clock.at, advance: seconds => { clock.at += seconds * 1000; } }; };

test('a session that is not active hears nothing, and a wake phrase opens it with the words after it', () => {
  const { now } = clockAt();
  const session = makeVoiceSession({ now });
  assert.deepEqual(session.heard('what time is it'), { active: false, handle: false, said: settings.words.not_listening });
  assert.equal(session.state().active, false);
  const opened = session.heard('Hey, Trillion! What is on my calendar?');
  assert.deepEqual([opened.active, opened.handle, opened.text], [true, true, 'what is on my calendar']);
  assert.equal(session.heard('hey trillion').handle, true, 'inside a session the phrase is just speech');
  const bare = makeVoiceSession({ now });
  assert.deepEqual(bare.heard('hey trillion'), { active: true, said: settings.words.started, handle: false });
});

test('silence ends it, speech keeps it, and the longest length ends it however busy', () => {
  const { now, advance } = clockAt();
  const session = makeVoiceSession({ now });
  session.start();
  advance(settings.idle_seconds - 1);
  assert.equal(session.heard('still here').handle, true);
  advance(settings.idle_seconds - 1);
  assert.equal(session.state().active, true, 'the last words refreshed it');
  advance(2);
  const late = session.heard('too late');
  assert.deepEqual([late.active, late.handle, late.ended], [false, false, 'idle']);
  assert.match(late.said, /after 30 seconds of quiet/);
  session.start();
  for (let spent = 0; spent < settings.max_seconds; spent += 10) { advance(10); if (!session.state().active) break; session.heard('keep going'); }
  const state = session.state();
  assert.deepEqual([state.active, state.ended], [false, 'long']);
});

test('a dismissal ends it and is not handled, alone or after a lead-in word, but not inside other words', () => {
  const { now } = clockAt();
  const session = makeVoiceSession({ now });
  for (const phrase of ['goodbye', 'Okay, never mind.', "that's all", 'alright so stop listening']) {
    session.start();
    const out = session.heard(phrase);
    assert.deepEqual([out.active, out.handle, out.ended], [false, false, 'dismissed'], phrase);
  }
  session.start();
  assert.equal(session.heard('say goodbye to the team').handle, true, 'a dismissal word inside a request is a request');
  assert.equal(session.heard('').handle, false);
  assert.equal(session.state().active, true);
});
