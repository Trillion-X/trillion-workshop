// A tool written as a function, the way tools/records-door/do-work/run-an-export.mjs runs one.
export async function countNotes({ prefix }, { door }) {
  let count = 0;
  for await (const record of door.list({ type: 'note', prefix })) count += record.value ? 1 : 0;
  return { count };
}

export async function keepANote({ id, n }, { door }) {
  await door.write([{ id, type: 'note', value: { n } }]);
  return { kept: id, seen: (await door.read('note', id)).n };
}

export const askAnother = ({ n }, { door }) => door.run('tool:made-up-other', { n });

export const echo = input => ({ echoed: input });

export const later = ({ at_ms }) => ({ said: 'later', wake_effects: [{ wake: { at_ms } }] });

export const trashOne = (input, { parentActions }) => parentActions.trashSource(input);
