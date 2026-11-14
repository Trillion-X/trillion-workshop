# referrals

Portal surface for creating a referral code and recording codes received from other accounts, folded from signed account effects.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Public exports: surface component, projection fold, portal reader, event sender |
| `read-data/referral-codes.ts` | Codes that point at something: a target `{ on, value }` names the sale attribute and value a code earns a share of (one tool, one seller, the platform); first creation of a code wins, withdrawal stops it; `referralCodeApplies(code, sale)` |
| `tests/referral-codes.test.ts` | Code shape, allowed targets, first-creator-wins in any order, matching sales, withdrawal only by its referrer |
| `read-data/read-referral-state.ts` | `referralStateFromEffects` — pure fold of signed effects into `{referralCode, acceptedReferralCount}` |
| `do-work/read-portal-referrals.ts` | Browser-session reader: account id from the portal session, effects via `signed-event-authority.list-effects`, folds with `referralStateFromEffects` |
| `do-work/send-referral-event.ts` | `sendReferralEvent` (sign via `signed-event-author.sign-event`, admit via `signed-event-authority.admit-event`) + `makeReferralCode` |
| `show/app-shell/ReferralsPortalSurface.tsx` | Portal panel: your code + accepted-referral stats, create-code and record-code actions |
| `show/mount-referrals-portal.tsx` | Entry mount (`ErrorBoundary` + `mountReactSurface`) |
| `tests/read-referral-state.test.ts` | Projection fold tests (newest code wins, referrer-scoped counting, malformed effects) |
| `things-to-store-and-run.json` | Package boundary: stored bytes, contract, placeable-surface row `referrals`, entry `referrals-portal` |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `ReferralStateProjection` | `{ referralCode: string \| null; acceptedReferralCount: number }` | Folded referral state |
| `ReferralEffect` | `{ kind?, subject?, material? }` | Open effect shape accepted by the fold |
| `referralStateFromEffects` | `(accountId, effects[]) => ReferralStateProjection` | Newest `referral_code_created`/`referral.code` wins; signup count scoped to `referrer_account_id === accountId` |
| `readPortalReferralState` | `() => Promise<PortalReferralState \| null>` | Signed-in reader (null when no browser session) |
| `sendReferralEvent` | `(ReferralEventInput) => Promise<T>` | Sign then admit a `referral.lifecycle` fact |
| `ReferralCode` / `ReferralTarget` | `{ code, referrer, target: { on, value }, created_at, withdrawn_at? }` | A live or withdrawn code and what it points at |
| `referralCodeCreatedEffect` / `referralCodeWithdrawnEffect` | `({ referrer, code, target, occurredAt, allowedOn }) => effect`; `({ referrer, code, occurredAt }) => effect` | Effects to admit; `allowedOn` is the caller's DATA list of sale attributes a code may point at |
| `referralCodesFromEffects` / `referralCodeFor` / `referralCodeApplies` | `(effects) => Map`; `(codes, text) => ReferralCode \| null`; `(code, sale) => boolean` | Pure fold, lookup of a live code, and whether a sale earns its share |
| `makeTargetedReferralCode` | `({ prefix, randomBytes }) => string` | A readable code from random bytes (Crockford letters) |
| `makeReferralCode` | `(accountId) => string` | Human-shareable code derived from the account id |

## Dependencies

**Depends on:** `@bitfield/runtime-kit` (`sendRequestToBitfieldTarget`), `@/packages/ui` (Button, Card, Container, Icon, Input, Text, ErrorBoundary, react-surface-mount), the live targets `signed-event-author.sign-event`, `signed-event-authority.sign in/list-effects/admit-event`.

**Depended on by:** the account portal shell (`account-shell`) via the `placeable-surface-list::main-workspace` catalog row `referrals` → package entry `referrals-portal`. No compile-time dependents.

## Boundaries

Owns only the referral-code surface. Does NOT own event signing, admission, account state, or reward math (a share's size is the caller's DATA) — those stay in `signed-event-author` / `signed-event-authority` / account packages and are reached by target address only.
