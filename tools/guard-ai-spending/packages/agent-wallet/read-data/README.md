# agent-wallet/read-data

Wallet and budget authority decoders.

## Invariants

- Budget checks and reservations are owner-authored records from `agent-wallet`.
- Launch authority requires a current budget check and exactly one current
  reservation fencing token for the operation, idempotency key, and wallet.
- Wallet secrets and payment credentials never appear in decoded authority
  values; consumers receive wallet refs, evidence refs, and fencing tokens.
