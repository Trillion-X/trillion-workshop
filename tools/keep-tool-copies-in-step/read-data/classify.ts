// tools/keep-tool-copies-in-step/read-data/classify.ts
//
// PURPOSE
//   The sync algebra, and nothing else: for one tool copy, given three maps of file path -> BLAKE3 (the base the record
//   names, the project's folder now, the upstream folder at its newest commit), the verdict of every file and of the tool.
//   It reads no file, runs no program and fetches nothing; do-work/sync.ts gives it the maps and, for a file changed on
//   both sides, whether git merged it cleanly.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Per file (b = base, l = project, u = upstream; null = absent), the order is fixed:
//      l == u -> same; u == b -> project-only (deleted-project when l is absent); l == b -> upstream-only (deleted-upstream
//      when u is absent); otherwise, any of the three absent -> conflict; all three present and different -> needs-merge.
//      It is land_paths.py merged_tree's per-file decision (ai-command-center, land_paths.py in its hook library, lines 255-270),
//      restated here and held equal to it by test/golden.test.ts, never imported.
//   2. A rename is only reported, never guessed into a merge: a path gone on one side whose exact bytes arrived at one new
//      path on the same side, the other side touching neither, is renamed-<side> on both paths. The same base file renamed
//      to two different paths, one on each side, is both-conflict on all three paths.
//   3. A needs-merge file is both-clean only when `mergedClean(path)` says git merged it cleanly; without that answer it is
//      both-conflict (refuse rather than guess).
//   4. The tool's verdict is the strongest over its files: both-conflict > both-clean > project-only > upstream-only >
//      none-changed. Changes on both sides of different files are both-clean (each side gets the other's).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import type { Hex64 } from '../../add-a-tool-to-a-project/read-data/registry.ts';
import type { FileMap } from '../../add-a-tool-to-a-project/read-data/fetch-folder.ts';

export type Verdict = 'same' | 'project-only' | 'upstream-only' | 'both-clean' | 'both-conflict' | 'deleted-project'
  | 'deleted-upstream' | 'renamed-project' | 'renamed-upstream';
export type FileVerdict = Exclude<Verdict, 'both-clean' | 'renamed-project' | 'renamed-upstream' | 'both-conflict'> | 'needs-merge' | 'conflict';
export type ToolVerdict = 'none-changed' | 'project-only' | 'upstream-only' | 'both-clean' | 'both-conflict';
export type Rename = { from: string; to: string; side: 'project' | 'upstream' };
export type Classified = { files: Record<string, Verdict>; renames: Rename[]; tool: ToolVerdict };

/** One file's verdict from its three hashes (invariant 1). */
export function classifyFile(b: Hex64 | null, l: Hex64 | null, u: Hex64 | null): FileVerdict {
  if (l === u) return 'same';
  if (u === b) return l === null ? 'deleted-project' : 'project-only';
  if (l === b) return u === null ? 'deleted-upstream' : 'upstream-only';
  if (b === null || l === null || u === null) return 'conflict';
  return 'needs-merge';
}

const PROJECT_SIDE: ReadonlySet<Verdict> = new Set(['project-only', 'deleted-project', 'renamed-project']);
const UPSTREAM_SIDE: ReadonlySet<Verdict> = new Set(['upstream-only', 'deleted-upstream', 'renamed-upstream']);

/** The paths a side moved: each path gone on that side matched to the one path that arrived there holding its bytes. */
function renamesOn(side: 'project' | 'upstream', base: FileMap, sideMap: FileMap, first: Map<string, FileVerdict>): Rename[] {
  const gone = side === 'project' ? 'deleted-project' : 'deleted-upstream';
  const arrived = side === 'project' ? 'project-only' : 'upstream-only';
  const newPaths = [...first].filter(([path, verdict]) => verdict === arrived && base[path] === undefined).map(([path]) => path);
  const found: Rename[] = [];
  for (const [path, verdict] of first) {
    if (verdict !== gone) continue;
    const to = newPaths.filter(candidate => sideMap[candidate] === base[path]);
    if (to.length === 1) found.push({ from: path, to: to[0], side });
  }
  // A new path claimed by two gone paths (two identical files, one moved) names neither: the moves stay plain edits.
  return found.filter(rename => found.filter(other => other.to === rename.to).length === 1);
}

/** The base files both sides deleted, each moved to a different new path, one on each side (invariant 2). */
function splitRenames(base: FileMap, project: FileMap, upstream: FileMap, first: Map<string, FileVerdict>): string[][] {
  const split: string[][] = [];
  for (const [path, verdict] of first) {
    if (verdict !== 'same' || base[path] === undefined || project[path] !== undefined) continue;
    const toProject = [...first].filter(([p, v]) => v === 'project-only' && base[p] === undefined && project[p] === base[path]).map(([p]) => p);
    const toUpstream = [...first].filter(([p, v]) => v === 'upstream-only' && base[p] === undefined && upstream[p] === base[path]).map(([p]) => p);
    if (toProject.length === 1 && toUpstream.length === 1) split.push([path, toProject[0], toUpstream[0]]);
  }
  return split;
}

/** Every file's verdict, the renames and the tool's verdict (invariants 2 to 4). */
export function classifyTool(base: FileMap, project: FileMap, upstream: FileMap, mergedClean: (path: string) => boolean = () => false): Classified {
  const paths = [...new Set([...Object.keys(base), ...Object.keys(project), ...Object.keys(upstream)])]
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const first = new Map(paths.map(path => [path, classifyFile(base[path] ?? null, project[path] ?? null, upstream[path] ?? null)]));
  const files: Record<string, Verdict> = {};
  for (const [path, verdict] of first) {
    files[path] = verdict === 'needs-merge' ? (mergedClean(path) ? 'both-clean' : 'both-conflict') : verdict === 'conflict' ? 'both-conflict' : verdict;
  }
  const renames = [...renamesOn('project', base, project, first), ...renamesOn('upstream', base, upstream, first)];
  for (const rename of renames) files[rename.from] = files[rename.to] = rename.side === 'project' ? 'renamed-project' : 'renamed-upstream';
  for (const group of splitRenames(base, project, upstream, first)) for (const path of group) files[path] = 'both-conflict';

  const verdicts = Object.values(files);
  const projectSide = verdicts.some(v => PROJECT_SIDE.has(v));
  const upstreamSide = verdicts.some(v => UPSTREAM_SIDE.has(v));
  let tool: ToolVerdict;
  if (verdicts.includes('both-conflict')) tool = 'both-conflict';
  else if (verdicts.includes('both-clean') || (projectSide && upstreamSide)) tool = 'both-clean';
  else if (projectSide) tool = 'project-only';
  else if (upstreamSide) tool = 'upstream-only';
  // Every file the same on both sides, yet the base differs (both sides made the same change): the record advances, no file moves.
  else tool = paths.every(path => base[path] === project[path]) ? 'none-changed' : 'upstream-only';
  return { files, renames, tool };
}
