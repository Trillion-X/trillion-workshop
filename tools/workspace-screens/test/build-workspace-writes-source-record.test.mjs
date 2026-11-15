// scripts/build-workspace.mjs writes the record of what the client was built from beside its input list, and names the folder of the
// repository the client is kept in. Moved from the test of the source record in trillion-apps (test/workspace-source-record.test.mjs
// at b33e1aae^), whose other tests sit in test/workspace-source-record.test.mjs; the Mac app's own check that its carry asks for
// the record stays in trillion-apps.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the build writes the record beside its input list', () => {
  const builder = readFileSync(new URL('../web/scripts/build-workspace.mjs', import.meta.url), 'utf8');
  assert.match(builder, /writeFileSync\(resolve\(out, '\.\.', '\.\.', SOURCE_RECORD_FILE\), JSON\.stringify\(sourceRecord\(\{/);
  assert.match(builder, /prefix: process\.env\.WORKSPACE_SOURCE_PREFIX \?\? ''/);
});
