#!/usr/bin/env node
// Every check here is one of the ways a naive version of this gets it wrong. None of
// them touches a file, a socket or a clock, which is the point: if this test needed a
// filesystem, the unit would know about filesystems and would not be the primitive.
//
// The checks that matter most are the ones a healthy source can never trigger:
// emptiness must not overwrite a good kept answer, and a falsy answer is still an
// answer. Both are invisible until the one day they cost you the page.

import {
  keepTheLastGoodAnswer,
  FROM_THE_SOURCE,
  FROM_WHAT_WAS_KEPT,
  NOTHING_TO_GIVE,
} from '../do-work/keep-the-last-good-answer.mjs';

const failures = [];
function check(name, condition, detail) {
  if (condition) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? `, ${detail}` : ''}`); failures.push(name); }
}

// A store that lives entirely in this variable. Proves the unit is storage-blind.
function aStoreInMemory(startingWith) {
  const box = { kept: startingWith };
  return {
    box,
    readWhatWasKept: () => box.kept,
    keepThisAnswer: (value) => { box.kept = value; },
  };
}

console.log('keep-the-last-good-answer');

// ---------------------------------------------------------------------------
{
  const store = aStoreInMemory(undefined);
  const answerNow = keepTheLastGoodAnswer({ askTheSource: () => 'live', ...store });
  const answer = await answerNow();
  check('a live answer is returned', answer.value === 'live', JSON.stringify(answer));
  check('and it says it came from the source', answer.origin === FROM_THE_SOURCE);
  check('and it was kept for next time', store.box.kept === 'live');
}

// ---------------------------------------------------------------------------
{
  const store = aStoreInMemory('the previous truth');
  const answerNow = keepTheLastGoodAnswer({
    askTheSource: () => { throw new Error('source is down'); },
    ...store,
  });
  const answer = await answerNow();
  check('a dead source hands back what survived', answer.value === 'the previous truth');
  check('and it says so, rather than pretending to be fresh', answer.origin === FROM_WHAT_WAS_KEPT);
  check('and the failure is reported, not swallowed',
    /source is down/.test(String(answer.sourceFailure?.message)));
  check('and the failure was RETURNED rather than raised', true);
}

// ---------------------------------------------------------------------------
// The one that turns this whole idea into a blank page that never recovers.
{
  const store = aStoreInMemory('the previous truth');
  const answerNow = keepTheLastGoodAnswer({ askTheSource: () => null, ...store });
  const answer = await answerNow();
  check('a source answering with nothing does NOT overwrite what was kept',
    store.box.kept === 'the previous truth', `store now holds ${JSON.stringify(store.box.kept)}`);
  check('and the survivor is served instead', answer.value === 'the previous truth');
  check('and undefined behaves the same as null', await (async () => {
    const second = aStoreInMemory('still here');
    await keepTheLastGoodAnswer({ askTheSource: () => undefined, ...second })();
    return second.box.kept === 'still here';
  })());
}

// ---------------------------------------------------------------------------
// A truthiness check instead of a null check would fail every one of these.
{
  for (const falsyButReal of [0, '', false]) {
    const store = aStoreInMemory('older');
    const answer = await keepTheLastGoodAnswer({ askTheSource: () => falsyButReal, ...store })();
    check(`${JSON.stringify(falsyButReal)} is a real answer, not an absent one`,
      answer.value === falsyButReal && answer.origin === FROM_THE_SOURCE,
      JSON.stringify(answer));
    check(`${JSON.stringify(falsyButReal)} was kept`, store.box.kept === falsyButReal);
  }
}

// ---------------------------------------------------------------------------
{
  const answerNow = keepTheLastGoodAnswer({
    askTheSource: () => 'live',
    readWhatWasKept: () => undefined,
    keepThisAnswer: () => { throw new Error('disk is full'); },
  });
  const answer = await answerNow();
  check('a failing keeper still returns the live value', answer.value === 'live');
  check('and still calls it fresh, because it is', answer.origin === FROM_THE_SOURCE);
  check('and reports the keep failure beside it',
    /disk is full/.test(String(answer.keepFailure?.message)));
}

// ---------------------------------------------------------------------------
{
  const answerNow = keepTheLastGoodAnswer({
    askTheSource: () => { throw new Error('down'); },
    readWhatWasKept: () => { throw new Error('store is corrupt'); },
  });
  const answer = await answerNow();
  check('an unreadable store behaves as an empty one', answer.origin === NOTHING_TO_GIVE);
  check('and the value is null rather than a thrown error', answer.value === null);
  check('and the store failure is still reported',
    /store is corrupt/.test(String(answer.keptFailure?.message)));
}

// ---------------------------------------------------------------------------
{
  const answer = await keepTheLastGoodAnswer({
    askTheSource: () => { throw new Error('down'); },
    readWhatWasKept: () => undefined,
  })();
  check('nothing live and nothing kept says nothing to give', answer.origin === NOTHING_TO_GIVE);
  check('and hands back null, not undefined, so a caller can test it once', answer.value === null);
}

// ---------------------------------------------------------------------------
// The public host of the original incident: a caller with no store at all.
{
  const answer = await keepTheLastGoodAnswer({ askTheSource: () => 'published' })();
  check('a caller with no store is a passthrough, not an error',
    answer.value === 'published' && answer.origin === FROM_THE_SOURCE);

  const empty = await keepTheLastGoodAnswer({ askTheSource: () => { throw new Error('x'); } })();
  check('and with no store and a dead source it says nothing to give',
    empty.origin === NOTHING_TO_GIVE && empty.value === null);
}

// ---------------------------------------------------------------------------
{
  let threw = null;
  try { keepTheLastGoodAnswer({}); } catch (error) { threw = error; }
  check('refuses to exist without a source, rather than silently never answering',
    threw instanceof TypeError, String(threw));
}

// ---------------------------------------------------------------------------
// An async source and an async store, since every real caller is async.
{
  const box = { kept: undefined };
  const answer = await keepTheLastGoodAnswer({
    askTheSource: async () => ({ deep: { value: 1 } }),
    readWhatWasKept: async () => box.kept,
    keepThisAnswer: async (value) => { box.kept = value; },
  })();
  check('promises are awaited on all three collaborators',
    answer.value?.deep?.value === 1 && box.kept?.deep?.value === 1);
}

// ---------------------------------------------------------------------------
// The shape is a promise, not an accident. Every path must return the same five keys
// in the same order, so property access stays monomorphic and no consumer ever has to
// ask whether a key EXISTS rather than what its value is. Without this check the fixed
// shape would quietly rot the first time someone added a conditional field.
{
  const SHAPE = 'origin,value,sourceFailure,keepFailure,keptFailure';
  const everyPath = [
    ['live and kept', keepTheLastGoodAnswer({ askTheSource: () => 'a', ...aStoreInMemory(undefined) })],
    ['live, no store', keepTheLastGoodAnswer({ askTheSource: () => 'a' })],
    ['dead source, survivor', keepTheLastGoodAnswer({ askTheSource: () => { throw new Error('x'); }, ...aStoreInMemory('b') })],
    ['dead source, nothing kept', keepTheLastGoodAnswer({ askTheSource: () => { throw new Error('x'); } })],
    ['empty answer, survivor', keepTheLastGoodAnswer({ askTheSource: () => null, ...aStoreInMemory('b') })],
    ['keeper throws', keepTheLastGoodAnswer({ askTheSource: () => 'a', keepThisAnswer: () => { throw new Error('x'); } })],
    ['store throws', keepTheLastGoodAnswer({ askTheSource: () => { throw new Error('x'); }, readWhatWasKept: () => { throw new Error('y'); } })],
  ];
  for (const [name, answerNow] of everyPath) {
    const keys = Object.keys(await answerNow()).join(',');
    check(`same five keys, same order, on the ${name} path`, keys === SHAPE, `got ${keys}`);
  }
}

if (failures.length) {
  console.log(`\nFAIL: ${failures.length} check(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nPASS: the last good answer survives a source that does not');
