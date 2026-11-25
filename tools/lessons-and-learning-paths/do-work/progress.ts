// tools/lessons-and-learning-paths/do-work/progress.ts
//
// PURPOSE
//   The learner's done lessons: one read (`readDone`) and the one write (`saveDone`) of this tool. The person is named by
//   the trusted caller (the page's own sign-in or the member's pass); a browser or an AI's arguments never choose whose
//   marks are read or written.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A lesson is marked done once: saving a lesson already marked done adds no row and answers the same done mark.
//   2. The write is one INSERT of three values and a time; table and column names are SOURCE's (courses.ts), the values are
//      statement parameters, and the lesson must be one of the course's own lessons or nothing is written.
//   3. The write runs as the database login the engine mounts for the named database; this file opens no other login.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sayWithout } from '../../run-sql-in-my-database/do-work/run-sql.mjs';
import type { Reader, Rows } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';
import { SOURCE, tablesOf, type Tables } from './courses.ts';

type Given = { database: string; person: string; course: string; tables?: Partial<Tables> };
export type DoneAnswer = { course: string; done: string[] };
export type SavedAnswer = { course: string; lesson: string; done: true; saved: boolean };

const quote = (name: string) => `"${name}"`;
const needPerson = (person: unknown) => {
  if (typeof person !== 'string' || person === '') throw new Error('Give person: the signed-in learner the trusted caller names.');
};

export const readDone: Reader<Given, DoneAnswer> = async (input, rows) => {
  needPerson(input.person);
  const tables = tablesOf(input.tables);
  const present = await rows('select to_regclass($1) is not null as present', [quote(tables.done)]);
  if (present[0]?.present !== true) return { course: input.course, done: [] };
  const { done } = SOURCE;
  const found = await rows(`select ${quote(done.lesson)} as lesson from ${quote(tables.done)} where ${quote(done.person)} = $1 and ${quote(done.course)} = $2 order by ${quote(done.at)}`, [input.person, input.course]);
  return { course: input.course, done: found.map(row => String(row.lesson)) };
};

// `execute` answers the rows of one statement; the engine's mounted connection is behind it when this file is run.
export async function saveDone(input: Given & { lesson: string }, execute: Rows): Promise<SavedAnswer> {
  needPerson(input.person);
  const tables = tablesOf(input.tables);
  const { done, lessons } = SOURCE;
  const own = await execute(`select 1 as found from ${quote(tables.lessons)} where ${quote(lessons.course)} = $1 and ${quote(lessons.id)} = $2`, [input.course, input.lesson]);
  if (own.length === 0) throw new Error(`There is no lesson ${input.lesson} in course ${input.course}; nothing was saved.`);
  const added = await execute(
    `insert into ${quote(tables.done)} (${quote(done.person)}, ${quote(done.course)}, ${quote(done.lesson)}, ${quote(done.at)}) select $1, $2, $3, now() where not exists (select 1 from ${quote(tables.done)} where ${quote(done.person)} = $1 and ${quote(done.course)} = $2 and ${quote(done.lesson)} = $3) returning 1 as added`,
    [input.person, input.course, input.lesson]);
  return { course: input.course, lesson: input.lesson, done: true, saved: added.length > 0 };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const { runSql } = await import('../../run-sql-in-my-database/do-work/run-sql.mjs');
  const { serveARead } = await import('../../run-sql-in-my-database/do-work/serve-a-read.ts');
  if (process.argv[2] === 'saveDone') {
    let connection = '';
    try {
      const input = JSON.parse(readFileSync(0, 'utf8')) as Given & { lesson: string };
      connection = readFileSync(3, 'utf8').trim();
      const execute: Rows = async (sql, params = []) => (await runSql({ connection, input: { sql, params } })).rows;
      console.log(JSON.stringify(await saveDone(input, execute)));
    } catch (error) {
      console.error(sayWithout(error, connection));
      process.exitCode = 1;
    }
  } else {
    await serveARead({ readDone });
  }
}
