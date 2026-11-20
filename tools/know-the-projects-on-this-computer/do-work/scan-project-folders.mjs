// tools/know-the-projects-on-this-computer/do-work/scan-project-folders.mjs
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Scans the folders it is given for project markers and returns one normalized
// record per project folder. This is the port of the retired
// do-work/process-scripts/read-known-projects.py (verify-every-port lane L14,
// capabilities C1 scan and C2 add-one-path). Same markers, same record fields,
// same preview-descriptor reading; the one change is the id: project ids are
// BLAKE3 (content-identity owner), not SHA-256.
//
// It reads the filesystem and writes nothing. Whoever runs it decides what to
// do with the records. Printed as JSON on stdout when run directly:
//   node do-work/scan-project-folders.mjs '{"roots":["~/dev"],"paths":[]}'
// A config that is not JSON is read as one path.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. A folder is a project only when it is a directory holding one marker.
// 2. Roots are scanned one level deep; a root that is itself a project counts.
// 3. Ids come from the content-identity owner (BLAKE3-256 of the resolved path
//    bytes), in the form project:<slug>-<first 24 hex>. Never SHA-256.
// 4. Preview descriptors are read as data. Commands are normalized to argv
//    arrays of strings; anything else is dropped, never run here.
//
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

/** Files or folders whose presence makes a folder a project. */
export const PROJECT_MARKERS = Object.freeze([
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'deno.json',
  'bun.lockb',
  '.git',
  '.claude',
]);

/** The optional per-project descriptor a project may carry to say how to preview it. */
export const PREVIEW_DESCRIPTOR_NAME = '.architect-preview.json';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** The project id: project:<slug of the folder name>-<24 hex of BLAKE3 over the resolved path bytes>. */
export function projectIdFor(resolvedPath) {
  const digest = makeHashCodeHexFromBytes(new TextEncoder().encode(resolvedPath)).slice(3, 27);
  const base = path.basename(resolvedPath).trim().toLowerCase().replace(/ /g, '-');
  const slug = Array.from(base, (ch) => (/[\p{L}\p{N}_-]/u.test(ch) ? ch : '-'))
    .join('')
    .replace(/^-+|-+$/g, '');
  return `project:${slug || 'project'}-${digest}`;
}

/** Reads the scan config. Not JSON means one path; JSON that is not an object means nothing. */
export function readScanConfig(raw) {
  if (!raw) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { paths: [raw] };
  }
  return isPlainObject(value) ? value : {};
}

/** A path string made absolute: ~ expanded, symlinks followed when the path exists. */
export function expandProjectPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let text = value.trim();
  if (text === '~' || text.startsWith('~/')) text = path.join(os.homedir(), text.slice(1));
  const resolved = path.resolve(text);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** True when the folder exists and holds at least one project marker. */
export function isProjectDir(folder) {
  if (!isDirectory(folder)) return false;
  return PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(folder, marker)));
}

/** The project folders the config names: its paths, and each root's own folder and its direct children. */
export function listCandidateProjects(config) {
  const candidates = new Map();
  for (const value of config.paths ?? []) {
    const folder = expandProjectPath(value);
    if (folder && isProjectDir(folder)) candidates.set(folder, folder);
  }
  for (const value of config.roots ?? []) {
    const root = expandProjectPath(value);
    if (!root || !isDirectory(root)) continue;
    if (isProjectDir(root)) candidates.set(root, root);
    let names;
    try {
      names = fs.readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const child = path.join(root, name);
      if (isDirectory(child) && isProjectDir(child)) candidates.set(child, child);
    }
  }
  return [...candidates.keys()].sort();
}

function readPreviewDescriptor(folder) {
  const file = path.join(folder, PREVIEW_DESCRIPTOR_NAME);
  if (!fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

/** A preview command as {argv, cwd, env, timeout_ms?}, or null when its shape is wrong. */
export function normalizePreviewCommand(value, projectFolder) {
  if (!isPlainObject(value)) return null;
  const argv = value.argv;
  if (!Array.isArray(argv) || !argv.every((item) => typeof item === 'string')) return null;

  let cwdFolder = projectFolder;
  if (typeof value.cwd === 'string' && value.cwd.trim()) {
    let text = value.cwd.trim();
    if (text === '~' || text.startsWith('~/')) text = path.join(os.homedir(), text.slice(1));
    cwdFolder = path.isAbsolute(text) ? text : path.join(projectFolder, text);
  }
  const command = {
    argv,
    cwd: expandProjectPath(cwdFolder) ?? path.resolve(cwdFolder),
    env: isPlainObject(value.env) ? value.env : {},
  };
  if (Number.isInteger(value.timeout_ms) && value.timeout_ms > 0) command.timeout_ms = value.timeout_ms;
  return command;
}

function normalizeStatusProbe(value, projectFolder) {
  if (!isPlainObject(value)) return null;
  const command = normalizePreviewCommand(value.command, projectFolder);
  return command ? { kind: 'command', command } : null;
}

/** One project's normalized record. */
export function normalizeProject(folder) {
  const stat = fs.statSync(folder);
  const isGitRepo = fs.existsSync(path.join(folder, '.git'));
  const record = {
    project_id: projectIdFor(folder),
    path: folder,
    name: path.basename(folder),
    source: isGitRepo ? 'git_scan' : 'user_config',
    is_git_repo: isGitRepo,
    has_claude_dir: fs.existsSync(path.join(folder, '.claude')),
    last_activity: new Date(stat.mtimeMs).toISOString(),
  };
  const preview = readPreviewDescriptor(folder);
  if (typeof preview.url === 'string' && preview.url) record.resolved_url = preview.url.trim();
  const command = normalizePreviewCommand(preview.command, folder);
  if (command) record.preview_command = command;
  const statusProbe = normalizeStatusProbe(preview.status_probe, folder);
  if (statusProbe) record.preview_status_probe = statusProbe;
  return record;
}

/** Every project record the config names, sorted by path. */
export function scanProjects(config) {
  return listCandidateProjects(config).map(normalizeProject);
}

/**
 * The add action's check: one path, validated as a project folder.
 * Returns its record, or null when the path is not a project folder.
 */
export function validateOneProjectPath(pathText) {
  return scanProjects({ roots: [], paths: [pathText] })[0] ?? null;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const projects = scanProjects(readScanConfig(process.argv[2]));
  process.stdout.write(`${JSON.stringify({ projects })}\n`);
}
