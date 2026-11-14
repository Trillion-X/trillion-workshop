// packages/ai-cli-launch-adapters/do-work/transport-capabilities.mjs
//
// =============================================================================
// PURPOSE, the generic transport dispatcher (enum-dissolution)
// =============================================================================
//
// resolveChatLaunch reads a launch descriptor's self-describing `transport` DATA
// value and dispatches through a CAPABILITY MAP keyed by that value. This module
// owns the generic core ONLY: it holds ZERO transport names and ZERO
// transport-specific logic. A new transport is a new map entry bound to a leaf
// capability (DATA plus a leaf module), never an edit to an if/switch here.
//
// The only finite check is absence: a transport with no registered capability is
// refused. That is an Option-style presence test (closed by physics), NOT an
// enumeration of the open transport set, so adding "remote-http-stream",
// "web-socket-stream", or anything invented later never touches this dispatcher.
// =============================================================================

/**
 * Dispatch a launch bundle to the capability the `transport` DATA value names.
 * `capabilities` is the injected capability map, and owner wiring decides which
 * capabilities are installed. Own-property lookup only, so a transport value like
 * "__proto__" cannot reach an inherited method. Throws when no capability is
 * registered for the transport, the exact fail-closed behavior every unsupported
 * transport receives.
 */
export function resolveTransport(transport, bundle, capabilities) {
  const capability = Object.prototype.hasOwnProperty.call(capabilities, transport)
    ? capabilities[transport]
    : undefined;
  if (typeof capability !== "function") {
    throw new Error("cli_launch_has_unsupported_transport");
  }
  return capability(bundle);
}
