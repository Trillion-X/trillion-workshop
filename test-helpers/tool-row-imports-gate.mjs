// test-helpers/tool-row-imports-gate.mjs
//
// The push gate's command for tool rows: `node tool-row-imports-gate.mjs <repo> <ref>` walks the tree at `ref` with
// tool-row-imports.mjs and refuses (exit 1, the gaps named) when a row's invoke.files.package_files misses a relative
// import its entry program reaches, or its entry program is not packed. Exit 0 when there are none. Bare imports and
// dangling in-tree imports are reported on stdout but do not refuse yet (their owners are named in the PR that adds them).
import { toolRowFindings, GATE_KINDS } from './tool-row-imports.mjs';

const [repo, ref] = process.argv.slice(2);
if (!repo || !ref) {
  console.error('usage: tool-row-imports-gate.mjs <repo> <ref>');
  process.exit(2);
}
const { results } = toolRowFindings({ repo, ref });
const gaps = results.flatMap(row => (row.findings || [])
  .filter(f => GATE_KINDS.includes(f.kind))
  .map(f => `${row.row_file} ${row.id}: ${f.kind} ${f.spec ?? f.target ?? ''} ${f.needs ?? ''}`.trim()));
if (gaps.length) {
  console.log(`${gaps.length} tool-row package gap(s); add each file to the row's invoke.files.package_files:`);
  for (const gap of gaps.slice(0, 200)) console.log(gap);
  process.exit(1);
}
console.log('every tool row packs what its entry program imports');
