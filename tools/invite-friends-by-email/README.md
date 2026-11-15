# Invite friends by email

Source-preserving library ports of old Trillion's `src/friend-invites.mjs` and `src/invites-on-arrival.mjs`, pinned to `b6ae0ebf815f2f5271eed34e6e023c7e1767ec04`. Original words, limits, status order, normalized-address identity, resend behavior, joined-space ordering and fifty-entry arrival history remain owned here. Exact original bytes are kept in the baseline commit named by this tool's `ports/` contracts; the source characterization fixture supplies hash imports from the current identity owner.

`read-data/friend-invites.mjs` exports `friendInvites(owners)`, returning the original `inviteFriend`, `forgetInvite`, `invitesOf` and `friendInviteFacts` operations and `FriendInviteError`. Its required `door` is the public `tools/records-door` client; `rowType` must name the native import's actual invitation row kind. It preserves the original `friend-invite:<user>:<email identity>` ids. All invitation reads, list pages, writes and removals go through that door. The BLAKE3 calculation uses `tools/content-identity`; no Worker storage is imported. Pagination resumes after an account-scoped row id; old KV continuation tokens are not accepted as native cursors.

Other required owners retain their original call shapes: `normalEmail(value)`, `accountsForEmail(records, email)`, `referralSummary(env, userId)`, `referralsOf(env, userId)`, `day(iso)`, `offWords(reward)` and `sendMail(env, mail, message)`. The mail binding is supplied by the public `tools/send-messages/do-work/mail-sender.mjs` `mailSender` owner, which owns sender identity, limits, delivery and unknown outcomes. These are host library bindings, never values accepted from a tool request. A missing binding refuses construction.

`read-data/invites-on-arrival.mjs` exports `invitationArrivals(owners)`, returning `joinInvitesOnArrival` and async `arrivalsOf`. It requires `signInMethodsOf`, `executeNativeSharedInvitation` and `joinAdmittedAddressedInvitation`, plus a host account facade with `network`, `relay`, `ctx.id`, `env`, async `fact` and async `setFact`. That facade must be bound by the current admitted native owner over the account's records. A caller-authored address or principal is never proof. No unsigned Network join fallback remains; absent current sign-in claims causes no discovery or join. Refused joins and address lookup failures remain nonfatal to sign-in.

These are library ports, **not installed invitation tools**. There is no runnable tool row. The current Rust engine has no public replacement for the old global email/account lookup, Trillion referral summary, proven-address invitation discovery or admitted Space joins. The held `shares.mjs` and `spaces.mjs` owners cannot be imported to fill that gap. `referral-codes-and-rewards` owns seller commissions, which do not replace Trillion's account referral rewards. The correct native bindings, imported invitation record-kind mapping, account-erasure coverage, the sign-in hook and installed consumer readback remain required before runtime qualification. No invitation was sent during these checks.

Run the source-versus-port behavior checks with:

```sh
node --test test/friend-invites-held.test.mjs test/invites-on-arrival-held.test.mjs
```

The tests use synthetic owners. They also exercise the real records client against its rights-enforcing test door, including short pages and foreign-account refusals; they do not qualify the missing native admission bindings.

The `friendInvites` binding receives `settings` from the account lists; no second JSON copy supplies invitation words or limits.
