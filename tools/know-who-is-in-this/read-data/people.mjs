// tools/know-who-is-in-this/read-data/people.mjs
//
// Purpose: `tool:people-listening-can-name`, the people the person's voice and face prints can name, read from their
// voice-print and face-print records through the run's door: each person once, with how many voice and face samples
// they have, whether they are the person, and the consent words they gave. Moved from the product repo's
// computer/know-who.py `people` (its `summary`) and computer/listen.mjs listeningTools.people.
//
// Non-Negotiable Invariants:
//   1. A print's numbers never leave this function: the answer carries counts, names and consent words only.
//   2. One person is one row however many kinds they enrolled, keyed by the print's `person`.
export const PRINT_KINDS = { voice: 'voice-print', face: 'face-print' };

/** One person's summary from the values of their prints: { id, name, me, voice_samples, face_samples, consent }. */
export function summary(id, prints) {
  const of = kind => prints[kind] ?? {};
  return {
    id, name: of('voice').name ?? of('face').name ?? id, me: Boolean(of('voice').me || of('face').me),
    voice_samples: (of('voice').samples ?? []).length, face_samples: (of('face').samples ?? []).length,
    consent: [...(of('voice').consent ?? []), ...(of('face').consent ?? [])],
  };
}

export async function people(_input, { door }) {
  const byPerson = new Map();
  for (const [kind, type] of Object.entries(PRINT_KINDS)) {
    for await (const row of door.list({ type })) {
      const value = row.value ?? {};
      const id = value.person ?? String(row.id ?? '').split(':').pop();
      byPerson.set(id, { ...byPerson.get(id), [kind]: value });
    }
  }
  return { people: [...byPerson].map(([id, prints]) => summary(id, prints)).sort((a, b) => a.name.localeCompare(b.name)) };
}
