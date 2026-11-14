// packages/ai-cli-launch-adapters/do-work/remote-http-stream-transport.mjs
//
// =============================================================================
// LEAF transport capability, remote streaming agent endpoint
// =============================================================================
//
// This is how an agent built with ANY framework (LangGraph, Mastra, CrewAI, by
// hand) arrives as pure DATA: the runtime speaks a protocol (AG-UI, a2a, a future
// one) over an HTTP stream, and BOTH the transport and the protocol are
// self-describing DATA fields, never a code branch. Adding a new agent protocol
// is a new adapter DATA row with a different `protocol` value; adding a genuinely
// new transport is a new capability-map entry plus a leaf like this one. Neither
// edits a dispatcher (enum-dissolution).
//
// Pure resolution, mirroring resolve-chat-launch.mjs's resolveHttpTransport:
// validate the declared descriptor and return it as opaque DATA for the caller's
// executor. It NEVER opens a socket and NEVER reads a credential. The endpoint and
// key ride a service-connection handle, resolved per-run by the caller so a
// revocation takes effect on the next run.
// =============================================================================

function asString(value) {
  return typeof value === "string" && value ? value : null;
}
function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve a remote-http-stream launch descriptor into its transport shape.
 * Required DATA: `protocol` (ag-ui, a2a, or any future agent protocol, read as a
 * value and never branched on) and `endpoint_handle_ref` (a service-connection
 * handle, NEVER an inline url or secret). Optional: `framework_label`,
 * `headers_template`, `timeout_ms`. Fails closed on a malformed descriptor.
 */
export function remoteHttpStreamTransport(launch) {
  const protocol = asString(launch.protocol);
  const endpointHandleRef = asString(launch.endpoint_handle_ref);
  if (protocol === null || endpointHandleRef === null) {
    throw new Error("remote_http_stream_launch_missing_required_descriptor");
  }
  if (launch.headers_template !== undefined && !plainRecord(launch.headers_template)) {
    throw new Error("remote_http_stream_launch_malformed_headers");
  }
  return {
    transport: "remote-http-stream",
    protocol,
    endpoint_handle_ref: endpointHandleRef,
    ...(asString(launch.framework_label) ? { framework_label: launch.framework_label } : {}),
    ...(plainRecord(launch.headers_template) ? { headers_template: launch.headers_template } : {}),
    timeout_ms: Number.isSafeInteger(launch.timeout_ms) && launch.timeout_ms > 0 ? launch.timeout_ms : 120000,
  };
}
