# tools/referral-codes-and-rewards/

A person gives out referral codes that earn a share of the sales of one product or one seller, and sees which live code a buyer typed, which sales it earns and what it earns. Three Workshop tools run in the deployed tool container: `tool:make-a-referral-code`, `tool:withdraw-a-referral-code` and `tool:work-out-referral-codes`. Ported from bitfield-packages `packages/referrals` (its code logic and its account state) and `packages/codes-and-rewards` (its job, not its files; see Not brought in). Nothing here moves money: a share is worked out, never paid.

## Files

| File | Purpose |
|------|---------|
| `read-data/referral-codes.mjs` | The pure parts: `makeReferralCode`, `normalizeReferralCode`, the created and withdrawn events, `referralCodesFromEvents` (first maker keeps a code, only the maker can withdraw it, order does not matter), `referralCodeFor`, `referralCodeApplies`, `referralStateFor` (newest code and accepted referrals of one account), `shareEarned`. |
| `do-work/work-out-referral-codes.mjs` | The command of `tool:work-out-referral-codes`: `{ events, codes?, sales?, share?, account? }` in `argv[2]`, one JSON line out. |
| `do-work/make-a-referral-code.mjs` | The command of `tool:make-a-referral-code`: `{ referrer, target, allowed_on, prefix?, code?, occurred_at? }` gives `{ code, event }`. |
| `do-work/withdraw-a-referral-code.mjs` | The command of `tool:withdraw-a-referral-code`: `{ referrer, code, occurred_at? }` gives `{ event }`. |
| `records.json` | The three tool rows. |
| `tool-rows.json` | Lists `records.json`'s rows into the Workshop (`source:referral-code-tools`). |
| `part.json` | No public files: only the tools run this code. |
| `test/referral-codes.test.mjs` | The package's cases on a made-up bakery: readable codes, refused targets, first maker wins in any order, matching sales, withdrawal only by the maker, account state, whole-cent shares. |
| `test/referral-codes-tools.test.mjs` | Each tool run the way its row runs it, the verify samples, make then work out then withdraw, refusals listing every problem. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| referral event | `{ kind?, subject, material: { event_type?, referral_code?, target?, referrer_account_id?, occurred_at } }` | What the person saves: a code made, a code withdrawn, a signup that named a referrer. The event type is `material.event_type`, else `kind`. |
| target | `{ on, value }` | The sale attribute a code points at and the value a sale must have. The person's `allowed_on` list says which attributes a code may point at; nothing here names one. |
| `referralCodesFromEvents` | `(events) => Map<code, { code, referrer, target, created_at, withdrawn_at? }>` | The fold. |
| `referralCodeApplies` | `(code, sale) => boolean` | A sale earns a code its share when the target attribute has the target value. |
| `shareEarned` | `(sale, { amount_field, basis_points }) => cents` | New in this tool: the share a sale earns, rounded down to whole cents. The package left a share's size to the caller and did not compute it. |
| `referralStateFor` | `(account, events) => { referral_code, accepted_referral_count }` | Give it that account's own events; signups are counted only when they name the account as the referrer. |

## Invariants

- No money moves and nothing is sent. Saving an event is the person's own act through their records.
- The first account to make a code keeps it, whatever order events arrive in; a withdrawal by another account is ignored.
- A code points at one `{ on, value }` and only an attribute the caller allowed.
- Shares are whole cents, rounded down.

## Not brought in

`packages/codes-and-rewards` is a descriptor-driven projection of records into screen rows plus a builder of owner-action requests for the old engine's workflow slot. That is a screen and the old engine's action plumbing, not a seller's job, so it stays with the screens; its package does not own reward math either. The referrals portal panel, the browser-session reader and the sender that signed and admitted events through the old signed-event authority are the old engine's too: here the person saves the event in their own records. The package's account-derived `makeReferralCode` is replaced by the random readable code.

## Dependencies

**Depends on:** Node in the tool container.

**Depended on by:** Trillion's deploy (it reads `tool-rows.json` and bundles the files a row names).
