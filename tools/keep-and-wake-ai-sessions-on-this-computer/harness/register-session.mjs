#!/usr/bin/env node
// harness/register-session.mjs
//
// Purpose
//   A SessionStart hook for AI coding harnesses: each session that starts on this computer registers itself, with its
//   own session id, as one this computer hosts (~/.trillion/wake-sessions/hosted.json, read by
//   harness/wake-sessions.mjs), and is published in the person's Trillion as an agent on the stream route. From then
//   on a message sent to it from Trillion (for example from the person's phone) starts that exact session while the
//   helper runs, and the sender is told it is not reachable right now, with the one command to run, while it does not.
//
// Install
//   Claude Code, ~/.claude/settings.json: hooks.SessionStart runs node <this file> --harness claude-code.
//   Codex, ~/.codex/hooks.json: hooks.SessionStart runs node <this file> --harness codex (trusted the same way as
//   record-every-message.mjs: the hash Codex's app server reports for the entry, in ~/.codex/config.toml).
//   The harness id is a row of wake-sessions.json `harnesses`; this file names none.
//
// Non-negotiable invariants
//   1. It never blocks or fails the session: it prints nothing, exits 0, and publishing has a short time box (the
//      helper publishes again when it starts).
//   2. The account key is read from the macOS Keychain by name and sent only in the Authorization header.
//
import { readFileSync } from 'node:fs';
import { keepHookRunOnExit } from './hook-run-receipt.mjs';
import { registerSession, sessionCard, settings } from './wake-sessions.mjs';
import { requireAccountKey } from './account-key.mjs';

const flag = name => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };

try {
  const event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  keepHookRunOnExit(import.meta.url, event);
  const harness = flag('harness');
  const session_id = event.session_id ?? event.sessionId;
  const hosted = registerSession({ harness, session_id, cwd: event.cwd ?? process.cwd() });
  const key = requireAccountKey({ item: settings.keychain_item, timeout: 2000 });
  await fetch(`${settings.origin.replace(/\/$/, '')}/mcp/api/agents/publish`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(sessionCard(hosted)),
    signal: AbortSignal.timeout(3000),
  });
} catch { /* a session is never held up by its registration */ }
process.exit(0);
