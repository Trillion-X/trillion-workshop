#!/usr/bin/env node
/**
 * converge-declared-local-tools-to-their-served-version.mjs
 *
 * PURPOSE
 * Bring locally installed tools to the version their own source currently
 * serves, and read the result back from the tool itself instead of trusting the
 * installer's output.
 *
 * WHY THIS EXISTS AS AN OWNER RATHER THAN A TYPED COMMAND
 * A tool pinned at whatever version happened to be installed is the L216 shape:
 * a fact somebody else changes on their own schedule, frozen into a snapshot
 * with a hidden expiry. Nothing on this machine knew that the request proxy was
 * nine releases behind a fix for the exact error it was producing, because
 * nothing owned the question. The one-line upgrade is also refused to an agent,
 * correctly: installing software is an effect, and effects belong to a package.
 *
 * NON-NEGOTIABLE INVARIANTS
 * - This file names no tool, no installer, no package manager and no service.
 *   Every one of those is a DATA row. Adding a tool is a row; adding a whole new
 *   installer road is also a row, because a road IS its argv.
 * - The version is READ BACK by asking the tool after the install. An installer
 *   that prints success while changing nothing is the failure this defends
 *   against, so a readback that goes silent is an error and not a shrug.
 * - Nothing here walks or watches the filesystem. Content discovery belongs to
 *   observed-content (L136); this asks a named program a question.
 * - A row that does not move is reported as already current, never as an error.
 *
 * DATA SHAPE (default ~/.bitfield/declared-local-tools.json, or --tools-file)
 * {
 *   "tools": [{
 *     "id": "<the name you would say out loud>",
 *     "why": "<what breaks when this is stale>",
 *     "program_search_paths": ["~/.local/bin"],             // optional
 *     "version_from": { "argv": ["<program>", "--version"], "capture": "regex with one group" },
 *     "install": { "argv": ["<program>", "<arg>", ...] },
 *     "restart": { "argv": ["<program>", "<arg>", ...] }    // optional
 *   }]
 * }
 *
 * argv[0] is the program's NAME, resolved on the machine that runs it: the
 * row's own `program_search_paths` first, then the PATH. A row never carries a
 * path into somebody's home directory, because that is one machine's fact
 * frozen into bytes everybody gets, and the package compiler refuses it
 * (BRTK3002_LOCAL_PATH_LEAK). Two machine facts may appear in any argument and
 * are filled in here: `~` for the person's home directory and
 * `{current-user-id}` for their numeric user id.
 *
 * USAGE
 *   node converge-declared-local-tools-to-their-served-version.mjs [--tools-file PATH]
 *        [--only <id>] [--dry-run]
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_TOOLS_FILE = path.join(homedir(), ".bitfield", "declared-local-tools.json");

function readArgs(argv) {
  const args = { toolsFile: DEFAULT_TOOLS_FILE, only: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--tools-file") args.toolsFile = argv[++i];
    else if (argv[i] === "--only") args.only = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else {
      process.stderr.write(`unknown argument: ${argv[i]}\n`);
      process.exit(2);
    }
  }
  return args;
}

/**
 * The two facts a declaration is allowed to name without knowing the machine:
 * whose home directory this is, and what their numeric user id is. Both are
 * asked of the running system here rather than typed into a row, because a row
 * that carries either one is one person's machine frozen into shipped bytes.
 * That is not a style preference: the package compiler refuses a home path in
 * compiled output (BRTK3002_LOCAL_PATH_LEAK), and it is right to, because the
 * row would be wrong for every other person and wrong for the same person the
 * day they move the tool.
 */
function fillInMachineFacts(token) {
  if (typeof token !== "string") return token;
  let filled = token;
  if (filled === "~") filled = homedir();
  else if (filled.startsWith("~/")) filled = path.join(homedir(), filled.slice(2));
  const userId = typeof process.getuid === "function" ? String(process.getuid()) : "";
  return filled.split("{current-user-id}").join(userId);
}

/**
 * argv[0] is the program's NAME. If the row said where its tool lives, look
 * there; otherwise hand the bare name to the system and let the PATH answer,
 * which is what a person typing the same command at a prompt would get. A row
 * that already names a path is left alone, so a declaration that genuinely
 * needs one is still possible.
 */
function whereTheProgramIs(name, searchPaths) {
  if (name.includes("/")) return name;
  for (const directory of searchPaths) {
    const candidate = path.join(fillInMachineFacts(directory), name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not there. The next declared directory, or the PATH, may still have it.
    }
  }
  return name;
}

function run(argv, searchPaths = []) {
  const filled = argv.map(fillInMachineFacts);
  const program = whereTheProgramIs(filled[0], searchPaths);
  const result = spawnSync(program, filled.slice(1), { encoding: "utf8" });
  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

/** Ask the tool what it is. The tool is the only thing that actually knows. */
function readVersion(versionFrom, searchPaths) {
  if (!versionFrom || !Array.isArray(versionFrom.argv) || versionFrom.argv.length === 0) return null;
  const asked = run(versionFrom.argv, searchPaths);
  if (!asked.output) return null;
  if (!versionFrom.capture) return asked.output.split("\n")[0].trim();
  const found = new RegExp(versionFrom.capture).exec(asked.output);
  return found && found[1] ? found[1] : null;
}

function lastLines(text, count) {
  return text.split("\n").slice(-count).join("\n");
}

function main() {
  const args = readArgs(process.argv.slice(2));
  if (!existsSync(args.toolsFile)) {
    process.stderr.write(`no declared local tools file at ${args.toolsFile}\n`);
    process.exit(1);
  }
  const declared = JSON.parse(readFileSync(args.toolsFile, "utf8"));
  const rows = Array.isArray(declared.tools) ? declared.tools : [];
  const report = { tools_file: args.toolsFile, dry_run: args.dryRun, tools: [] };
  let failed = 0;

  for (const row of rows) {
    if (args.only && row.id !== args.only) continue;
    const searchPaths = Array.isArray(row.program_search_paths) ? row.program_search_paths : [];
    const entry = { id: row.id ?? null, before: readVersion(row.version_from, searchPaths) };

    if (!row.id || !row.install || !Array.isArray(row.install.argv) || row.install.argv.length === 0) {
      entry.status = "skipped";
      entry.reason = "row declares no id or no install argv";
      report.tools.push(entry);
      continue;
    }
    if (args.dryRun) {
      entry.status = "would_run";
      entry.install = row.install.argv.join(" ");
      report.tools.push(entry);
      continue;
    }

    const installed = run(row.install.argv, searchPaths);
    entry.install_exit = installed.status;
    if (installed.output) entry.install_output = lastLines(installed.output, 6);
    entry.after = readVersion(row.version_from, searchPaths);

    if (!installed.ok) {
      entry.status = "install_failed";
      failed += 1;
    } else if (entry.before && entry.after && entry.before === entry.after) {
      entry.status = "already_current";
    } else if (entry.after) {
      entry.status = "upgraded";
    } else {
      entry.status = "installed_but_version_unreadable";
      failed += 1;
    }

    if (entry.status === "upgraded" && row.restart && Array.isArray(row.restart.argv)) {
      const restarted = run(row.restart.argv, searchPaths);
      entry.restart_exit = restarted.status;
      if (!restarted.ok) {
        entry.status = "upgraded_but_restart_failed";
        if (restarted.output) entry.restart_output = lastLines(restarted.output, 4);
        failed += 1;
      }
    }
    report.tools.push(entry);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
