// Which runtime instance answers THIS request.
//
// The shell this server proxies to is a single-owner runtime: whoever reaches it
// is the owner. Its partition is a process-wide environment value and its
// `/target/*` gate is one shared token, so one shell cannot tell two customers
// apart and must never be handed two customers' requests.
//
// So a host that serves signed-in people resolves a DIFFERENT upstream per
// account. Two kinds of instance exist, and the split is the whole design:
//
//   directory  one instance, shared, owns sign-in and accounts ONLY. A request
//              that is trying to BECOME somebody has to reach something, and it
//              cannot be the asker's own instance because there is no asker yet.
//   workspace  one instance per account, owns that person's work. Reached only
//              after the directory has proved who is asking.
//
// This module decides. It opens no socket, starts no process, and names no
// provider: the caller injects `verifySession` and `startWorkspace`, so the same
// decision runs under a test with two fake instances and under a deploy with
// real ones. A host that declares no binding gets `null` and the caller keeps
// its existing single-upstream behaviour unchanged.

import { isAbsolute, relative } from 'node:path';
import {
  fillWorkspacePlaceholders,
  workspaceDigestForPrincipal,
  workspaceNameForPrincipal,
} from './open-the-workspace-for-one-account.mjs';

// The instance's own program and boot catalog. Every visitor gets the same
// bytes and neither holds anybody's work, so both can be answered before a
// visitor has said who they are. They are named here rather
// than in a deploy's own list because they are not a property of any one
// application: they are how this kind of instance is built, and a deploy that
// had to know them could forget them, which is a sign-in page that cannot load
// its own code.
// `/target/` is deliberately NOT here. That is where a person's work is read and
// changed, and it is the one thing this whole split exists to keep behind a
// session. An application names the few `/target/` routes that sign-in itself
// needs, and only those.
const SHELL_PROGRAM_ROUTE_PREFIXES = [
  '/src/',        // the program the page runs
  // A prefix here stops at a path segment, on purpose, so that naming one route
  // cannot quietly open a neighbour. `/boot` and `/boot-phase` are two routes
  // and both have to be said.
  '/boot',        // what the instance says it can do
  '/boot-phase',  // how far along it is
];

/** Normalize a page description's per-account runtime binding. Fail closed. */
export function readPerAccountRuntime(description) {
  const raw = description?.per_account_runtime;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const directoryShellUrl = trimmedText(raw.directory_shell_url);
  const signInRoute = trimmedText(raw.sign_in_route);
  // Both are required. A binding with no directory has nowhere to verify a
  // session, and one with no sign-in route has nowhere to send a visitor who
  // has none; either way the only remaining answer would be somebody's
  // instance, which is the one answer that must never be a default.
  if (!directoryShellUrl || !signInRoute) return null;
  const directoryRoutePrefixes = textList(raw.directory_route_prefixes);
  // The sign-in route itself is always a directory route. Requiring the deploy
  // to also list it under the prefixes would make a working binding depend on
  // saying the same thing twice, and the version that forgets is a redirect
  // loop: sign-in resolves to a workspace, which has no session, which
  // redirects to sign-in.
  if (!directoryRoutePrefixes.some((prefix) => routeHasPrefix(signInRoute, prefix))) {
    directoryRoutePrefixes.push(signInRoute);
  }
  // AND SO IS EVERYTHING THAT PAGE LOADS, for exactly the reason above taken one
  // step further. Serving the sign-in page from the directory and then sending
  // its own program somewhere else means the browser asks for a script and is
  // handed the sign-in page instead, because a visitor with no session gets
  // redirected whatever they asked for. The browser then reports that a module
  // is missing an export, which is true: it loaded a web page and looked for a
  // program in it. Nobody reading that message would arrive here.
  //
  // These are the instance's own program and boot catalog. The current app scene
  // is deliberately excluded: it can contain customer data and belongs behind a
  // verified session until a distinct public sign-in scene exists.
  for (const prefix of SHELL_PROGRAM_ROUTE_PREFIXES) {
    if (!directoryRoutePrefixes.some((existing) => routeHasPrefix(prefix, existing))) {
      directoryRoutePrefixes.push(prefix);
    }
  }
  return {
    directoryShellUrl,
    signInRoute,
    directoryRoutePrefixes,
    publicDirectoryTargets: textList(raw.public_directory_targets)
      .filter((target) => /^\/target\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target)),
    // Opaque to this module. Handed to `startWorkspace` verbatim.
    workspace: raw.workspace && typeof raw.workspace === 'object' && !Array.isArray(raw.workspace)
      ? raw.workspace
      : {},
  };
}

/** A request for the page at this route, rather than for something the page
 *  loads. A page is fetched with GET and at the route exactly; the scripts and
 *  data beneath it are neither, which is what keeps this from swallowing them. */
export function isPageRequestFor(route, method, pathname) {
  if (typeof route !== 'string' || !route) return false;
  if (typeof method === 'string' && method.toUpperCase() !== 'GET') return false;
  const path = typeof pathname === 'string' ? pathname.split('?')[0] : '';
  return path === route;
}

/** Does this path belong to the shared directory instance? */
export function isDirectoryRoute(binding, pathname) {
  const path = typeof pathname === 'string' && pathname ? pathname : '/';
  return binding.directoryRoutePrefixes.some((prefix) => routeHasPrefix(path, prefix));
}

/**
 * Decide which upstream answers this request.
 *
 * Returns exactly one of:
 *   { kind: 'directory', shellUrl }
 *   { kind: 'workspace',  shellUrl | socketPath, principalRef }
 *   { kind: 'opening' }
 *   { kind: 'sign-in',   location }
 *   { kind: 'refuse',    reason }
 *
 * `verifySession` receives the request's own header evidence and returns the
 * canonical principal, or nothing. The principal is NEVER read from the request
 * itself: a header or body a browser controls is a claim, and the only thing
 * that turns a claim into an identity here is the directory's reply.
 */
export async function resolveRuntimeInstance({
  binding,
  method,
  pathname,
  headers,
  verifySession,
  startWorkspace,
}) {
  if (!binding) return null;

  // The public sign-in page must open without waiting for the directory. A
  // redirect for someone already signed in is optional, and asking the
  // directory to decide it can hang the only recovery page during an outage.
  // The public-entry server paints the sign-in island for this exact route;
  // the directory never serves a shared workspace here.
  if (isPageRequestFor(binding.signInRoute, method, pathname)) {
    return { kind: 'directory', shellUrl: binding.directoryShellUrl };
  }

  // The browser must learn the command basis of the same worker that answers
  // its private targets. An authenticated /boot is therefore account-scoped;
  // the public sign-in island has its own explicit directory boot request.
  const accountBoot = pathname === '/boot';
  if (isDirectoryRoute(binding, pathname) && !accountBoot) {
    // The directory owns account routes, but owning a route does not make it
    // public. A family prefix can contain private read/write targets. Only an
    // exact DATA-named sign-in action is callable before session verification.
    if (pathname.startsWith('/target/') && !binding.publicDirectoryTargets.includes(pathname)) {
      let principalRef = null;
      try {
        principalRef = trimmedText((await verifySession({ headers, method, pathname }))?.principal_ref);
      } catch (error) {
        return { kind: 'refuse', reason: `could not verify the session: ${errorText(error)}` };
      }
      if (!principalRef) return { kind: 'sign-in-required' };
    }
    return { kind: 'directory', shellUrl: binding.directoryShellUrl };
  }
  let principalRef = null;
  try {
    principalRef = trimmedText((await verifySession({ headers, method, pathname }))?.principal_ref);
  } catch (error) {
    // A directory that is down is not a visitor without a session. Answering
    // the first with the sign-in page would silently sign everybody out during
    // a restart, and answering it with an instance is unthinkable.
    return { kind: 'refuse', reason: `could not verify the session: ${errorText(error)}` };
  }

  if (!principalRef) {
    if (accountBoot) return { kind: 'directory', shellUrl: binding.directoryShellUrl };
    // No session, or a session the directory does not accept. Both mean the
    // same thing here and neither is an error: this visitor is not signed in.
    if (typeof pathname === 'string' && (
      pathname.startsWith('/target/')
      || pathname === '/entry-scene'
      || pathname === '/ws'
      || pathname === '/namespace' || pathname.startsWith('/namespace/')
      || pathname.startsWith('/guarded-object/')
      || pathname.startsWith('/byte-address/')
      || pathname === '/byte-address-have'
      || pathname.startsWith('/cas/')
    )) {
      return { kind: 'sign-in-required' };
    }
    return { kind: 'sign-in', location: binding.signInRoute };
  }

  let opened = null;
  try {
    opened = await startWorkspace({ principalRef, workspace: binding.workspace, headers });
  } catch (error) {
    return { kind: 'refuse', reason: `could not open this account's workspace: ${errorText(error)}` };
  }
  const shellUrl = trimmedText(opened?.shell_url);
  const socketPath = trimmedText(opened?.socket_path);
  if (!shellUrl && !socketPath && opened?.opening === true) {
    // Launched and still booting. Distinct from a refusal on purpose: nothing
    // is wrong, the person simply has to be told to come back in a moment
    // rather than have their connection held open for a cold boot.
    return { kind: 'opening' };
  }
  // A starter that answers with nothing has not opened anything. Falling back
  // to the directory, or to a configured shell, would hand this person another
  // instance, which is the exact leak this module exists to make impossible.
  if (!shellUrl && !socketPath) {
    return { kind: 'refuse', reason: "this account's workspace is not open" };
  }
  if (shellUrl === binding.directoryShellUrl) {
    // The directory holds accounts. A workspace resolving to it would put one
    // person's work in the instance every other person is allowed to reach.
    return { kind: 'refuse', reason: "a workspace may not resolve to the directory instance" };
  }
  return { kind: 'workspace', ...(socketPath ? { socketPath } : { shellUrl }), principalRef };
}

/**
 * The two injected answers, asked of the DIRECTORY instance through its own
 * declared targets.
 *
 * This server stays blind on purpose. It does not verify a cookie itself, and
 * it does not know what a workspace runs on. Both answers come from targets the
 * directory's package DATA names, so adding a provider, changing how a session
 * is proved, or running workspaces somewhere else is DATA there and zero code
 * here. `postJson` is injected so this is exercisable without a socket.
 */
export function directoryBackedResolvers({ binding, postJson }) {
  const authorizeTarget = trimmedText(binding.workspace.authorize_session_target)
    ?? 'account-session.authorize-transient-session';
  const openTarget = trimmedText(binding.workspace.open_target);
  return {
    async verifySession({ headers }) {
      // The canonical `{headers:[{name,value}]}` evidence shape. Everything the
      // browser sent is forwarded as EVIDENCE, and the directory decides what
      // counts; this server picking which headers matter would be this server
      // deciding what proves identity.
      return postJson(`${binding.directoryShellUrl}/target/${authorizeTarget}`, {
        headers: headerEvidence(headers),
      });
    },
    async startWorkspace({ principalRef, workspace, headers }) {
      // The public front door must not spawn customer code with its own
      // filesystem and network privileges. A declared owner target must start
      // and attest a separately confined worker.
      const opensHere = typeof workspace?.root_directory === 'string' && workspace.root_directory.trim();
      if (opensHere && openTarget) {
        throw new Error('the binding declares both workspace.root_directory and workspace.open_target');
      }
      if (opensHere) {
        throw new Error('a customer workspace requires a confined launcher owner');
      }
      if (!openTarget) {
        // No declared owner means nothing can be opened. Saying so beats
        // answering with a shell that belongs to somebody else.
        throw new Error('the binding declares neither workspace.root_directory nor workspace.open_target');
      }
      const privateRoot = trimmedText(workspace.private_root_directory);
      if (!privateRoot || !isAbsolute(privateRoot)) {
        throw new Error('workspace owner needs an absolute private_root_directory');
      }
      const declaredSocket = trimmedText(workspace.socket_path);
      if (declaredSocket) {
        const socketWithinPrivateRoot = relative(privateRoot, declaredSocket);
        if (socketWithinPrivateRoot === ''
            || (socketWithinPrivateRoot !== '..'
              && !socketWithinPrivateRoot.startsWith('../')
              && !isAbsolute(socketWithinPrivateRoot))) {
          throw new Error('a customer-writable root cannot own the front-door socket');
        }
      }
      // The opener is itself a callable target, so it must verify the session
      // from raw request evidence. A principal string sent as a request field
      // would let a direct caller name somebody else's private volume.
      const opened = await postJson(`${binding.directoryShellUrl}/target/${openTarget}`, {
        headers: headerEvidence(headers),
      });
      // A directory target may be changed independently from this front door.
      // A reply for another principal, or one that only names a shared TCP
      // listener, cannot become this person's private upstream by accident.
      const expectedName = workspace.root_component === 'principal_digest'
        ? workspaceDigestForPrincipal(principalRef)
        : workspaceNameForPrincipal(principalRef);
      if (opened?.principal_ref !== principalRef || opened?.workspace_name !== expectedName) {
        throw new Error('workspace owner returned a different account identity');
      }
      if (opened?.opening === true) return opened;
      const socketTemplate = trimmedText(workspace.socket_path);
      if (!socketTemplate || (!socketTemplate.includes('{principal_digest}') && !socketTemplate.includes('{name}'))
          || socketTemplate.includes('{install_root}')) {
        throw new Error('workspace owner needs a principal-bound socket template');
      }
      const expectedSocket = fillWorkspacePlaceholders(socketTemplate, {
        installRoot: '',
        name: expectedName,
        principalDigest: workspaceDigestForPrincipal(principalRef),
      });
      if (!isAbsolute(expectedSocket) || expectedSocket.includes('{')
          || Buffer.byteLength(expectedSocket) > 103
          || trimmedText(opened?.socket_path) !== expectedSocket
          || trimmedText(opened?.shell_url)) {
        throw new Error('workspace owner must return one private Unix socket');
      }
      return opened;
    },
  };
}

function trimmedText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function headerEvidence(headers) {
  return Object.entries(headers ?? {}).map(([name, value]) => ({
    name,
    value: Array.isArray(value) ? value.join(', ') : String(value ?? ''),
  }));
}

function textList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => trimmedText(item)).filter(Boolean);
}

function routeHasPrefix(path, prefix) {
  if (path === prefix) return true;
  // A prefix matches at a SEGMENT boundary, not at any character. Without this
  // a `/sign-in` prefix also claims `/sign-inbox`, and a prefix ending in `.`
  // (the shape a target-name prefix takes, `/target/account-session.`) still
  // works because the test below only applies when the prefix ends in neither.
  if (!path.startsWith(prefix)) return false;
  if (prefix.endsWith('/') || prefix.endsWith('.')) return true;
  const next = path.charAt(prefix.length);
  return next === '/' || next === '?';
}

function errorText(error) {
  return String(error?.message ?? error);
}
