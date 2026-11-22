#!/usr/bin/env node
// tools/render-a-workflow-file-from-its-row/read-data/run.mjs
//
// The renderer's entry. It reads one JSON object on stdin and prints one JSON line per row:
//   { rows: [workflow_recipes row, ...], parents: { "<parent id>": definition }, allow_lost: { "<row id>": ["step x"] },
//     mode: "write" | "dry", kit_only: boolean, root: "<trillion-workshop checkout>" }
// A row is read from workflow_recipes by the caller (a SQL reader); this entry only plans and writes files. In write mode each
// ready recipe goes to tools/workflows/recipes/<slug>.json and its kit to tools/workflows/kits/<slug>.json. A row is written only
// when its plan has no problems; gate words are reported, not refused, because the recipe check and the landing gate decide them.
// The origin files (what a render replaces) are read from origin/main in root.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { planRender } from './render.mjs';

function originFile(root, path) {
  try {
    return execFileSync('git', ['show', `origin/main:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

const input = JSON.parse(readFileSync(0, 'utf8'));
const root = input.root;
const writing = input.mode === 'write';
for (const row of input.rows) {
  const parentId = row.recipe.split(':').length === 3 ? row.recipe.split(':').slice(0, 2).join(':') : null;
  const slug = row.recipe.slice('workflow:'.length).replace(/:/g, '_');
  const recipeText = originFile(root, `tools/workflows/recipes/${slug}.json`);
  const kitText = originFile(root, `tools/workflows/kits/${slug}.json`);
  const plan = planRender(row, {
    origin: recipeText ? JSON.parse(recipeText) : null,
    originKit: kitText ? JSON.parse(kitText) : null,
    parent: parentId ? input.parents?.[parentId] : null,
    allowLost: input.allow_lost?.[row.recipe] ?? [],
  });
  const ready = plan.problems.length === 0 && !plan.note;
  const written = { recipe: false, kit: false };
  if (writing && ready && !input.kit_only && plan.recipe) {
    writeFileSync(join(root, 'tools/workflows/recipes', `${slug}.json`), plan.recipe.text);
    written.recipe = true;
  }
  if (writing && ready && plan.kit) {
    writeFileSync(join(root, 'tools/workflows/kits', `${slug}.json`), plan.kit.json);
    written.kit = true;
  }
  console.log(JSON.stringify({
    id: plan.id, slug: plan.slug, kept_at: plan.kept_at, problems: plan.problems, gate_words: plan.gate_words,
    note: plan.note ?? null, see_also: plan.kit?.see_also ?? [], refused: plan.kit?.refused ?? [], dropped: plan.kit?.dropped ?? [],
    written,
  }));
}
