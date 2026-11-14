// Open the runtime instance that belongs to ONE account, and say where it listens.
//
// A workspace is an ordinary single-owner Bitfield app with a principal-derived
// log root and listener. Those addresses identify the account; the launcher
// must separately confine the whole worker so it cannot read a peer's files.
//
// The two decisions live here as pure functions because both are the kind that
// fail silently. A name that collides puts two people in one log, and a ready
// file read optimistically hands out a URL that is either nobody's or somebody
// else's. Each is proven by its own test rather than by the deploy working once.
//
// THERE IS NO WAIT HERE, and that is the design rather than an omission. The
// first draft launched and then polled the ready file until a deadline, which
// is a scheduler hand-rolled inside a request: it holds a visitor's socket open
// for as long as a cold boot takes, it owns a clock that the platform already
// owns, and it turns a slow boot into a timeout the visitor reads as the
// product being broken. This answers what is true NOW in three states and lets
// the front door say so. A workspace that is still opening is a page that says
// it is opening, not a held connection.

import { blake3 } from '@noble/hashes/blake3.js';
import { isAbsolute, relative } from 'node:path';

// Long enough that an ordinary principal survives intact, short enough that the
// resulting directory name stays well inside every filesystem's component limit
// once a prefix and suffix are added.
const READABLE_NAME_LIMIT = 96;
const SAFE_CHARACTER = /^[A-Za-z0-9._-]$/;

/**
 * The on-disk name for one account's workspace.
 *
 * The readable encoding preserves each byte: every byte outside the safe set
 * becomes `~XX`, and `~` is itself outside the safe set. Long refs use a BLAKE3
 * digest to bound the component length. Neither form silently normalizes a ref;
 * a padded ref is refused instead of selecting another account's directory.
 */
export function workspaceNameForPrincipal(principalRef) {
  if (typeof principalRef !== 'string' || !principalRef.trim()) {
    throw new Error('a workspace name needs a principal');
  }
  if (principalRef !== principalRef.trim()) {
    throw new Error('a workspace principal must have no surrounding whitespace');
  }
  const principal = principalRef;
  const encoded = Array.from(new TextEncoder().encode(principal))
    .map((byte) => {
      const character = String.fromCharCode(byte);
      return SAFE_CHARACTER.test(character)
        ? character
        : `~${byte.toString(16).padStart(2, '0')}`;
    })
    .join('');
  if (encoded === '.' || encoded === '..') return '~2e'.repeat(encoded.length);
  if (encoded.length <= READABLE_NAME_LIMIT) return encoded;
  return `~digest~${Buffer.from(blake3(new TextEncoder().encode(principal))).toString('hex')}`;
}

export function workspaceDigestForPrincipal(principalRef) {
  workspaceNameForPrincipal(principalRef);
  return Buffer.from(blake3(new TextEncoder().encode(principalRef))).toString('hex');
}

/**
 * Everything needed to open (or re-open) one account's workspace.
 *
 * `reuseKey` is what makes a second request find the first workspace instead of
 * starting another: the launcher is expected to treat it as an idempotency key,
 * the same way `process-session` already does.
 */
export function workspaceLaunchPlan({ principalRef, workspace }) {
  const readableName = workspaceNameForPrincipal(principalRef);
  const principalDigest = workspaceDigestForPrincipal(principalRef);
  const root = requiredText(workspace?.root_directory, 'workspace.root_directory');
  const rootComponent = workspace?.root_component ?? 'name';
  if (rootComponent !== 'name' && rootComponent !== 'principal_digest') {
    throw new Error('workspace.root_component must be name or principal_digest');
  }
  const name = rootComponent === 'principal_digest' ? principalDigest : readableName;
  const installRoot = `${root}/${name}`;
  // WHERE the ready file lands is the opener's fact, not this server's, and it
  // is required rather than defaulted. The first version computed it here from
  // a guessed layout, which is the failure that hides best: every customer sits
  // on "Opening your workspace" forever while the front door polls a path
  // nothing ever writes, and every check upstream of it stays green. A default
  // would be that same guess wearing a fallback.
  const readyFileTemplate = requiredText(workspace?.ready_file, 'workspace.ready_file');
  const socketTemplate = workspace?.socket_path == null ? null : requiredText(workspace.socket_path, 'workspace.socket_path');
  if (socketTemplate !== null
      && !socketTemplate.includes('{principal_digest}')
      && !socketTemplate.includes('{name}')) {
    throw new Error('workspace.socket_path must contain {name} or {principal_digest}');
  }
  const socketPath = socketTemplate === null ? null
    : fillWorkspacePlaceholders(socketTemplate, { installRoot, name, principalDigest });
  if (socketPath !== null && (!isAbsolute(socketPath)
      || socketPath.includes('{')
      || Buffer.byteLength(socketPath) > 103)) {
    throw new Error('workspace.socket_path must resolve to a complete absolute path');
  }
  if (socketPath !== null) {
    const withinPrivateRoot = relative(root, socketPath);
    if (withinPrivateRoot === ''
        || (withinPrivateRoot !== '..' && !withinPrivateRoot.startsWith('../')
          && !isAbsolute(withinPrivateRoot))) {
      throw new Error('a customer-writable root cannot own the front-door socket');
    }
  }
  return {
    name,
    principalRef,
    reuseKey: `workspace:${name}`,
    // Each account's log has a distinct address. The launcher's whole-worker
    // filesystem boundary must enforce access to only this account's store.
    installRoot,
    principalDigest,
    socketPath,
    readyFilePath: fillWorkspacePlaceholders(readyFileTemplate, { installRoot, name, principalDigest }),
    // Opaque and forwarded whole. Which package set an account gets, and what
    // runs it, are DATA, which is what makes giving one group of customers a
    // different set of packages a row rather than a deploy.
    packageSet: workspace?.package_set ?? null,
    launcher: workspace?.launcher ?? null,
    // Forwarded whole so a launcher argument can name any list this workspace
    // declares. Reading it here by a fixed field name would put every future
    // repeatable argument back in this file.
    workspace: workspace ?? null,
  };
}

/**
 * What the ready file a workspace publishes says about it right now.
 *
 * Returns `{ state: 'ready', shellUrl }`, `{ state: 'ready', socketPath }`,
 * `{ state: 'opening' }`, or
 * `{ state: 'absent' }`. The middle one is the case worth naming: a shell
 * writes this file with `runner_state: "starting"` BEFORE it can answer
 * anything, so a reader that only asked "does the file exist" would hand out a
 * transport nothing is listening on, and a reader that only asked "is it ready"
 * could not tell a booting workspace from one that was never launched, and
 * would launch a second one on every refresh.
 */
export function workspaceStateFromReadyFile(contents) {
  let report = contents;
  if (typeof contents === 'string') {
    try {
      report = JSON.parse(contents);
    } catch {
      // A half-written file is a workspace mid-boot, not a missing one. The
      // shell writes this file atomically, so this is rare rather than
      // impossible, and calling it absent would launch a duplicate.
      return { state: 'opening' };
    }
  }
  if (report === null || report === undefined) return { state: 'absent' };
  if (typeof report !== 'object' || Array.isArray(report)) return { state: 'opening' };
  if (report.status !== 'ready') return { state: 'opening' };
  const attachments = report.attachments;
  if (!attachments || typeof attachments !== 'object' || Array.isArray(attachments)) {
    return { state: 'opening' };
  }
  // A published socket takes priority over a TCP presentation address. The
  // principal-bound plan checks the exact socket path before it is used.
  const socketPath = attachments.forwarding_socket;
  if (typeof socketPath === 'string' && isAbsolute(socketPath) && !socketPath.includes('\0')) {
    return { state: 'ready', socketPath };
  }
  // `http_url` is what a TCP listener publishes; `presentation_entry` is the
  // same value under a second name.
  for (const key of ['http_url', 'presentation_entry']) {
    const value = attachments[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      const url = new URL(value.trim());
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return { state: 'ready', shellUrl: url.origin };
      }
    } catch {
      // A malformed entry is skipped; the next key still gets its own check.
    }
  }
  return { state: 'opening' };
}

/**
 * Answer where this account's workspace listens, launching it if it is not
 * there. Returns `{ shell_url }` or `{ socket_path }` when ready, and `{ opening: true }` when
 * it is not yet, so the caller answers a visitor instead of holding them.
 *
 * `launch` and `readFile` are injected, so this is exercisable with no process
 * and no disk, and so the provider stays DATA.
 */
export async function openTheWorkspaceForOneAccount({
  principalRef,
  workspace,
  launch,
  readFile,
}) {
  const plan = workspaceLaunchPlan({ principalRef, workspace });
  let contents = null;
  try {
    contents = await readFile(plan.readyFilePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const current = workspaceStateFromReadyFile(contents);
  if (current.state === 'ready') {
    if (plan.socketPath) {
      if (current.socketPath !== plan.socketPath) {
        throw new Error('workspace ready socket does not match its principal-bound path');
      }
      return { socket_path: current.socketPath, workspace_name: plan.name };
    }
    if (current.socketPath) throw new Error('workspace published an undeclared socket');
    return { shell_url: current.shellUrl, workspace_name: plan.name };
  }
  if (current.state === 'opening') {
    // Already on its way. Launching again here is what would make a refreshing
    // visitor start a workspace per refresh.
    return { opening: true, workspace_name: plan.name };
  }
  await launch(plan);
  return { opening: true, workspace_name: plan.name };
}

/**
 * The callable owner's identity boundary. A request contributes only header
 * evidence; the installed account-session authority chooses the principal,
 * and the owner chooses both workspace DATA and the confined launch action.
 * Neither a direct caller nor the public front door may select a volume by
 * putting a principal or workspace in the request body.
 */
export async function openTheWorkspaceForVerifiedSession(request, owner) {
  const headers = request?.headers;
  if (!Array.isArray(headers)) throw new Error('session header evidence is required');
  if (typeof owner?.authorizeSession !== 'function'
      || typeof owner?.launchConfined !== 'function'
      || typeof owner?.readFile !== 'function') {
    throw new Error('workspace owner is not fully configured');
  }
  const authority = await owner.authorizeSession({ headers });
  if (authority?.authorized !== true
      || typeof authority.principal_ref !== 'string'
      || !authority.principal_ref.trim()
      || authority.principal_ref !== authority.principal_ref.trim()) {
    throw new Error('session is not authorized for a workspace');
  }
  const opened = await openTheWorkspaceForOneAccount({
    principalRef: authority.principal_ref,
    workspace: owner.workspace,
    launch: owner.launchConfined,
    readFile: owner.readFile,
  });
  return { principal_ref: authority.principal_ref, ...opened };
}

/**
 * Substitution, not a template language: no conditionals, nothing to escape,
 * and an unrecognized `{name}` is left verbatim so a typo surfaces as a path
 * nobody wrote rather than silently becoming an empty segment.
 */
export function fillWorkspacePlaceholders(text, { installRoot, name, principalDigest = '', packageSet = '' }) {
  return String(text)
    .replaceAll('{install_root}', installRoot)
    .replaceAll('{name}', name)
    .replaceAll('{principal_digest}', principalDigest)
    .replaceAll('{package_set}', packageSet ?? '');
}

/**
 * Turn the declared launcher arguments into the exact argv the launcher gets.
 *
 * A plain string is filled and passed through. An object is a list expansion:
 * `{ "for_each": "packages", "flag": "--package" }` emits the flag once per
 * entry of the workspace's `packages` list, which is how a repeatable argument
 * is expressed without encoding a list into one string. The code never knows
 * the word `packages`; it reads whichever list the DATA names, so giving one
 * group of customers a different set of packages, or a different anything
 * else that repeats, is a row rather than a change here.
 *
 * A named list that is absent expands to nothing, because "this group gets no
 * extra packages" is a real answer. A named list that is present but holds a
 * non-string is refused: silently dropping an entry would install a DIFFERENT
 * set of packages than the one that was declared, and nothing downstream could
 * tell.
 */
export function launcherArguments(args, { workspace, fill }) {
  if (!Array.isArray(args)) return [];
  const argv = [];
  for (const arg of args) {
    if (typeof arg === 'string') {
      argv.push(fill(arg));
      continue;
    }
    const listName = typeof arg?.for_each === 'string' ? arg.for_each.trim() : '';
    if (!listName) {
      throw new Error('a launcher argument is neither text nor a for_each expansion');
    }
    const flag = typeof arg?.flag === 'string' ? arg.flag.trim() : '';
    const list = workspace?.[listName];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      throw new Error(`workspace.${listName} is named by a launcher argument but is not a list`);
    }
    for (const entry of list) {
      if (typeof entry !== 'string' || !entry.trim()) {
        throw new Error(`workspace.${listName} holds an entry that is not text`);
      }
      if (flag) argv.push(flag);
      argv.push(fill(entry.trim()));
    }
  }
  return argv;
}

/**
 * The exact environment one account's workspace is started with.
 *
 * It used to be every variable this server holds, copied wholesale, plus the
 * declared ones on top. That is the whole of this server's credentials handed
 * to every customer's process: the payment provider secret, the session
 * signing material, whatever a future deployment adds without thinking about
 * this line. I described these workspaces as unable to leak into each other
 * because they are separate processes in separate directories, and that was
 * true of their FILES and false here, because a credential is not a file.
 *
 * Now a variable reaches a workspace two ways, both of them deliberate: the
 * launcher DATA sets it outright, or it names it in `env_passthrough` and the
 * value comes from this server. Naming it is the act of deciding to share it.
 *
 * `PATH` is passed when nothing declares otherwise, because a launcher started
 * without one cannot find the program it was told to run, and a workspace that
 * silently fails to start is worse than one that shares a search path.
 */
export function environmentForOneWorkspace({ declared, passThrough, parentEnv, fill }) {
  const env = {};
  const names = Array.isArray(passThrough) ? passThrough : ['PATH'];
  for (const name of names) {
    if (typeof name !== 'string' || !name) continue;
    const value = parentEnv?.[name];
    if (typeof value === 'string') env[name] = value;
  }
  for (const [key, value] of Object.entries(declared ?? {})) {
    env[key] = typeof fill === 'function' ? fill(value) : String(value);
  }
  return env;
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim().replace(/\/+$/, '');
}
