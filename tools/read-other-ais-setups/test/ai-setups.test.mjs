// tools/read-other-ais-setups/test/ai-setups.test.mjs
// Read-only listing of the instruction files other AIs keep on this Mac (F-0267, F-0316). Moved from Trillion-X/trillion
// test/ai-setups-import.test.mjs; its second test, the add-only import into saved instructions, is now
// tools/shared-code/test/agents-add-instructions.test.mjs beside the agents owner (src/agents.mjs).
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { readAiSetups, aiSetupSettings } from '../read-data/ai-setups.mjs';

// The Claude app's folder in the made-up home, the same segment ai-setups.json names.
const CLAUDE = '.claude';

async function home() {
  const base = realpathSync(tempFolder(join(tmpdir(), 'ai-setups-')));
  await mkdir(join(base, CLAUDE, 'commands'), { recursive: true });
  await mkdir(join(base, CLAUDE, 'skills', 'triage'), { recursive: true });
  await mkdir(join(base, '.cursor', 'rules'), { recursive: true });
  await writeFile(join(base, CLAUDE, 'CLAUDE.md'), 'Always answer briefly.');
  await writeFile(join(base, CLAUDE, 'commands', 'review.md'), 'Review the diff for bugs.');
  await writeFile(join(base, CLAUDE, 'skills', 'triage', 'SKILL.md'), 'Sort the inbox into three piles.');
  await writeFile(join(base, '.cursor', 'rules', 'style.mdc'), 'x'.repeat(5000));
  return base;
}

test('the listing reads each place read only, cuts long text and names a file the scope refuses', async () => {
  const base = await home();
  const outside = realpathSync(tempFolder(join(tmpdir(), 'ai-setups-outside-')));
  await writeFile(join(outside, 'secret.md'), 'not for this');
  await symlink(join(outside, 'secret.md'), join(base, CLAUDE, 'commands', 'linked.md'));
  const scope = { ...JSON.parse(JSON.stringify((await import('../read-data/file-arguments.mjs')).fileArgumentSettings())), roots: [base] };
  const { items, sources } = await readAiSetups({}, { home: base, scope });
  const by = id => items.find(item => item.id === id);
  assert.equal(by('claude-instructions-claude').text, 'Always answer briefly.');
  assert.equal(by('claude-commands-review').kind, 'command');
  assert.equal(by('claude-skills-triage').kind, 'skill');
  assert.equal(by('cursor-rules-style').cut, true);
  assert.equal(Array.from(by('cursor-rules-style').text).length, aiSetupSettings().most_chars_per_item);
  assert.match(by('claude-commands-linked').unreadable, /outside the folders/);
  assert.deepEqual(sources['codex-prompts'], 0);
  console.log('readback listing:', JSON.stringify(items.map(item => [item.id, item.unreadable ? 'unreadable' : item.text.length])));
});
