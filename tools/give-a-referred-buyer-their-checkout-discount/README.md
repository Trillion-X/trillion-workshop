# tools/give-a-referred-buyer-their-checkout-discount/

The referral part of one checkout, as a tool: `tool:give-a-referred-buyer-their-checkout-discount` reads the code a buyer came
with (`code`, such as a site's referral cookie) against the pursuit database's own referral rows, with the rules of
`tools/referral-codes-and-rewards`, and answers the friend's discount as the take-payments checkout takes it. A site's checkout
action reads its three keys into the checkout's input (one run: two sources naming one tool with one input are one run).

- **Someone else's live code gives the discount.** The answer is `checkoutCode`, `adjustments` (each a checkout code
  adjustment) and `metadata: { referral_code }`.
- **Anything else is a normal checkout.** No code, a malformed, unknown or withdrawn code, the buyer's own code (given
  `buyer_email`), or rules with no friend reward: the answer is empty, never an error.
- **Broken rules stop the sale.** A rule row the referral rules refuse, or no `referral_code_target` row named `target`, is
  refused by name, so nothing is sold without the discount its rules promise.
- **No email is read, and none leaves.** The buyer's own code is found by `own_code(code, email)`, a `SECURITY DEFINER`
  function the pursuit's owner makes (`sql/own-code.sql`) and the site's reader may only execute, so the reader holds no right
  on `referral_codes.email`. The answer holds the code and the discount only.

## Files

| File | Purpose |
|------|---------|
| `reads/referral-checkout.ts` | `referralCheckout(input, rows)`: the read, run by `run-sql-in-my-database/do-work/serve-a-read.ts` (one read-only transaction; the connection on descriptor 3). |
| `sql/own-code.sql` | For a pursuit whose reader login must not read `referral_codes.email`: `own_code(code, email)`, made by the database's owner (SET ROLE to it first) after `referral_codes`, then `GRANT EXECUTE` to the reader. The email is compared trimmed and without case; null, empty or unknown input answers false, never an error. |
| `read-data/reader-rights.json` | The reads file: the columns the reader is granted (`referral_codes` `code`, `made_at`; the rules; the target), and no email. A computer row's database unit names it in the reader's grants `reads_from`. |
| `what-this-tool-does-and-how-to-run-it.json` | The tool's row. |
| `kits/give-a-referred-buyer-their-checkout-discount.json` | How to ask for it, with a worked example. |
| `test/referral-checkout.test.ts` | The read in PGlite, run as a reader holding exactly the reads file's columns plus EXECUTE on `own_code`: a friend's discount, the empty answers, the refused rules and target, the reader refused `email`, and `own_code` true for the owner and false for anyone else. |

## Rows it reads

| Table | Columns |
|---|---|
| `referral_codes` | `code`, `made_at` (never `email`; `own_code(code, email)` answers whether a code is a buyer's own) |
| `referral_reward_rules` | `id`, `value` (one referral reward rule each) |
| `referral_code_target` | `name`, `target_on`, `target_value` |

## Dependencies

`tools/referral-codes-and-rewards` (`workOutReferralCodes`, `normalizeReferralCode`, `referralCodeCreatedEvent`,
`readRewardRules`, `allowedOnFrom`), `tools/run-sql-in-my-database` (`serveARead`).
