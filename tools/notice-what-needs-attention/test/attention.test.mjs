// Attention rules decide, for free, what an arriving item gets: the starting rules keep words heard in a room as context
// unless the computer is sure the voice is the person's, ask the classifier on the person's computer about words they
// surely said there, and act on the rest.
// Evaluated through the real formula engine, as the store does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import attentionDataRows from '../src/attention.json' with { type: 'json' };
import { createAttention } from '../read-data/attention.mjs';
import { broughtIn, wordsAgeMinutes } from '../src/brought-in.mjs';
import { initSync, filterRecords as engineFilterRecords } from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
// The formula engine is loaded on the first rule read, from its bytes beside the built module.
let engineReady = false;
const filterRecords = request => {
  if (!engineReady) {
    initSync({ module: readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm'))) });
    engineReady = true;
  }
  return engineFilterRecords(request);
};
const { attentionData, attentionFacts, attentionOpens, attentionRules, checkAttentionRules, classifiedAttention, classifyRequest, decideAttention, handleAttentionRequest, keptAs, retriageWaiting } = createAttention(attentionDataRows, { broughtIn, wordsAgeMinutes });
import { WorkFailure } from '../../shared-code/src/failure.mjs';

const matches = async (tree, facts) => filterRecords({ tree, fields: attentionData.facts, records: [facts] }).matches.length === 1;
const decide = (arrival, saved = null) => decideAttention({ rules: attentionRules(saved), facts: attentionFacts(arrival), matches });

const sure = { me: true, named: true, name: 'Sam', score: 0.91 };
const morgan = { me: false, named: true, name: 'Morgan', score: 0.88 };
const line = 'Trillion, remind me to call the dentist tomorrow at nine';
const heardLine = arrival => ({ route: 'Listening', heard: true, text: line, ...arrival });

test('words heard in a room are context unless they ask for something; written words act', async () => {
  const unconfirmed = { attention: 'context', rule: 'heard-not-surely-the-person', from: 'An unknown voice', maybe_from: 'Unsure ({name}?)' };
  assert.deepEqual(await decide({ route: 'Listening', heard: true, text: 'Oh, that is it.', voice: { me: false, named: false, score: 0.31 }, from_person: false, from: 'Someone (voice-73)' }), unconfirmed);
  assert.deepEqual(await decide({ route: 'Listening', heard: true, text: "where'd you put the coconut oil spray", voice: sure }), { attention: 'classify', rule: 'heard-the-person' });
  assert.deepEqual(await decide({ route: 'Any carrier', heard: true, text: 'amazing shot', verdict: 'context', voice: sure }), { attention: 'context', rule: 'carrier-said-context' });
  assert.deepEqual(await decide({ route: 'Apple Notes', text: 'Book the dentist for Friday' }), { attention: 'act', rule: null });
  assert.deepEqual(await decide({ route: 'Email', text: 'Shipped 1 item', from_person: false }), { attention: 'act', rule: null });
});

test('"remind me to call the dentist" belongs to whoever said it, and is the person\'s only in their sure voice', async () => {
  const kept = async arrival => { const decided = await decide(heardLine(arrival)); return { decided, kept: keptAs(heardLine(arrival), decided) }; };
  // The person, surely: theirs to act on.
  const mine = await kept({ voice: sure, verdict: 'act' });
  assert.equal(mine.decided.attention, 'act');
  assert.equal(mine.kept.from_person, undefined, 'kept as the person\'s own words');
  // Morgan, surely: Morgan's request, handed on as his.
  const his = await kept({ voice: morgan, verdict: 'act', from_person: false, from: 'Morgan' });
  assert.deepEqual([his.decided.attention, his.kept.from_person, his.kept.from, his.kept.words_as], ['theirs', false, 'Morgan', 'heard_from_someone']);
  // A new voice: that voice's request, and the person is asked who said it.
  const theirs = await kept({ voice: { me: false, named: false, score: 0.42 }, verdict: 'act', from_person: false, from: 'Someone (voice-3)' });
  assert.deepEqual([theirs.decided.attention, theirs.kept.from_person, theirs.kept.from, theirs.kept.words_as], ['unsure', false, 'Someone (voice-3)', 'heard_unsure']);
  // A voice the computer keeps apart under its own label: a person of its own, whose request is theirs.
  const fresh = await kept({ voice: { me: false, named: false, score: 0.42, voice: 'voice-3' }, verdict: 'act', from_person: false, from: 'Someone (voice-3)' });
  assert.deepEqual([fresh.decided.attention, fresh.decided.rule, fresh.kept.from, fresh.kept.words_as, fresh.kept.person_record], ['theirs', 'heard-a-new-voice-ask', 'Someone (voice-3)', 'heard_from_someone', true]);
  assert.equal((await kept({ voice: { me: false, named: false, score: 0.42, voice: 'voice-9' }, verdict: 'act' })).kept.from, 'Someone (voice-9)', 'named by its label when its carrier sent no name');
  assert.equal(his.kept.person_record, true, 'an enrolled speaker is a person record too');
  assert.equal(theirs.kept.person_record, undefined, 'no person is made for a voice the person is asked about');
  // Named as the person but not alike enough, or not measured: never the person's, asked who said it.
  for (const voice of [{ me: true, named: true, name: 'Sam', score: 0.62 }, { me: true, named: true, name: 'Sam', score: 0.7 }, { me: true, named: true, name: 'Sam', score: null }]) {
    const unsure = await kept({ voice, verdict: 'act' });
    assert.deepEqual([unsure.decided.attention, unsure.kept.from_person, unsure.kept.from], ['unsure', false, 'Unsure (Sam?)'], JSON.stringify(voice));
  }
  // No voice at all: a request is still kept as an unknown speaker's, never the person's.
  const unknown = await kept({ verdict: 'act' });
  assert.deepEqual([unknown.decided.attention, unknown.kept.from_person, unknown.kept.from], ['unsure', false, 'An unknown voice']);
  // Someone else claimed as the person by a carrier, however alike: theirs.
  assert.equal((await kept({ voice: { me: true, named: true, score: 0.95 }, verdict: 'act', from_person: false, from: 'Morgan' })).kept.from, 'Morgan');
  // No verdict (no classifier on the computer): only the person's sure voice is asked about; the rest is context.
  assert.equal((await kept({ voice: sure })).decided.attention, 'classify');
  assert.deepEqual([(await kept({ voice: morgan, from_person: false, from: 'Morgan' })).decided.attention, (await kept({})).decided.attention], ['context', 'context']);
  assert.equal((await kept({})).kept.from, 'An unknown voice');
  assert.equal(attentionOpens('unconfirmed'), false);
  assert.equal(attentionOpens('unsure'), true);
  assert.deepEqual(keptAs({ route: 'Notes', text: line }, { attention: 'context', rule: null }), { route: 'Notes', text: line });
});

test('a carrier\'s own classifier verdict decides written words', async () => {
  assert.equal((await decide({ route: 'Any carrier', text: 'remind me to call the dentist', verdict: 'act' })).attention, 'act');
  assert.equal((await decide({ route: 'Any carrier', text: 'amazing shot', verdict: 'context' })).attention, 'context');
  assert.equal(attentionFacts({ verdict: 'anything else' }).verdict, '');
});

test('a person\'s own rules replace the starting rules, and are checked before they are kept', async () => {
  const own = { rules: checkAttentionRules([{ id: 'all-mail-is-context', says: 'Mail is context', attention: 'context', when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'route', operator: 'is_any_of', params: { values: ['Email'] } }] } }]) };
  assert.equal((await decide({ route: 'Email', text: 'Shipped 1 item', from_person: false }, own)).attention, 'context');
  assert.equal((await decide({ route: 'Listening', text: 'heard', from_person: false }, own)).attention, 'act');
  assert.equal(checkAttentionRules([{ id: 'u', attention: 'unconfirmed', when: null }])[0].attention, 'unconfirmed');
  assert.throws(() => checkAttentionRules([{ id: 'x', attention: 'shout' }]), /attention is one of/);
  assert.throws(() => checkAttentionRules([{ attention: 'act' }]), /needs an id/);
});

test('the classifier is asked a yes-or-no question about the words, and its probability picks act or context', () => {
  const asked = classifyRequest(attentionFacts({ text: 'call the dentist' }));
  assert.match(asked.state, /call the dentist/);
  assert.equal(asked.questions.verdict.type, 'noul');
  assert.equal(classifiedAttention({ answers: { verdict: { noul: 0.86 } } }), 'act');
  assert.equal(classifiedAttention({ answers: { verdict: { noul: 0.03 } } }), 'context');
  assert.equal(classifiedAttention(null), null);
});

// 2026-10-04 Sam asked aloud, in his room, for Trillion to talk back to him; the classifier's question then named
// only errands (send, call, book...), so a request about how Trillion itself should work was kept as context and
// never became work. The question is changed only by measuring it on the calibration lines, and every request that
// was lost that way must be caught by the question in use.
test('the classifier question in use was measured, and catches every request it once lost', () => {
  const calibration = JSON.parse(readFileSync(new URL('../src/attention-calibration.json', import.meta.url), 'utf8'));
  const measured = calibration.last_measure;
  assert.ok(measured, 'node scripts/measure-attention.mjs has not been run on the calibration lines');
  assert.equal(measured.question, attentionData.classify.question, 'the question changed without being measured again (node scripts/measure-attention.mjs)');
  assert.equal(measured.act_at, attentionData.classify.act_at, 'the bar changed without being measured again');
  assert.equal(measured.lines.length, calibration.lines.length, 'lines were added without being measured');
  calibration.lines.forEach((line, index) => {
    assert.equal(measured.lines[index].text, line.text, 'the measure is of other lines');
    if (line.lost) assert.ok(measured.lines[index].p >= measured.act_at, `a request once lost is still missed: ${line.text.slice(0, 80)}`);
  });
  assert.equal(measured.acted, 0, 'the question acts on lines heard in a room that ask for nothing');
  assert.ok(calibration.lines.some(line => line.lost && /talk out loud/.test(line.text)), 'the 2026-10-04 ask is kept as a calibration line');
});

test('words said a day or more before they reached Trillion (brought-in history) are context; a late but live catch-up still acts', async () => {
  const captured = '2026-10-07T18:00:00.000Z';
  const imported = { route: 'ChatGPT', from_person: false, text: 'Go to the settings page and press Connect; only you can.', at: '2023-04-17T09:12:00.000Z', recorded_at: captured };
  assert.deepEqual(await decide(imported), { attention: 'context', rule: 'brought-in-history' });
  const facts = attentionFacts(imported);
  assert.equal(facts.brought_in, true);
  assert.ok(facts.words_age_minutes > 60 * 24 * 365, 'the age is read from when the words were said to when they were kept');
  // A laptop catching up overnight, a message corrected to an earlier time only by minutes, and words arriving now act.
  assert.deepEqual(await decide({ ...imported, at: '2026-10-07T06:00:00.000Z' }), { attention: 'act', rule: null });
  assert.deepEqual(await decide({ route: 'Email', text: 'Book the dentist', at: '2026-10-07T17:59:00.000Z', recorded_at: captured }), { attention: 'act', rule: null });
  // A corrected authored time is the time the words were said.
  assert.equal(attentionFacts({ ...imported, at: captured, authored_at: '2024-01-01T00:00:00.000Z' }).brought_in, true);
  // An arrival not kept yet counts as kept now; one with no time of its own is never history.
  assert.equal(attentionFacts({ text: 'x', at: '2023-01-01T00:00:00.000Z' }, Date.parse(captured)).brought_in, true);
  assert.deepEqual([attentionFacts({ text: 'x' }).brought_in, attentionFacts({ text: 'x' }).words_age_minutes], [false, null]);
  // The person's own rules still decide: a person who wants old asks acted on keeps a rule without it.
  assert.deepEqual(await decide(imported, { rules: [] }), { attention: 'act', rule: null });
});

test('the attention owner reads the starting rules, keeps the person\'s own, goes back to the starting rules on null, and leaves busy failures to the shared failure owner', async () => {
  let saved = null;
  const owner = { fact: async () => saved, setFact: async row => { saved = row; }, retriage: async input => ({ asked: input }), now: () => new Date('2026-10-14T12:00:00Z') };
  const call = async (path, method = 'GET', body) => {
    const response = await handleAttentionRequest(owner, new Request(`https://person${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, body: await response.json() };
  };
  const start = await call('/attention');
  assert.equal(start.status, 200); assert.equal(start.body.own, false);
  assert.deepEqual(start.body.rules, attentionRules(null));
  assert.deepEqual(Object.keys(start.body), ['rules', 'own', 'facts', 'attentions', 'otherwise', 'classify']);
  const rules = [{ id: 'all-context', says: 'Keep everything as context', when: null, attention: 'context' }];
  const kept = await call('/attention', 'POST', { rules });
  assert.equal(kept.status, 200, JSON.stringify(kept.body)); assert.equal(kept.body.own, true);
  assert.deepEqual(saved, { rules: checkAttentionRules(rules), set_at: '2026-10-14T12:00:00.000Z' });
  assert.deepEqual((await call('/attention')).body.rules, checkAttentionRules(rules));
  const refused = await call('/attention', 'POST', { rules: [{ id: 'bad', attention: 'nowhere' }] });
  assert.equal(refused.status, 400); assert.deepEqual(saved.rules, checkAttentionRules(rules), 'a refused replacement keeps the rules that were there');
  assert.equal((await call('/attention', 'POST', { rules: null })).body.own, false);
  assert.equal(saved, null);
  assert.deepEqual((await call('/attention/retriage', 'POST', { limit: 5 })).body, { asked: { limit: 5 } });
  assert.equal((await call('/attention/retriage')).status, 404, 'retriage is a write');
  const busy = { ...owner, fact: async () => { throw new WorkFailure('service-busy', 'busy'); } };
  await assert.rejects(handleAttentionRequest(busy, new Request('https://person/attention')), error => error.failure_code === 'service-busy');
});

test('retriage closes the waiting jobs the rules now keep as context, asks the classifier at most `classified` times, and resumes from next_after', async () => {
  const handoffs = [
    { handoff_id: 'h1', input: { arrived: { message_id: 'm1', route: 'Listening', from_person: true } } },
    { handoff_id: 'h2', input: { arrived: { message_id: 'm2', route: 'Listening', from_person: true } }, taken_by: 'ai-one' },
    { handoff_id: 'h3', input: { said_by_ai: { message_id: 'm3' } } },
    { handoff_id: 'h4', input: {} },
    { handoff_id: 'h5', input: { arrived: { message_id: 'm5', route: 'Listening', from_person: true } } },
    { handoff_id: 'h6', input: { arrived: { message_id: 'm6', route: 'Listening', from_person: true } } },
  ];
  const messages = { m1: { text: 'the kettle is on', at: '2026-10-14T10:00:00Z' }, m2: { text: 'taken already' }, m3: { text: 'an AI said this', app: 'Codex' }, m5: { text: 'ask me', at: '2026-10-14T10:05:00Z' }, m6: { text: 'and me' } };
  const closed = [], pages = [];
  const pieces = {
    openHandoffs: ({ after, limit }) => { pages.push({ after, limit }); const from = after ? handoffs.findIndex(row => row.handoff_id === after) + 1 : 0; return handoffs.slice(from, from + limit).map(({ handoff_id }) => ({ handoff_id })); },
    readHandoff: id => handoffs.find(row => row.handoff_id === id),
    readMessage: id => messages[id] ?? null,
    byRules: async arrival => arrival.text === 'the kettle is on' ? { attention: 'context', rule: 'carrier-said-context' } : arrival.route === 'Codex' ? { attention: 'act', rule: 'carrier-said-act' } : { attention: 'classify', rule: 'heard-the-person' },
    attention: async arrival => ({ attention: arrival.text === 'ask me' ? 'context' : 'act' }),
    close: async items => { closed.push(...items); return { closed: items.map(({ handoff_id }) => ({ handoff_id })) }; },
  };
  const first = await retriageWaiting(pieces, { limit: 500, classified: 1 });
  assert.deepEqual(pages[0], { after: null, limit: 50 }, 'one bounded page even when asked for 500');
  assert.deepEqual(first, { looked_at: 6, closed: 2, classified: 1, next_after: 'h5' }, 'the second classify stops the page before it is asked');
  assert.deepEqual(closed.map(({ handoff_id, outcome }) => [handoff_id, outcome]), [['h1', 'handled'], ['h5', 'handled']]);
  assert.equal(closed[0].reason, attentionData.starting_rules.find(rule => rule.id === 'carrier-said-context').says);
  assert.equal(closed[1].reason, attentionData.words.classified_context);
  const second = await retriageWaiting(pieces, { after: first.next_after, classified: 1 });
  assert.deepEqual(pages[1], { after: 'h5', limit: 50 });
  assert.deepEqual(second, { looked_at: 1, closed: 0, classified: 1, next_after: 'h6' });
});
