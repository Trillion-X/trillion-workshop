// src/record-kind-words.mjs
//
// What sets an automation off, for a kind of record, as the end of a sentence starting 'When ': the kind's own words
// from src/record-kind-words.json, else 'a <kind> is recorded' ('an' before a vowel). Record kinds are an open set;
// a kind nobody wrote words for still reads as a sentence.
import kindWords from './record-kind-words.json' with { type: 'json' };

const plain = kind => String(kind).replace(/[-_]/g, ' ');

export const recordedWords = kind => kindWords.kinds[kind] ?? `${/^[aeiou]/i.test(plain(kind)) ? 'an' : 'a'} ${plain(kind)} is recorded`;
