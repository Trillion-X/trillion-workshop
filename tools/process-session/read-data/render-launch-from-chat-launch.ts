// packages/process-session/read-data/render-launch-from-chat-launch.ts
//
// PURE, generic renderer: a CLI's self-describing `chat_launch` descriptor + a
// caller context ({prompt, model, resume, …}) → a finished
// `ProcessSessionLaunchDescriptor` ready for `startProcessSession`, PLUS the
// launch's `stream_parse_spec` (so the live tailer can extract assistant text
// from raw JSONL). Returns `null` when the launch is NOT a live-session launch
// (`transport !== 'process_session'`) — the caller then falls back to its
// one-shot path. Zero I/O, zero Society vocabulary: it never names an agent, a
// model, a flag, or a CLI. The argv is DATA the CLI ships; this renderer only
// substitutes the caller's context into it.
//
// This is the browser-side twin of the Python request-builder's
// `render_argument` / `render_argv_and_cwd` / `build_process_session_descriptor`
// (ai-records-producer/do-work/process-scripts/make-ai-records-command-request.py).
// Kept as ONE renderer so a live session and a one-shot invocation of the SAME
// CLI produce identical argv (L043 — no whack-a-mole across transport builders).
// It exists here (not in documents) so composition/chat/group stay
// BLIND consumers that never hand-roll a launch (no-god-package).

import {
  renderProcessSessionLaunchDescriptor,
  type EnvBinding,
  type ProcessInputMount,
  type ProcessSessionLaunchDescriptor,
} from './read-process-session-launch';

export type ProcessSessionRenderedDescriptor = ProcessSessionLaunchDescriptor;

export interface RenderedLaunch {
  readonly descriptor: ProcessSessionRenderedDescriptor;
  /** The raw `stream_parse_spec` from the chat_launch (locates assistant text in
   *  raw JSONL stdout); undefined ⇒ raw stdout already is the text. Passed opaque
   *  to `readProcessSessionStreamHandle` to build the tail handle's `textSpec`. */
  readonly streamParseSpec?: unknown;
}

/** Caller context substituted into the argv. `prompt`/`model` are the common
 *  keys; any other key a launch's `{value:"…", when:"…"}` references is honored
 *  (L090 open-key) — pass through whatever the caller sends. `resume` is the one
 *  structural boolean the `when:"new"|"resume"` conditions read. */
export type LaunchContext = Record<string, string | boolean | undefined> & {
  prompt?: string;
  model?: string;
  resume?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `when` is an OPEN context-key condition (L090): `new`/`resume` gate on the
 *  structural resume-ness boolean; ANY other value gates on the truthiness of
 *  that context key — so a launch can declare `when:"model"` (drop the flag when
 *  no model was chosen) with zero code here. */
function shouldUseArgument(arg: Record<string, unknown>, ctx: LaunchContext): boolean {
  const condition = arg.when;
  if (condition === undefined || condition === null) return true;
  if (condition === 'new') return !ctx.resume;
  if (condition === 'resume') return !!ctx.resume;
  return typeof condition === 'string' ? Boolean(ctx[condition]) : true;
}

/** Render one argv entry. String → itself. Object → `{literal}` verbatim (gated
 *  by `when`), or `{value:key}` → `ctx[key]`. A value that is absent drops the
 *  entry when `optional:true` (a bare `--flag`), else keeps an EMPTY STRING so a
 *  positional slot is preserved — dropping it would shift every later positional
 *  (the exact bug that IndexErrored a `python3 -c` launch when `model` was absent). */
function renderArgument(arg: unknown, ctx: LaunchContext): string | null {
  if (typeof arg === 'string') return arg;
  if (!isRecord(arg) || !shouldUseArgument(arg, ctx)) return null;
  const literal = asString(arg.literal);
  if (literal !== null) return literal;
  const valueKey = asString(arg.value);
  const value = valueKey ? ctx[valueKey] : undefined;
  if (typeof value === 'string' && value.length > 0) return value;
  return arg.optional === true ? null : '';
}

/** Resolve cwd the same way the Python builder does. The shared canonical
 * renderer then rejects an absolute or traversing result before it enters the
 * process-session wire. */
function renderCwd(chatLaunch: Record<string, unknown>, ctx: LaunchContext): string {
  const cwd = chatLaunch.cwd;
  if (cwd === 'projectPath') {
    const p = typeof ctx.projectPath === 'string' ? ctx.projectPath : '';
    return p || '.';
  }
  return asString(cwd) ?? '.';
}

/** Only explicitly inert literals may enter the exact environment. Unresolved
 * account or credential bindings fail closed; the process owner never inherits
 * ambient environment and this renderer never drops authority-bearing fields. */
function renderEnv(chatLaunch: Record<string, unknown>): EnvBinding[] {
  const env: EnvBinding[] = [];
  const bindings = chatLaunch.env;
  if (!Array.isArray(bindings)) return env;
  for (const binding of bindings) {
    if (!isRecord(binding)) throw new Error('Process-session env binding must be an object');
    const name = asString(binding.name);
    const value = asString(binding.value);
    if (!name || value === null || binding.kind !== 'literal' || binding.inert !== true) {
      throw new Error('Browser process-session env must be an explicitly inert literal');
    }
    env.push({ kind: 'literal', name, value, inert: true });
  }
  return env;
}

function renderInputs(value: unknown): ProcessInputMount[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Process-session inputs must be an array');
  return value.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry.source) || typeof entry.mount_path !== 'string') {
      throw new Error('Process-session input must have mount_path and source');
    }
    const source = entry.source;
    if (source.kind === 'inline' && typeof source.bytes === 'string') {
      return {
        mount_path: entry.mount_path,
        source: { kind: 'inline' as const, bytes: source.bytes },
        ...(typeof entry.content_type === 'string' ? { content_type: entry.content_type } : {}),
        ...(entry.executable === true ? { executable: true } : {}),
      };
    }
    if (source.kind === 'blob_ref' && typeof source.hash === 'string') {
      return {
        mount_path: entry.mount_path,
        source: { kind: 'blob_ref' as const, hash: source.hash },
        ...(typeof entry.content_type === 'string' ? { content_type: entry.content_type } : {}),
        ...(entry.executable === true ? { executable: true } : {}),
      };
    }
    throw new Error('Process-session input source must be inline base64 or blob_ref');
  });
}

/** Render a live-session launch descriptor from a self-describing `chat_launch`,
 *  or `null` when the launch is not `transport:"process_session"`. */
export function renderLaunchFromChatLaunch(chatLaunch: unknown, ctx: LaunchContext): RenderedLaunch | null {
  if (!isRecord(chatLaunch)) return null;
  if (asString(chatLaunch.transport) !== 'process_session') return null;

  const argvSource = chatLaunch.argv;
  if (!Array.isArray(argvSource)) return null;
  const argv = argvSource
    .map((entry) => renderArgument(entry, ctx))
    .filter((entry): entry is string => entry !== null);
  if (argv.length === 0) return null;

  const timeoutRaw = chatLaunch.session_timeout_ms;
  const timeoutMs = typeof timeoutRaw === 'number' && Number.isSafeInteger(timeoutRaw) && timeoutRaw > 0
    ? timeoutRaw : 300000;
  const env = renderEnv(chatLaunch);
  const grid = chatLaunch.session_text_grid;
  const sessionSettings = isRecord(grid) && typeof grid.columns === 'number' && typeof grid.rows === 'number'
    ? { text_grid: { columns: grid.columns, rows: grid.rows } }
    : { text_grid: null };

  const descriptor = renderProcessSessionLaunchDescriptor({
    argv,
    cwd: { kind: 'literal', value: renderCwd(chatLaunch, ctx), inert: true },
    env,
    timeoutMs,
    inputs: renderInputs(chatLaunch.inputs),
    sessionSettings,
  });

  const streamParseSpec = isRecord(chatLaunch.stream_parse_spec) ? chatLaunch.stream_parse_spec : undefined;
  return streamParseSpec ? { descriptor, streamParseSpec } : { descriptor };
}
