# tools/referral-codes-and-rewards/

A business gives out referral codes that earn rewards, and sees which live code a buyer typed, what a friend who typed it gets and what each sale earns. What a code earns is the business's own **rows**, not code: one row per rule in its referral reward rules list (who earns, the kind of reward, its terms, which codes and sales it applies to), its columns defined as data in `read-data/referral-reward-list.json` like any other list. Four Workshop tools run in the deployed tool container: `tool:make-a-referral-code`, `tool:withdraw-a-referral-code`, `tool:work-out-referral-codes` and `tool:give-referral-rewards`. Ported from bitfield-packages `packages/referrals` (its code logic and its account state) and `packages/codes-and-rewards` (its job, not its files; see Not brought in). Nothing here is a money path of its own: a share is worked out (the person pays it however they pay people), a discount becomes a `checkout-code-adjustment` row that take-payments takes off a price, and access becomes an `access-grant` row written the way `tool:grant-paid-access-to-people` writes it.

## The rules are rows

Make the list once: a record of type `list` whose id and value are `list` in `read-data/referral-reward-list.json`. Then add a row (type `record:referral-reward-rule`) for each rule. Trillion's own rules are two such rows in Trillion's list; another business's are theirs.

| Column | Meaning |
|---|---|
| `state` | `active` or `inactive`; only active rows are read. A malformed active row is skipped and named, with every problem, in the answer's `rules_refused`. |
| `earner`, `reward` | Who earns it (`referrer` is the account that made the code, `friend` is the buyer who typed it) and what kind: `share` (referrer only), `discount` or `access`. |
| `code_points_at`, `code_points_at_value` | The rule applies to codes whose target is this sale attribute (and this value, when given). These attributes are also the only ones `tool:make-a-referral-code` lets a code point at. |
| `offer_ids` | When given, only sales of these offers (the sale's `offer_id`) earn it; a discount's checkout code applies to these offers. |
| `arm_group`, `weight` | Rows in one group are arms of a test: each referrer lands on one arm, the same one every time, by weight. |
| `amount_field`, `basis_points` | A share: the sale field holding the amount, and the share in basis points, rounded down to whole cents. |
| `percent` or `amount_cents` + `currency`, `duration`, `duration_in_months`, `max_redemptions` | A discount, as a checkout-code-adjustment (a credit is an amount that applies once). |
| `access_ref`, `access_days`, `friend_field` | Access, as a grant: for the referrer, or for the person the sale's `friend_field` names; `access_days` needs the sale's `occurred_at_ms`. |

A friend's discount is the referral code itself as a checkout code (typed at checkout); a referrer's discount or access is given per sale, from the sale's `id`, so the same sale gives the same reward once. Trillion's cookies, links and the 90-day window a friend's offer is shown are the sign-up flow's, not reward rules; `tools/referrals/src/referrals.json` is the old tree's copy of them (its importer still reads it) and its reward values are no longer the source: the rows are.

## Files

| File | Purpose |
|------|---------|
| `read-data/referral-codes.mjs` | The pure parts: `makeReferralCode`, `normalizeReferralCode`, the created and withdrawn events, `referralCodesFromEvents` (first maker keeps a code, only the maker can withdraw it, order does not matter), `referralCodeFor`, `referralCodeApplies`, `referralStateFor` (newest code and accepted referrals of one account), `shareEarned`. |
| `read-data/referral-reward-rules.mjs` | The rows as rules (`readRewardRules`, every problem listed), the arm a referrer lands on, and what a code gives a friend (`rewardsForCode`) or a sale earns (`rewardsForSale`). |
| `read-data/referral-reward-list.json` | The list and its columns, as data. |
| `do-work/referral-rewards.mjs` | `makeAReferralCode`, `workOutReferralCodes` and `giveReferralRewards`, run through the records-door command with the business's rule rows read from the door. |
| `do-work/withdraw-a-referral-code.mjs` | The command of `tool:withdraw-a-referral-code`: `{ referrer, code, occurred_at? }` gives `{ event }`. |
| `records.json` | The four tool rows. |
| `tool-rows.json` | Lists `records.json`'s rows into the Workshop (`source:referral-code-tools`). |
| `part.json` | No public files: only the tools run this code. |
| `test/referral-codes.test.mjs` | The package's cases on a made-up bakery: readable codes, refused targets, first maker wins in any order, matching sales, withdrawal only by the maker, account state, whole-cent shares. |
| `test/referral-rewards.test.mjs` | Each tool run as its row runs it against the stand-in records door: a changed rule row changes the answer, codes point only at what a rule names, the friend and referrer discounts are rows take-payments reads, access is held by the access rules, a second run writes nothing, malformed rows are named. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| referral event | `{ kind?, subject, material: { event_type?, referral_code?, target?, referrer_account_id?, occurred_at } }` | What the person saves: a code made, a code withdrawn, a signup that named a referrer. The event type is `material.event_type`, else `kind`. |
| target | `{ on, value }` | The sale attribute a code points at and the value a sale must have. An active rule row's `code_points_at` says which attributes a code may point at; nothing here names one. |
| `referralCodesFromEvents` | `(events) => Map<code, { code, referrer, target, created_at, withdrawn_at? }>` | The fold. |
| `referralCodeApplies` | `(code, sale) => boolean` | A sale earns a code its share when the target attribute has the target value. |
| `shareEarned` | `(sale, { amount_field, basis_points }) => cents` | The share a sale earns, rounded down to whole cents; the rule row gives the field and the basis points. |
| `referralStateFor` | `(account, events) => { referral_code, accepted_referral_count }` | Give it that account's own events; signups are counted only when they name the account as the referrer. |

## Invariants

- No money moves and nothing is sent. Saving an event is the person's own act through their records. The only records the tools write are the `checkout-code-adjustment` and `access-grant` rows `tool:give-referral-rewards` gives, once each (a reward already kept with different terms stays and is refused with why).
- A reward's amount, field, offer or access is never in the code: only in a rule row.
- The first account to make a code keeps it, whatever order events arrive in; a withdrawal by another account is ignored.
- A code points at one `{ on, value }` and only an attribute an active rule row names.
- Shares are whole cents, rounded down.

## Not brought in

`packages/codes-and-rewards` is a descriptor-driven projection of records into screen rows plus a builder of owner-action requests for the old engine's workflow slot. That is a screen and the old engine's action plumbing, not a seller's job, so it stays with the screens; its package does not own reward math either. The referrals portal panel, the browser-session reader and the sender that signed and admitted events through the old signed-event authority are the old engine's too: here the person saves the event in their own records. The package's account-derived `makeReferralCode` is replaced by the random readable code.

## Dependencies

**Depends on:** Node in the tool container; `tools/records-door` (the door the rule rows are read from), `tools/paid-access` (the grant writer), `tools/content-identity`. A discount it writes is read by `tools/take-payments`.

**Depended on by:** Trillion's deploy (it reads `tool-rows.json` and bundles the files a row names).
