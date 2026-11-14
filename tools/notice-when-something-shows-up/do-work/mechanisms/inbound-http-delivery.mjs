#!/usr/bin/env node
/**
 * packages/notice-when-something-shows-up/do-work/mechanisms/inbound-http-delivery.mjs
 *
 * Purpose
 *   One waiting mechanism: wait for something to be delivered over the network,
 *   and report that it arrived. A comment carrying a trigger word, a webhook, a
 *   store notification and a peer announcement are all this one mechanism with
 *   different DATA.
 *
 * Non-negotiable invariants
 *   - This leaf knows nothing about any other leaf, and nothing about what will
 *     react to a delivery. It NEVER resolves a workflow slot and never
 *     dispatches. There is a package in this repository that answers an inbound
 *     request by dispatching directly and returning success even when the
 *     dispatch failed, so the delivery leaves no record at all. That shape is
 *     the exact failure this package exists to remove and it must not be
 *     reproduced here.
 *   - It never decides whether a delivery is welcome. It reports, and DATA
 *     elsewhere decides. Verification of a signed delivery is a separate owner
 *     reading the fact, not a branch inside this leaf.
 *   - The response is sent only AFTER the caller has finished handling the
 *     transition, so a delivery is never acknowledged before it has been
 *     written down.
 *
 * Key concepts
 *   describeMechanism()    declared identity plus contributed payload fields.
 *   watchForTransitions()  the resident wait, blocked on a listening socket.
 *
 * Security
 *   Binds the declared address and port from DATA. Bodies are read up to a
 *   declared byte ceiling and are never evaluated, never written to disk, and
 *   never used to build a command. Nothing here holds a credential.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

export const MECHANISM_REF = "package::notice-when-something-shows-up::mechanism::inbound-http-delivery";

export function describeMechanism() {
  return {
    mechanism_ref: MECHANISM_REF,
    detail_fields: [],
    conditions: ["became-reachable"],
  };
}

export function readSettings(settings = {}) {
  const port = Number(settings.listen_port);
  const ceiling = Number(settings.body_byte_ceiling);
  const host = typeof settings.listen_host === "string" && settings.listen_host.trim()
    ? settings.listen_host.trim()
    : "127.0.0.1";
  return {
    listen_host: host,
    listen_port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
    body_byte_ceiling: Number.isFinite(ceiling) && ceiling > 0 ? ceiling : 1048576,
  };
}

/** Build the observed identity for one delivery.
 *
 *  delivery_identity is what a reader deduplicates on. A caller that supplies
 *  its own delivery identity header owns that identity; otherwise this leaf
 *  mints one, and the fact records which of the two happened so a reader is
 *  never guessing whether a repeat was really a repeat. */
export function buildDeliveryIdentity(requestPath, method, headers, mintIdentity = randomUUID) {
  const supplied = typeof headers?.["x-delivery-identity"] === "string"
    ? headers["x-delivery-identity"].trim()
    : "";
  return {
    delivery_identity: supplied || mintIdentity(),
    delivery_identity_source: supplied ? "declared-by-sender" : "minted-on-receipt",
    request_path: typeof requestPath === "string" ? requestPath : "",
    request_method: typeof method === "string" ? method : "",
    body_bytes: null,
  };
}

/**
 * Wait for deliveries and report each one.
 *
 * @param {object} settings the descriptor row's mechanism_settings
 * @param {object} handlers
 * @param {(transition:object)=>Promise<void>} handlers.onTransition
 * @param {AbortSignal} handlers.signal
 * @param {()=>object} [handlers.makeServer] injected server factory, for tests
 */
export async function watchForTransitions(settings, handlers) {
  const resolved = readSettings(settings);
  const signal = handlers.signal;

  const server = (handlers.makeServer ?? createServer)(async (request, response) => {
    let received = 0;
    let overCeiling = false;
    for await (const chunk of request) {
      received += chunk.length;
      if (received > resolved.body_byte_ceiling) {
        overCeiling = true;
        break;
      }
    }
    const identity = buildDeliveryIdentity(request.url, request.method, request.headers);
    identity.body_bytes = received;
    identity.body_over_ceiling = overCeiling;
    try {
      await handlers.onTransition({
        condition: "became-reachable",
        observed_identity: identity,
        detail: {},
      });
    } catch (error) {
      // The delivery could not be written down. Say so rather than acknowledging
      // it, so the sender can send it again. Answering with success here is how
      // an arrival gets lost forever.
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ recorded: false, reason: String(error?.message ?? error) }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ recorded: true, delivery_identity: identity.delivery_identity }));
  });

  await new Promise((resolve) => {
    server.listen(resolved.listen_port, resolved.listen_host, resolve);
  });

  await new Promise((resolve) => {
    const stop = () => {
      try { server.close(() => resolve()); } catch { resolve(); }
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });
}
