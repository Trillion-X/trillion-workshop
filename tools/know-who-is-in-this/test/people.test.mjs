// read-data/people.mjs: each person once across their voice and face prints, counts and consent words only, never a
// print's numbers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { people } from '../read-data/people.mjs';

const consent = (kind, said) => ({ kind, said, at: '2026-10-01T00:00:00+00:00' });
const door = {
  async *list({ type }) {
    if (type === 'voice-print') {
      yield { id: 'voice-print:sample-one', value: { person: 'sample-one', name: 'Sample One', me: true, samples: [[1, 0], [0.9, 0.1]], consent: [consent('voice', 'Agreed aloud')] } };
      yield { id: 'voice-print:sample-two', value: { person: 'sample-two', name: 'Sample Two', samples: [[0, 1]], consent: [consent('voice', 'Agreed in writing')] } };
    }
    if (type === 'face-print') yield { id: 'face-print:sample-one', value: { person: 'sample-one', name: 'Sample One', samples: [[0.5, 0.5]], consent: [consent('face', 'Agreed for pictures')] } };
  },
};

test('each person once, with sample counts and consent words, never the numbers', async () => {
  const answer = await people({}, { door });
  assert.deepEqual(answer.people.map(person => [person.name, person.me, person.voice_samples, person.face_samples, person.consent.length]),
    [['Sample One', true, 2, 1, 2], ['Sample Two', false, 1, 0, 1]]);
  assert.doesNotMatch(JSON.stringify(answer), /samples":\[|0\.9/);
});
