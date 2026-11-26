// tools/ask-questions-sort-answers-follow-up/steps/serve-steps.ts
//
// PURPOSE
//   The one main of every tool that takes one step of a page asked one question at a time (a form page's steps, a booking's steps).
//   A tool's file hands `serveSteps` its steps by name; this runs the one its row names in argv the way tool:mark-a-lesson-done
//   runs its write: the input is the JSON on standard input, the engine mounts the named database's held connection on descriptor 3
//   (under a declared use, the database's writer login, and the use ticket on descriptor 5), and the answer is one line of JSON. The
//   step is given a Store (store.ts) that reads with one statement at a time and writes everything the step changed as one
//   statement. The whole run shares one database connection (run-sql.mjs withSqlWrite: opened once, closed at the end): a
//   connection costs a TLS handshake and its settings, so one per statement made a step take seconds. Under a use the run is one
//   transaction that claims the use ticket once at its start, so every read and the write run under that use.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A step's writes are one statement (store.ts oneStatementOf): atomic, one round trip, and a part the database refuses keeps
//      nothing of the step.
//   2. A refusal leaves as the step's own plain words on standard error and a failed exit; a database's own words are not passed on.
//      A refusal that names its own HTTP status (400 to 499: 401 sign in first, 409 a conflict) leaves as one JSON line
//      { "error": <its words>, "status": <its status> }, so the caller answers that very status.
//      A fault of ours names 500 to 599 (sitting.ts refusal) and leaves as plain words, so the door answers 502.
//   3. This file names no table, no tool and no page; no login is read except the one the engine mounts, and no ticket except the one
//      it mounts for a declared use.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync } from 'node:fs';
import { refusalLine, withSqlWrite } from '../../run-sql-in-my-database/do-work/run-sql.mjs';
import { refusal } from './sitting.ts';
import { sqlStore, type Execute, type Store } from './store.ts';

export type Step = (store: Store, input: any) => Promise<unknown>;

export async function serveSteps(steps: Record<string, Step>): Promise<void> {
  let connection = '', ticket = '';
  try {
    const step = steps[process.argv[2] ?? ''];
    if (!step) throw refusal(`No step named ${process.argv[2]}; this file has: ${Object.keys(steps).join(', ')}.`, 500);
    const input = JSON.parse(readFileSync(0, 'utf8'));
    connection = readFileSync(3, 'utf8').trim();
    // An unmounted descriptor may be Node's own queue: descriptor 5 is read only when the input makes the engine mount a ticket.
    if (input?.use !== undefined && input.use !== null && typeof input.database === 'string') ticket = readFileSync(5, 'utf8').trim();
    const answer = await withSqlWrite({ connection, ticket, use: input?.use ?? undefined }, query => {
      const execute: Execute = async (sql, params = []) => (await query(sql, params)).rows;
      return step(sqlStore({ execute }), input);
    });
    console.log(JSON.stringify(answer));
  } catch (error) {
    console.error(refusalLine(error, connection, ticket));
    process.exitCode = 1;
  }
}
