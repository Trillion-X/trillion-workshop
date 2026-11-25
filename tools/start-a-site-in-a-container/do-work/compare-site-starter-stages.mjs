#!/usr/bin/env node
// tools/start-a-site-in-a-container/do-work/compare-site-starter-stages.mjs
//
// PURPOSE: tool:compare-site-starter-stages. Reads the request on stdin ({ sites: [{ site, dockerfile }] }, each Dockerfile's
// text as its deploy branch holds it) and answers whether every site that fetches this folder's starter fetches it the same
// way: its starter stage is the ARG STARTER_* lines and every line from "FROM ... AS starter" to the next FROM. Each site's
// stage is named by the BLAKE3 of its text; a site with no stage still carries its own starter and is listed as such. same
// is false as soon as two staged sites differ, and a deploy of any of them waits until they match (Nov 25 2026: two sites
// pinned two starter commits within an hour, and only a check outside any owner caught it).
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blake3 } from '@noble/hashes/blake3.js';

/** The starter stage of one Dockerfile's text, or null when it has none. */
export function starterStage(dockerfile) {
  const lines = String(dockerfile).split(/\r?\n/);
  const kept = [];
  let inside = false;
  for (const line of lines) {
    if (/^ARG STARTER_[A-Z0-9_]+=/.test(line)) { kept.push(line); continue; }
    if (/^FROM\s.*\sAS\s+starter\s*$/i.test(line)) inside = true;
    else if (inside && /^FROM\s/i.test(line)) inside = false;
    if (inside) kept.push(line);
  }
  return kept.some(line => /^FROM\s/i.test(line)) ? kept.join('\n') : null;
}

/** The comparison of every site's stage. */
export function compareSiteStarterStages({ sites }) {
  const read = sites.map(({ site, dockerfile }) => {
    const stage = starterStage(dockerfile);
    if (!stage) return { site, stage: null };
    const pin = stage.match(/^ARG STARTER_COMMIT=([0-9a-f]+)/m)?.[1] ?? null;
    return { site, stage: Buffer.from(blake3(Buffer.from(stage))).toString('hex'), starter_commit: pin };
  });
  const stages = [...new Set(read.filter(entry => entry.stage).map(entry => entry.stage))];
  return { same: stages.length <= 1, stages: stages.length, sites: read };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try { process.stdout.write(`${JSON.stringify(compareSiteStarterStages(JSON.parse(readFileSync(0, 'utf8') || '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
}
