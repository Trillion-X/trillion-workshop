// Golden: every case of read-data/golden-cases.json, with real bytes and real git merge-file, gives the file and tool
// verdicts the table names, and settles to the same tree ai-command-center's land_paths.merged_tree made of the same three
// trees (recorded in the table's land_paths; README.md says how it was run), except where the table says this tool is
// stricter on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileDigest } from '../../content-identity/read-data/manifest.mjs';
import { classifyTool, type Verdict } from '../read-data/classify.ts';
import { mergeText } from '../read-data/merge-text.ts';

type Texts = Record<string, string>;
type Case = { name: string; base: Texts; project: Texts; upstream: Texts; files: Record<string, Verdict>; tool: string;
  land_paths: 'conflict' | Texts; differs_from_land_paths?: string };
const table = JSON.parse(readFileSync(new URL('../read-data/golden-cases.json', import.meta.url), 'utf8')) as { cases: Case[] };
const bytes = (text: string) => new TextEncoder().encode(text);
const digests = (texts: Texts) => Object.fromEntries(Object.entries(texts).map(([path, text]) => [path, fileDigest(bytes(text))]));

const PROJECT_SIDE = new Set(['same', 'project-only', 'deleted-project', 'renamed-project']);

test('the table has the cases the plan names', () => {
  assert.ok(table.cases.length >= 15);
  const tools = new Set(table.cases.map(c => c.tool));
  for (const state of ['none-changed', 'project-only', 'upstream-only', 'both-clean', 'both-conflict']) assert.ok(tools.has(state), state);
});

for (const c of table.cases) {
  test(`golden: ${c.name}`, () => {
    const merged = new Map<string, string>();
    const classified = classifyTool(digests(c.base), digests(c.project), digests(c.upstream), path => {
      const [b, l, u] = [c.base[path], c.project[path], c.upstream[path]];
      if (b === undefined || l === undefined || u === undefined) return false;
      const merge = mergeText(bytes(l), bytes(b), bytes(u), path);
      if (merge.ok) merged.set(path, new TextDecoder().decode(merge.bytes));
      return merge.ok;
    });
    assert.deepEqual(classified.files, c.files);
    assert.equal(classified.tool, c.tool);
    // The tree this tool settles to: each file from the side its verdict keeps.
    const settled: 'conflict' | Texts = classified.tool === 'both-conflict' ? 'conflict' : Object.fromEntries(Object.entries(classified.files)
      .map(([path, verdict]): [string, string | undefined] => [path, verdict === 'both-clean' ? merged.get(path) : PROJECT_SIDE.has(verdict) ? c.project[path] : c.upstream[path]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined));
    if (c.differs_from_land_paths) {
      assert.notDeepEqual(settled, c.land_paths, 'a case marked as differing must differ');
      assert.equal(settled, 'conflict', 'where this tool differs from land_paths it is stricter: a conflict');
    } else {
      assert.deepEqual(settled, c.land_paths);
    }
  });
}
