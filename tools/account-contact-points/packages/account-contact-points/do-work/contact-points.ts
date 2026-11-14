// packages/account-contact-points/do-work/contact-points.ts
//
// account-contact-points — the narrow generic OWNER of account contactability
// (Codex-converged, cont.210): `account_id + purpose + channel -> controlled delivery address`.
// It does NOT send email, own sessions, own access, or own lifecycle follow-up — it is the
// missing generic owner that lets a lifecycle-mail trigger resolve a recipient address by
// account_id WITHOUT the raw email ever entering the signed event log (SP7 controlled PII).
//
// This file is the PURE, I/O-free leaf: upsert / resolve / claim over plain record arrays. The
// package's targets wrap these; the store rows are DATA (self-describing records). Zero domain
// vocabulary, zero enum of channels/templates (channel + template + purpose are DATA — L090).

/** A stored contactability record. The address IS held here (this is the delivery authority);
 *  `address_hash` is a stable dedup/verification handle so callers can compare without the raw
 *  address. `verified_state` is DATA (unverified | verified | bounced | ...), never an enum here. */
export interface ContactPoint {
  account_id: string;
  channel: string; // "email" | "sms" | ... — DATA, open set
  address: string;
  address_hash: string;
  verified_state: string;
  source_ref: string; // where the address came from (e.g. "signup", "checkout")
  updated_at: string;
}

/** A once-per-(account,purpose) delivery claim — the idempotency ledger so a welcome email is
 *  sent exactly once even if the grant event replays. */
export interface DeliveryClaim {
  account_id: string;
  template: string;
  purpose: string;
  idempotency_key: string;
  status: string; // "claimed" | "sent" | "failed" — DATA
  claimed_at: string;
  sent_at?: string;
}

const normEmail = (a: string): string => a.trim().toLowerCase();

/** Deterministic non-reversible-enough dedup handle. The OWNER may inject the platform's real
 *  hasher (account-identity's); this default is a stable fallback so the leaf stays pure + testable. */
export function defaultAddressHash(address: string): string {
  let h = 2166136261 >>> 0; // FNV-1a
  const s = normEmail(address);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return "adr_" + h.toString(16).padStart(8, "0");
}

export interface UpsertInput {
  account_id: string;
  channel?: string;
  address: string;
  source_ref: string;
  at: string;
  verified_state?: string;
  hashAddress?: (address: string) => string;
}

/** Upsert the contact point for (account_id, channel). Returns a NEW array (immutable) — one row
 *  per (account_id, channel); a re-signup with a new address REPLACES it (latest wins). Fail-closed
 *  on missing account_id/address/at (throws — no silent bad row). */
export function upsertEmailContactPoint(store: readonly ContactPoint[], input: UpsertInput): ContactPoint[] {
  if (!input.account_id) throw new Error("upsert: account_id required");
  if (!input.address || !input.address.includes("@")) throw new Error("upsert: a real email address required");
  if (!input.at) throw new Error("upsert: at (timestamp) required");
  const channel = input.channel ?? "email";
  const hash = (input.hashAddress ?? defaultAddressHash)(input.address);
  const row: ContactPoint = {
    account_id: input.account_id,
    channel,
    address: normEmail(input.address),
    address_hash: hash,
    verified_state: input.verified_state ?? "unverified",
    source_ref: input.source_ref,
    updated_at: input.at,
  };
  const rest = store.filter((c) => !(c.account_id === input.account_id && c.channel === channel));
  return [...rest, row];
}

/** Resolve the delivery address for (account_id, channel). Returns null when unknown (fail-closed —
 *  the caller must NOT send to an unresolved account). */
export function resolveEmailContactPoint(
  store: readonly ContactPoint[],
  account_id: string,
  channel = "email",
): string | null {
  const hit = store.find((c) => c.account_id === account_id && c.channel === channel);
  return hit ? hit.address : null;
}

export interface ClaimInput {
  account_id: string;
  template: string;
  purpose: string;
  idempotency_key: string;
  at: string;
}

/** Claim a once-per delivery. If a claim with the same idempotency_key already exists, returns
 *  `{alreadyClaimed:true}` and the existing ledger unchanged (the welcome does NOT re-send). Else
 *  appends a `claimed` row and returns `{alreadyClaimed:false}`. Idempotency is keyed ONLY on
 *  idempotency_key so the caller controls the grain (e.g. `${account_id}:welcome`). */
export function claimDeliveryOnce(
  claims: readonly DeliveryClaim[],
  input: ClaimInput,
): { claims: DeliveryClaim[]; alreadyClaimed: boolean; claim: DeliveryClaim } {
  if (!input.account_id || !input.idempotency_key || !input.at) throw new Error("claim: account_id, idempotency_key, at required");
  const existing = claims.find((c) => c.idempotency_key === input.idempotency_key);
  if (existing) return { claims: [...claims], alreadyClaimed: true, claim: existing };
  const claim: DeliveryClaim = {
    account_id: input.account_id,
    template: input.template,
    purpose: input.purpose,
    idempotency_key: input.idempotency_key,
    status: "claimed",
    claimed_at: input.at,
  };
  return { claims: [...claims, claim], alreadyClaimed: false, claim };
}
