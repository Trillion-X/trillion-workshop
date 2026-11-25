// tools/ask-questions-sort-answers-follow-up/steps/serve-steps.ts
//
// PURPOSE
//   The one main of every tool that takes one step of a page asked one question at a time (a form page's steps, a booking's steps).
//   A tool's file hands `serveSteps` its steps by name; this runs the one its row names in argv the way tool:mark-a-lesson-done
//   runs its write: the input is the JSON on standard input, the engine mounts the named database's held connection on descriptor 3,
//   and the answer is one line of JSON. The step is given a Store (store.ts) that reads with one statement at a time and writes
//   everything the step changed as one transaction. The whole run shares one database connection (opened once, closed at the
//   end): a connection costs a TLS handshake and its settings, so one per statement made a step take seconds.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A step's writes are one statement (store.ts oneStatementOf): atomic, one round trip, and a part the database refuses keeps
//      nothing of the step.
//   2. A refusal leaves as the step's own plain words on standard error and a failed exit; a database's own words are not passed on.
//   3. This file names no table, no tool and no page; no login is read except the one the engine mounts.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync } from 'node:fs';
import { connectTo, runSql, sayWithout } from '../../run-sql-in-my-database/do-work/run-sql.mjs';
import { sqlStore, type Execute, type Store } from './store.ts';

export type Step = (store: Store, input: any) => Promise<unknown>;

// One client for the whole run, handed to runSql as its `connect`: runSql ends the client it is given after each statement, so
// the one it gets here ends nothing; `close` ends the real one.
export function sharedConnection(connection: string) {
  let opened: Promise<any> | null = null;
  const connect = async (_connection: string, limit: number) => {
    opened ??= connectTo(connection, limit);
    const client = await opened;
    return { query: (...given: unknown[]) => client.query(...given), end: async () => {} };
  };
  const close = async () => { if (opened) await (await opened).end().catch(() => {}); };
  return { connect, close };
}

export async function serveSteps(steps: Record<string, Step>): Promise<void> {
  let connection = '';
  let close = async () => {};
  try {
    const step = steps[process.argv[2] ?? ''];
    if (!step) throw new Error(`No step named ${process.argv[2]}; this file has: ${Object.keys(steps).join(', ')}.`);
    const input = JSON.parse(readFileSync(0, 'utf8'));
    connection = readFileSync(3, 'utf8').trim();
    const shared = sharedConnection(connection);
    close = shared.close;
    const execute: Execute = async (sql, params = []) => (await runSql({ connection, input: { sql, params }, connect: shared.connect })).rows;
    console.log(JSON.stringify(await step(sqlStore({ execute }), input)));
  } catch (error) {
    console.error(sayWithout(error, connection));
    process.exitCode = 1;
  } finally {
    await close();
  }
}
