// tools/take-requests/test/source-message-recipes.test.mjs
//
// Proves the two recipes that replace the source-message workflows (read-a-source-message-work and
// decide-a-source-message) on their own example attempts, run from each recipe's prove step text. Each attempt runs on
// PGlite and on a JSON folder: the look step reads the store, the planner (do-work/process-scripts/decide-source-message.py)
// decides, and the keep step writes its batch only when every row is still absent.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const planner = new URL('../do-work/process-scripts/decide-source-message.py', import.meta.url).pathname;
const recipeOf = name => JSON.parse(readFileSync(new URL(`../../workflows/recipes/${name}.json`, import.meta.url))).records[0].payload;
const attemptsOf = recipe => {
  const prove = recipe.steps.find(step => step.id === 'prove');
  const marker = 'Attempts: ';
  return JSON.parse(prove.do.slice(prove.do.indexOf(marker) + marker.length));
};

// The same four operations on each store: read one address, write a batch only where every address is absent, and read
// every address back for the answer. A batch is all or nothing.
async function pgliteStore(seed) {
  const db = new PGlite();
  await db.exec('create table kv (address text primary key, payload jsonb not null)');
  const store = {
    async read(address) {
      const { rows } = await db.query('select payload from kv where address = $1', [address]);
      return rows[0]?.payload ?? null;
    },
    async batch(writes) {
      try {
        await db.transaction(async tx => {
          for (const write of writes) {
            const { rows } = await tx.query('select 1 from kv where address = $1', [write.address]);
            if (rows.length) throw new Error('conflict');
          }
          for (const write of writes) await tx.query('insert into kv (address, payload) values ($1, $2)', [write.address, JSON.stringify(write.payload)]);
        });
        return 'applied';
      } catch (error) {
        if (error.message === 'conflict') return 'conflict';
        throw error;
      }
    },
    async close() { await db.close(); },
  };
  for (const [address, payload] of Object.entries(seed)) await db.query('insert into kv (address, payload) values ($1, $2)', [address, JSON.stringify(payload)]);
  return store;
}

async function folderStore(seed) {
  const dir = tempFolder(join(tmpdir(), 'source-message-folder-'));
  const file = address => join(dir, `${encodeURIComponent(address)}.json`);
  for (const [address, payload] of Object.entries(seed)) writeFileSync(file(address), JSON.stringify(payload));
  return {
    async read(address) {
      return existsSync(file(address)) ? JSON.parse(readFileSync(file(address), 'utf8')) : null;
    },
    async batch(writes) {
      if (writes.some(write => existsSync(file(write.address)))) return 'conflict';
      for (const write of writes) writeFileSync(file(write.address), JSON.stringify(write.payload));
      return 'applied';
    },
    async close() {},
    files: () => readdirSync(dir).length,
  };
}

const backends = [['PGlite', pgliteStore], ['JSON folder', folderStore]];

function plan(request) {
  const work = tempFolder(join(tmpdir(), 'source-message-plan-'));
  const input = join(work, 'request.json');
  const output = join(work, 'plan.json');
  writeFileSync(input, JSON.stringify(request));
  try {
    execFileSync('python3', ['-I', planner, input, output], { stdio: 'pipe' });
  } catch {
    return { refused: true };
  }
  return JSON.parse(readFileSync(output, 'utf8'));
}

const readRecipe = recipeOf('read-a-source-message-work');
const decideRecipe = recipeOf('decide-a-source-message');

for (const [backend, open] of backends) {
  test(`read-a-source-message-work answers its example attempts on ${backend}`, async () => {
    for (const attempt of attemptsOf(readRecipe)) {
      const store = await open(attempt.store_before);
      try {
        const recordRef = attempt.record_ref;
        const answer = {
          request: (await store.read(recordRef)) !== null,
          task: (await store.read(`entity|${recordRef}`)) !== null,
          claim: (await store.read(`${recordRef}:execution-claim`)) !== null,
          session: (await store.read(`${recordRef}:execution-session`)) !== null,
        };
        assert.deepEqual(answer, attempt.expect, attempt.name);
      } finally {
        await store.close();
      }
    }
  });

  test(`decide-a-source-message answers its example attempts on ${backend}`, async () => {
    for (const attempt of attemptsOf(decideRecipe)) {
      const store = await open(attempt.store_before);
      try {
        const recordRef = attempt.candidate.record_ref;
        // look: what is already kept, as the store keeps it
        const existing = {
          existing_request: await store.read(recordRef),
          existing_task: await store.read(`entity|${recordRef}`),
          existing_claim: await store.read(`${recordRef}:execution-claim`),
          existing_session: await store.read(`${recordRef}:execution-session`),
        };
        // decide: the planner, which touches no store
        const decided = plan({ candidate: attempt.candidate, model_result: attempt.model_result, owner_readback: attempt.owner_readback, ...existing });
        if (attempt.race_after_look) {
          for (const [address, payload] of Object.entries(attempt.race_after_look)) await seedOne(store, address, payload);
        }
        // keep: one batch, all or nothing, each row only when absent
        let outcome;
        let rowsKept = 0;
        let taskHanded = false;
        let sessionStarted = false;
        if (decided.refused) {
          outcome = 'refused';
        } else if (decided.disposition_ref === 'disposition:defer') {
          outcome = 'deferred';
        } else {
          const batch = [...decided.writes, ...decided.claim_writes];
          const result = batch.length ? await store.batch(batch.map(write => ({ address: write.address_label, payload: write.payload }))) : 'empty';
          if (result === 'conflict') outcome = 'conflict';
          else if (result === 'empty') outcome = 'unchanged';
          else {
            outcome = 'written';
            rowsKept = batch.length;
            taskHanded = decided.tasks.length > 0;
            sessionStarted = decided.start !== null;
          }
        }
        const answer = { outcome, rows_kept: rowsKept, task_handed: taskHanded, session_started: sessionStarted };
        assert.deepEqual(answer, attempt.expect, attempt.name);
        if (outcome === 'conflict') {
          assert.equal(await store.read(`${recordRef}:execution-claim`), null, `${attempt.name}: the claim is not written after a lost race`);
        }
      } finally {
        await store.close();
      }
    }
  });
}

async function seedOne(store, address, payload) {
  const result = await store.batch([{ address, payload }]);
  assert.equal(result, 'applied', `the racing row ${address} is written`);
}
