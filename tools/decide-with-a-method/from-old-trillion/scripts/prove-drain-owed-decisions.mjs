// Prove harness/drain-owed-decisions.mjs against the live service with a fresh proof account.
//
//   node scripts/prove-drain-owed-decisions.mjs [origin]
//     makes a fresh account with a simulated passkey (its key stays in this process's memory and the account is deleted
//     when the browser closes), writes synthetic owed rows and one synthetic transcript into a folder of its own, and
//     runs the drain twice: the first run posts each owed turn as an owed decision (an older row finds its person's
//     words in the transcript), each posted case is read back with export_decision, and a second run shows a row that
//     names a case still open is never counted as settled. (A decided case settling its rows is proved in
//     test/drain-owed-decisions.test.mjs, since deciding a case takes every question of the method.) Nothing of the person's own owed file is read or sent.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserWithPasskeyDevice, createAccount } from './passkey-account.mjs';
import { drainOnce, readRules } from '../harness/drain-owed-decisions.mjs';
import { settings as deciding, trillionCaller } from '../harness/decide-before-building.mjs';

const origin = process.argv[2] ?? 'https://app.gettrillion.ai';
const root = mkdtempSync(join(tmpdir(), 'prove-drain-'));
const owed = join(root, 'owed.jsonl');
const transcript = join(root, 'session.jsonl');
const rules = { ...readRules(), archive_folder: join(root, 'archive') };
const confirm = { ...deciding.confirm_with, url: `${origin}/mcp` };
const say = line => process.stdout.write(`${line}\n`);

writeFileSync(transcript, `${[
  { type: 'user', timestamp: '2026-10-05T09:00:00.000Z', message: { role: 'user', content: 'Proof: tidy the reading lamp settings' } },
  { type: 'assistant', timestamp: '2026-10-05T09:00:10.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'node scripts/method-checks.mjs outcome smallest_change' } }] } },
].map(row => JSON.stringify(row)).join('\n')}\n`);
const rows = [
  { at: '2026-10-05T09:01:00.000Z', transcript, tool_name: 'Edit', changes: ['/proof/lamp.json'] },
  { at: '2026-10-05T09:02:00.000Z', transcript, tool_name: 'Edit', changes: ['/proof/lamp.md'] },
  { at: '2026-10-05T10:00:00.000Z', transcript: null, tool_name: 'apply_patch', changes: ['/proof/door.mjs'], asked: { text: 'Proof: oil the door hinge', at: '2026-10-05T09:59:00.000Z' }, method_steps: ['outcome', 'proof'], cases: [] },
];
writeFileSync(owed, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

const { browser, page } = await browserWithPasskeyDevice();
let failed = null;
try {
  const key = await createAccount(page, origin);
  say(`fresh proof account made on ${origin}`);
  const first = await drainOnce({ rules, owed, confirm, key, log: say });
  say(`first run: ${JSON.stringify(first)}`);
  const archive = () => readdirSync(rules.archive_folder).flatMap(name => readFileSync(join(rules.archive_folder, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
  const posted = archive().filter(row => row.drained.state === 'posted');
  if (posted.length !== 3) throw new Error(`expected 3 posted rows, archive holds ${JSON.stringify(archive().map(row => row.drained))}`);
  const tool = trillionCaller({ ...confirm, timeout_ms: 60000 }, { key });
  const cases = [...new Set(posted.map(row => row.drained.case_id))];
  say(`owed decisions posted: ${cases.length} (${cases.join(', ')})`);
  for (const caseId of cases) {
    const text = (await tool('export_decision', { case_id: caseId })).text;
    say(`read back ${caseId}: ${text.split('\n').slice(0, 3).join(' | ')}`);
  }
  // A row naming a case that is still open is not settled.
  const lamp = posted.find(row => row.transcript === transcript).drained.case_id;
  const answer = (await tool('next_question', { case_id: lamp })).text;
  say(`next question for ${lamp}: ${answer.slice(0, 160).replace(/\s+/g, ' ')}`);
  writeFileSync(owed, `${JSON.stringify({ at: '2026-10-05T11:00:00.000Z', transcript: null, tool_name: 'Edit', changes: ['/proof/lamp.json'], asked: null, method_steps: [], cases: [lamp] })}\n`);
  const second = await drainOnce({ rules, owed, confirm, key, log: say });
  say(`second run (case not yet decided): ${JSON.stringify(second)}`);
} catch (error) {
  failed = error;
} finally {
  await browser.close().catch(error => say(`cleanup: ${error.message}`));
  rmSync(root, { recursive: true, force: true });
}
if (failed) { process.stderr.write(`${failed.stack ?? failed}\n`); process.exit(1); }
