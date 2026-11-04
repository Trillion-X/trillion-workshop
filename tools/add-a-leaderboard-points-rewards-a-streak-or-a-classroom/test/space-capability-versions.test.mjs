// A pursuit's capability tools (records/workshop-space-tool-records.json) are granted at the version src/community.mjs
// keeps them at, and every pursuit route checks a grant against the version the Workshop describes (src/person-spaces.mjs
// canonicalSpaceTool). Both are workshopToolVersion over the same row: the raw row and the row as the Workshop admits it
// must give one version, or every capability grant is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readToolData, workshopToolVersion } from '../../keep-and-wake-ai-sessions-on-this-computer/src/workshop.mjs';
import { SPACE_TOOL_ROWS } from '../src/space-capabilities.mjs';
import rows from '../records/workshop-space-tool-records.json' with { type: 'json' };

test('every capability tool has one version, whether read raw or as the Workshop admits it', () => {
  const placements = [...new Set(SPACE_TOOL_ROWS.flatMap(row => row.placements ?? []))].map(id => ({ id }));
  const admitted = new Map(readToolData(rows.records, placements).tools.map(tool => [tool.id, tool]));
  assert.ok(SPACE_TOOL_ROWS.length > 0);
  for (const row of SPACE_TOOL_ROWS) {
    assert.ok(admitted.has(row.id), `${row.id} is admitted by the Workshop`);
    assert.equal(workshopToolVersion(admitted.get(row.id)), workshopToolVersion(row), `${row.id} has one version`);
  }
});
