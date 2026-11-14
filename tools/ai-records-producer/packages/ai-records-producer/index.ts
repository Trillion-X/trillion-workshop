/**
 * File: packages/ai-records-producer/index.ts
 *
 * Purpose: Public barrel for the ai-records-producer package.
 *   This package is a workflow-only primitive — all runtime logic lives in
 *   things-to-store-and-run.json (workflow + compute.process python scripts).
 *   The TypeScript surface exports only type shapes callers need to consume
 *   result/error records from the log.
 *
 * Invariants:
 *   - No AI vendor names, no hardcoded output_kind values (L090).
 *   - Callers read result/error records from the log by request_id;
 *     they never import workflow internals.
 */

/** Shape of one item in a result record. output_kind controls what kind appears. */
export interface AiRecordsItem {
  /** DATA-driven kind (e.g. "note") — never hardcoded here; comes from workflow input */
  kind: string;
  /** Primary text content when kind="note" */
  text?: string;
  /** Image src (data URL or URL) for image-kind items */
  src?: string;
  contentType?: string;
  extra?: Record<string, unknown>;
}

/** Shape of a successful result record at package::ai-records-producer::result::{request_id} */
export interface AiRecordsResult {
  kind: "ai-records-producer.result";
  request_id: string;
  target_group_ref: string;
  output_kind?: string;
  instruction_observability?: AiRecordsProfileInstructionSnapshot;
  prompt_hash?: `sha256:${string}`;
  items: AiRecordsItem[];
  completed_at: string;
}

/** Shape of an error record at package::ai-records-producer::error::{request_id} */
export interface AiRecordsError {
  kind: "ai-records-producer.error";
  request_id: string;
  target_group_ref?: string;
  code: "command_failed" | "parse_empty" | string;
  message: string;
  observed_at: string;
  details?: unknown;
  connect_action?: string;
}

/** One immutable current-owner input captured before a provider is dispatched. */
export interface AiRecordsAddressedInputSnapshotItem {
  position: number;
  canonical_address: string;
  expected_revision: string;
  expected_content_hash: string;
  normalized_content_hash: `sha256:${string}`;
  content: unknown;
  content_bytes: number;
  provenance: unknown;
  authorization_provenance_ref?: unknown;
}

/** Bounded, ordered source context committed into an AI request and its prompt. */
export interface AiRecordsAddressedInputSnapshot {
  kind: "ai-records-producer.addressed-input-snapshot/v1";
  items: AiRecordsAddressedInputSnapshotItem[];
  item_count: number;
  content_bytes: number;
  limits: {
    max_items: number;
    max_item_bytes: number;
    max_total_bytes: number;
  };
  snapshot_hash: `sha256:${string}`;
}

/** Body-free proof of one ordered instruction resolved from the current owner. */
export interface AiRecordsProfileInstructionSnapshotItem {
  position: number;
  id: string;
  revision: string;
  owner_content_hash: string;
  body_hash: `sha256:${string}`;
  body_bytes: number;
}

/** Persistable receipt for the exact selected-profile instruction set that ran. */
export interface AiRecordsProfileInstructionSnapshot {
  kind: "ai-records-producer.profile-instruction-snapshot/v1";
  profile_id?: string;
  profile_revision?: string;
  profile_content_hash?: `sha256:${string}`;
  items: AiRecordsProfileInstructionSnapshotItem[];
  item_count: number;
  content_bytes: number;
  limits: {
    max_items: number;
    max_item_bytes: number;
    max_total_bytes: number;
  };
  snapshot_hash: `sha256:${string}`;
}

/** Addresses for polling result/error by request_id */
export function resultAddress(requestId: string): string {
  return `package::ai-records-producer::result::${requestId}`;
}

export function errorAddress(requestId: string): string {
  return `package::ai-records-producer::error::${requestId}`;
}

export function auditRunAddress(requestId: string): string {
  return `package::ai-records-producer::run::${requestId}`;
}
