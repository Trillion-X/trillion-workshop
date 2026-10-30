// A tool written as a function, the way tools/records-door/do-work/run-an-export.mjs runs one.
export async function countNotes({ prefix }, { door }) {
  let count = 0;
  for await (const record of door.list({ type: 'note', prefix })) count += record.value ? 1 : 0;
  return { count };
}

export const echo = input => ({ echoed: input });
