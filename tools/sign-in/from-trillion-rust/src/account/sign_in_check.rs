//! Who a request to the account's routes is, and whether they may make one operation:
//! answered only by the account's own sign-in (src/account/sign_in), on every
//! request, so a turned-off key, a disconnected AI app or an ended session
//! stops at once. No other source is consulted and nothing falls back.
//!
//! `admit` reads the credential a request carries: a bearer personal key, a
//! bearer OAuth access token, or (with no Authorization header) the browser
//! session cookie. `permits` decides one operation from the principal's
//! scopes and the reach each scope has in the account routes' contract (`sign_in.rs` `contract`, `reach`:
//! scope to [address, method] pairs, `*` any characters); everything else is
//! refused.

use crate::account::sign_in::{self, keys, oauth, sessions, store::Store, Principal};
use crate::storage::Storage;

/// The principal a request's credential names, or `None`. A malformed or
/// unknown scheme is `None`; a present Authorization header never falls back
/// to the cookie.
pub(crate) fn admit(storage: &dyn Storage, authorization: Option<&str>, cookie: Option<&str>) -> sign_in::Result<Option<Principal>> {
    let store = Store::new(storage);
    let Some(authorization) = authorization else { return sessions::current(&store, cookie) };
    let Some(token) = bearer(authorization) else { return Ok(None) };
    if token.starts_with(&sign_in::contract().personal_key_prefix) {
        keys::check(&store, token)
    } else {
        oauth::bearer(&store, token)
    }
}

/// The bearer of an already admitted call, read again at an effect or delivery fence. This has the same live
/// key/token/grant checks as admission, but no key activity write. It never accepts a browser cookie.
pub(crate) fn current_bearer(storage: &dyn Storage, token: &str) -> sign_in::Result<Option<Principal>> {
    let store = Store::new(storage);
    if token.starts_with(&sign_in::contract().personal_key_prefix) {
        keys::current(&store, token)
    } else {
        oauth::bearer(&store, token)
    }
}

/// Whether `principal` may make `method` on `address`: by its own scopes' reach, or, when it holds every scope of the
/// account's own full key (`sign_in/reach.json` `full_key`), by that key's reach too, except an operation only the
/// person present may make.
pub(crate) fn permits(principal: &Principal, address: &str, method: &str) -> bool {
    let contract = sign_in::contract();
    let own = principal.scopes.iter().filter_map(|scope| contract.reach.get(scope)).flatten()
        .any(|(at, methods)| matches(at, address) && matches(methods, method));
    own || (full_key(principal)
        && contract.full_key.reach.iter().any(|(at, methods)| matches(at, address) && matches(methods, method))
        && needs_person(address, method).is_none())
}

/// Whether `principal` holds every scope of the account's own full key.
pub(crate) fn full_key(principal: &Principal) -> bool {
    sign_in::contract().full_key.holds.iter().all(|scope| principal.scopes.contains(scope))
}

/// Why `method` on `address` is one only the person present may make, if it is (`sign_in/reach.json`
/// `full_key.needs_person`).
pub(crate) fn needs_person(address: &str, method: &str) -> Option<&'static str> {
    sign_in::contract().full_key.needs_person.iter()
        .find(|row| matches(&row.address, address) && matches(&row.method, method))
        .map(|row| row.why.as_str())
}

/// Whether `text` matches `pattern`, where `*` stands for any characters.
fn matches(pattern: &str, text: &str) -> bool {
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or_default();
    let Some(mut rest) = text.strip_prefix(first) else { return false };
    let parts: Vec<&str> = parts.collect();
    let Some((last, middle)) = parts.split_last() else { return rest.is_empty() };
    for part in middle {
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    rest.len() >= last.len() && rest.ends_with(last)
}

/// The token of a `Bearer <token>` header (scheme case-insensitive, RFC 6750).
fn bearer(authorization: &str) -> Option<&str> {
    let (scheme, token) = authorization.trim().split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() && !token.contains(' ')).then_some(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::sign_in::Locked;
    use crate::storage::memory::Memory;

    fn storage() -> Locked<Memory> {
        Locked::new(crate::account::sign_in::lists::test_memory())
    }

    /// A well-formed owner id for the tests (64 lowercase hex).
    const OWNER: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn scopes() -> Vec<String> {
        sign_in::contract().scopes.clone()
    }

    #[test]
    fn a_personal_key_is_admitted_until_it_is_turned_off() {
        let storage = storage();
        let store = Store::new(&storage);
        let (key, id) = keys::issue(&store, "owner", OWNER, "script", &scopes(), 0).unwrap();
        let principal = admit(&storage, Some(&format!("Bearer {key}")), None).unwrap().expect("admitted");
        assert_eq!(principal.account, "owner");
        assert_eq!(principal.sign_in, format!("key:{id}"));
        assert!(keys::turn_off(&store, "owner", &id).unwrap());
        assert!(admit(&storage, Some(&format!("Bearer {key}")), None).unwrap().is_none());
    }

    #[test]
    fn a_session_is_admitted_only_without_an_authorization_header() {
        let storage = storage();
        let store = Store::new(&storage);
        let set = sessions::start(&store, "owner", "passkey").unwrap();
        let cookie = set.split(';').next().unwrap();
        assert_eq!(admit(&storage, None, Some(cookie)).unwrap().expect("admitted").account, "owner");
        assert!(admit(&storage, Some("Bearer unknown"), Some(cookie)).unwrap().is_none());
        assert!(admit(&storage, Some("Basic abc"), Some(cookie)).unwrap().is_none());
    }

    #[test]
    fn nothing_and_unknown_credentials_are_not_admitted() {
        let storage = storage();
        assert!(admit(&storage, None, None).unwrap().is_none());
        assert!(admit(&storage, Some("Bearer nm_0000000000000000000000000000000000000000000000000000000000000000"), None).unwrap().is_none());
        assert!(admit(&storage, Some("Bearer not-a-token"), None).unwrap().is_none());
        assert!(admit(&storage, Some("Bearer"), None).unwrap().is_none());
    }

    #[test]
    fn the_vault_right_and_the_full_key_keep_a_held_value_and_nothing_else_does() {
        let principal = |scopes: &[&str]| Principal {
            account: "owner".into(),
            sign_in: "key:x".into(),
            client_id: None,
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            expires_at_ms: 0,
        };
        let vault = principal(&["vault"]);
        assert!(permits(&vault, "@held-values", "held-values:put"));
        assert!(permits(&vault, "@held-values", "held-values:remove"));
        assert!(!permits(&vault, "@held-values", "held-values:remove-sealed"), "the queued removal is never reached through the door");
        assert!(!permits(&vault, "@held-values", "held-values:put-sealed"));
        assert!(!permits(&vault, "@own-records", "records:write"));
        assert!(!permits(&vault, "@held-values", "held-values:sign"), "a vault key signs only through a run's held-value right");
        assert!(!permits(&principal(&["records", "tools"]), "@held-values", "held-values:put-sealed"));
        let full = principal(&["records", "tools"]);
        assert!(permits(&full, "@held-values", "held-values:put"), "the account's own full key keeps a held value");
        assert!(permits(&full, "@held-values", "held-values:remove"), "the account's own full key removes a held value");
        assert!(permits(&full, "@held-values", "held-values:sign"), "the full key is a run's parent, so it reaches the signing operation");
        assert!(!permits(&principal(&["records"]), "@held-values", "held-values:put"), "records alone do not reach the vault");
        assert!(!permits(&principal(&["tools"]), "@held-values", "held-values:put"), "tools alone do not reach the vault");
        assert!(!permits(&principal(&["records"]), "@held-values", "held-values:remove"), "records alone do not remove from the vault");
        assert!(!permits(&principal(&["tools"]), "@held-values", "held-values:remove"), "tools alone do not remove from the vault");
        assert!(!permits(&principal(&["namespace-read"]), "@held-values", "held-values:remove"), "a read-only key does not remove from the vault");
    }

    #[test]
    fn scopes_cover_only_their_own_address_and_methods() {
        let principal = |scopes: &[&str]| Principal {
            account: "owner".into(),
            sign_in: "key:x".into(),
            client_id: None,
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            expires_at_ms: 0,
        };
        let records = principal(&["records"]);
        assert!(permits(&records, "@own-records", "records:read"));
        assert!(permits(&records, "@own-records", "records:write"));
        assert!(!permits(&records, "@workshop-tools", "tools:run"));
        assert!(!permits(&records, "@own-records", "tools:run"));
        assert!(!permits(&records, "@other", "records:read"));
        let tools = principal(&["tools"]);
        assert!(permits(&tools, "@workshop-tools", "tools:list"));
        assert!(!permits(&tools, "@own-records", "records:read"));
        assert!(!permits(&principal(&[]), "@own-records", "records:read"));
        assert!(permits(&records, "@namespace", "list_files"));
        assert!(permits(&records, "@own-records", "workspace:read"));
        assert!(permits(&records, "@own-records", "workspace:write"));
        assert!(!permits(&tools, "@own-records", "workspace:write"));
        assert!(permits(&records, "@own-records", "sharing.receive"));
        assert!(!permits(&tools, "@own-records", "sharing.receive"));
        assert!(!permits(&records, "@own-records", "sharing.keep"));
        assert!(permits(&tools, "@computer-grants", "grants:list"));
        // Granting or revoking a computer capability is the person's act: an AI key holding the tools scope, or the
        // account's full AI key, never reaches it (the grant would be the AI granting itself access).
        assert!(!permits(&tools, "@computer-grants", "grants:grant"));
        assert!(!permits(&tools, "@computer-grants", "grants:revoke"));
        assert!(!permits(&principal(&["records", "tools"]), "@computer-grants", "grants:grant"));
        assert!(!permits(&principal(&["records", "tools"]), "@computer-grants", "grants:revoke"));
        let account = principal(&[sign_in::contract().account_scope.as_str()]);
        assert!(permits(&account, &sign_in::contract().door.resource, &sign_in::contract().door.passkey_link));
        assert!(permits(&account, "@computer-grants", "grants:grant"));
        assert!(permits(&account, "@computer-grants", "grants:revoke"));
        assert!(!permits(&records, &sign_in::contract().door.resource, &sign_in::contract().door.passkey_link));
        assert!(!permits(&records, &sign_in::contract().door.resource, &sign_in::contract().door.settings));
    }

    /// Closure over the reach DATA: every set of the scopes an AI can hold (any subset of the scopes an issued key or an
    /// OAuth grant may carry, never the person's own scope) reaches no person-only operation. Minting is covered too: a
    /// key minted by an AI carries a subset of the minter's scopes (attenuation, account_routes issue-key), so it never
    /// gains the person's scope, and minting a key that carries it is itself person-only (`needs_person`). A future
    /// route or scope that widens this set fails here.
    #[test]
    fn no_ai_held_scope_reaches_a_person_only_operation() {
        let contract = sign_in::contract();
        let door = &contract.door.resource;
        let ai_scopes: Vec<&str> = contract.scopes.iter().map(String::as_str).collect();
        assert!(!ai_scopes.contains(&contract.account_scope.as_str()), "the person's scope is never an AI scope");
        for mask in 0..(1u32 << ai_scopes.len()) {
            let held: Vec<&str> = ai_scopes.iter().enumerate()
                .filter(|(at, _)| mask & (1 << at) != 0)
                .map(|(_, scope)| *scope)
                .collect();
            let principal = holding(&held);
            for row in &contract.full_key.needs_person {
                assert!(!permits(&principal, &row.address, &row.method), "{held:?} reaches {}", row.method);
            }
            for (operation, _) in NEEDS_PERSON {
                assert!(!permits(&principal, door, operation), "{held:?} reaches {operation}");
            }
        }
    }

    fn holding(scopes: &[&str]) -> Principal {
        Principal {
            account: "owner".into(),
            sign_in: "grant:x".into(),
            client_id: Some("ai".into()),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            expires_at_ms: 0,
        }
    }

    /// Every account-route operation the person's own page may make that the account's own full AI key (every OAuth scope)
    /// now makes too: none of them proves the person is present.
    const FULL_KEY_OPERATIONS: &[&str] = &[
        "sign-in:principal", "sign-in:keys", "sign-in:turn-off-key", "sign-in:apps",
        "sign-in:disconnect-app", "sign-in:places", "sign-in:set-places", "sign-in:settings", "sign-in:set-settings",
        "sign-in:limits", "sign-in:set-limits", "sign-in:ways", "sign-in:set-ways", "sign-in:words", "sign-in:set-words",
        "sign-in:remove-way", "sign-in:deliveries", "sign-in:set-delivery", "sign-in:copies", "sign-in:set-copies",
        "sign-in:set-copies-rules", "sign-in:set-offered-computers", "sign-in:set-host-kind", "sign-in:computers-list",
        "sign-in:set-computers-list-row", "sign-in:passkeys", "sign-in:sessions", "sign-in:end-session",
        "sign-in:web-link", "sign-in:clients", "sign-in:add-client", "sign-in:remove-client",
        "sign-in:delete-account", "sign-in:deletion",
    ];

    /// The operations only the person present may make, and why each stays refused to the full key.
    const NEEDS_PERSON: &[(&str, &str)] = &[
        ("sign-in:passkey-link", "registering a passkey"),
        ("sign-in:waiting", "registering a passkey"),
        ("sign-in:withdraw", "registering a passkey"),
        ("sign-in:remove-passkey", "removing a passkey"),
        ("sign-in:vouch-passkey", "passkey ceremony"),
        ("sign-in:recover-passkeys", "removing a passkey"),
        ("sign-in:confirm-change", "passkey ceremony"),
        ("sign-in:issue-key", "passkey"),
    ];

    #[test]
    fn the_accounts_own_full_key_reaches_what_the_persons_page_does() {
        let door = &sign_in::contract().door.resource;
        let full = holding(&["records", "tools"]);
        assert!(full_key(&full));
        for operation in FULL_KEY_OPERATIONS {
            assert!(permits(&full, door, operation), "the full key reaches {operation}");
            assert!(needs_person(door, operation).is_none(), "{operation} does not need the person");
        }
        // Every operation the account's routes name is either reached by the full key or person-confirmation-only, with its reason.
        let named: Vec<&str> = FULL_KEY_OPERATIONS.iter().copied().chain(NEEDS_PERSON.iter().map(|(name, _)| *name)).collect();
        assert_eq!(named.len(), FULL_KEY_OPERATIONS.len() + NEEDS_PERSON.len());
        // The person's page session holds the same scopes as the full key.
        assert_eq!(sign_in::contract().scopes, sign_in::contract().full_key.holds);
    }

    #[test]
    fn presence_only_operations_stay_refused_to_the_full_key_with_their_reason() {
        let door = &sign_in::contract().door.resource;
        let full = holding(&["records", "tools"]);
        let account = holding(&["records", "tools", sign_in::contract().account_scope.as_str()]);
        for (operation, reason) in NEEDS_PERSON {
            assert!(!permits(&full, door, operation), "the full key does not reach {operation}");
            let why = needs_person(door, operation).unwrap_or_else(|| panic!("{operation} names why"));
            assert!(why.contains(reason) || why.contains("passkey"), "{operation}: {why}");
            // A key that holds the sign-in's own scope still does.
            assert!(permits(&account, door, operation));
        }
    }

    #[test]
    fn a_scoped_key_still_reaches_only_its_grant() {
        let door = &sign_in::contract().door.resource;
        for scoped in [holding(&["records"]), holding(&["tools"]), holding(&[])] {
            assert!(!full_key(&scoped));
            for operation in FULL_KEY_OPERATIONS {
                assert!(!permits(&scoped, door, operation), "{:?} does not reach {operation}", scoped.scopes);
            }
        }
        let tools = holding(&["tools"]);
        assert!(!permits(&tools, "@own-records", "records:read"));
        assert!(!permits(&tools, "@own-records", "workspace:write"));
        let records = holding(&["records"]);
        assert!(!permits(&records, "@workshop-tools", "tools:run"));
        // The full key's reach is the sign-in routes only: it widens nothing else.
        let full = holding(&["records", "tools"]);
        assert!(!permits(&full, "@other", "records:read"));
    }

    #[test]
    fn patterns_match_only_what_they_name() {
        assert!(matches("*", ""));
        assert!(matches("records:*", "records:"));
        assert!(matches("a*b*c", "aXbYc"));
        assert!(!matches("a*b*c", "aXcYb"));
        assert!(!matches("records:*", "record"));
        assert!(!matches("exact", "exactly"));
        assert!(!matches("ab*ba", "aba"));
    }

    // ---- Ported from old trillion test/authorize-sign-in-reads.test.mjs (tag old-trillion-before-worker-retire,
    // b6ae0ebf81), deleted by Trillion-X/trillion #243. The old PersonStore.authorizeSignIn is this file's `admit` over
    // the account's own sign-in database (SQLite, as `sign_in::open` keeps it), its counted database the supply's own
    // work meter (`sqlite_work::WorkMeter`: statements, rows returned and written; it counts no bytes, so the old
    // under-500-bytes check is left out). The old settings roots it cached (retired_into, deleting_since,
    // disconnected_at) are cutoffs of the current-policy evaluation (tests/mcp_current_policy/cases.rs
    // old_authorize_sign_in_reads_revocation_cutoffs_...); this check is answered by the sign-in's own rows on every
    // request, so a change stops it at once (this file's header); the old cache and rollback checks have no owner.

    fn bounds() -> crate::storage::sqlite::Bounds {
        crate::storage::sqlite::Bounds {
            value_bytes: 64 * 1024, work: 10_000_000, deadline: std::time::Duration::from_secs(5),
            spend: crate::storage::sqlite::Spend::EachOperation, cancel: None, busy: std::time::Duration::from_secs(5),
        }
    }

    /// Keeping an act grant seals this full owner's own parent credential.
    /// A narrower records/tools key is not the account's delegation owner.
    #[test]
    fn only_the_full_owner_reaches_the_sharing_owners_exact_keeper() {
        let data: serde_json::Value=serde_json::from_slice(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/account_rights/share-grant.json"))).unwrap();
        let act=&data["door_grant"]["act"];
        let (address,operation)=(act["keep_resource"].as_str().unwrap(),act["keep_operation"].as_str().unwrap());
        assert!(permits(&holding(&["records","tools"]),address,operation));
        for scopes in [&["records"][..],&["tools"][..],&["sign-in"][..],&[][..]] {
            assert!(!permits(&holding(scopes),address,operation),"a scoped key cannot keep an owner's act grant");
        }
    }

    #[test]
    #[cfg(test)]
    fn the_keeper_keeps_oauth_parent_semantics_but_never_escapes_a_runs_attenuation() {
        use crate::account::account_routes::{in_memory_with_key,connect_app_for_tests,revoke_for_tests};
        use crate::account_rights::run_capability::{self,Rights};
        let key=format!("nm_{OWNER}_{}","83".repeat(32));
        let sign_in=in_memory_with_key("synthetic-keeper-scope",OWNER,&key);
        let data: serde_json::Value=serde_json::from_slice(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/account_rights/share-grant.json"))).unwrap();
        let act=&data["door_grant"]["act"];
        let call=crate::mcp::Operation {person_present:None,resource:act["keep_resource"].as_str().unwrap().into(),
            operation:act["keep_operation"].as_str().unwrap().into(),request_key:"synthetic-keeper".into(),input:serde_json::json!({"label":"synthetic","on":true})};
        let principal=sign_in.authenticate(key.as_bytes()).unwrap();
        assert!(sign_in.caller(key.as_bytes(),&principal,&call).is_ok());
        for scope in ["records","tools"] {
            let app=connect_app_for_tests(&sign_in,scope);let principal=sign_in.authenticate(app.access.as_bytes()).unwrap();
            assert!(sign_in.caller(app.access.as_bytes(),&principal,&call).is_err());
        }
        let app=connect_app_for_tests(&sign_in,"records tools");let oauth=sign_in.authenticate(app.access.as_bytes()).unwrap();
        let caller=sign_in.caller(app.access.as_bytes(),&oauth,&call).unwrap();let kept=caller.may_keep_a_standing_grant().unwrap();
        assert!(kept.descriptor.is_some());assert_eq!(kept.sealed.as_slice(),oauth.sign_in.as_bytes());
        assert_ne!(kept.sealed.as_slice(),app.access.as_bytes(),"an access token is never kept as its parent");
        revoke_for_tests(&sign_in,&app.access);assert!(sign_in.caller(app.access.as_bytes(),&oauth,&call).is_err());
        let runs: serde_json::Value=serde_json::from_slice(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/tool_runs/tools/tool-runs.json"))).unwrap();
        let child=format!("{}synthetic-keeper-denial",runs["runs"]["id_start"].as_str().unwrap());
        let rights=Rights::declared(&serde_json::json!({"fd":3,"runs":[child]})).unwrap();
        let capability=run_capability::mint(OWNER,key.as_bytes(),rights,None,std::time::Duration::from_secs(30)).unwrap();
        let run=run_capability::held(capability.token().as_bytes()).unwrap().unwrap();
        assert!(run.narrow(&principal,&call).is_err(),"a full parent never lets a tool run keep a grant");
    }

    /// The work of each check of the keys at `asked`, after `count` keys were issued and each used once, on a store
    /// opened anew the way a restarted instance opens it: (statements, rows returned, scan visits, rows written).
    fn check_work(count: usize, asked: &[usize]) -> Vec<(u64, u64, u64, u64)> {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().canonicalize().unwrap().join("sign-in.sqlite");
        let keys: Vec<String> = {
            let storage = crate::storage::sqlite::open_owned(&path, "sign_in", bounds()).unwrap();
            crate::account::sign_in::lists::prefill(&storage, &["owner"]);
            let store = Store::new(&storage);
            let keys: Vec<String> = (0..count).map(|_| keys::issue(&store, "owner", OWNER, "Claude", &scopes(), 0).unwrap().0).collect();
            for key in &keys {
                assert!(admit(&storage, Some(&format!("Bearer {key}")), None).unwrap().is_some());
            }
            keys
        };
        let meter = crate::sqlite_work::WorkMeter::new();
        let cold = crate::storage::sqlite::open_owned_observed(&path, "sign_in", bounds(), meter.clone()).unwrap();
        asked.iter().map(|index| {
            let before = meter.snapshot().unwrap().work;
            assert!(admit(&cold, Some(&format!("Bearer {}", keys[*index])), None).unwrap().is_some());
            let after = meter.snapshot().unwrap().work;
            (after.sql_statements - before.sql_statements, after.rows_returned - before.rows_returned,
                after.sqlite_scan_visits - before.sqlite_scan_visits, after.rows_written - before.rows_written)
        }).collect()
    }

    /// Ported from old test/authorize-sign-in-reads.test.mjs, "the sign-in check reads and writes no more with four
    /// times as many sign-ins": 20 and 80 keys, each used once, the store reopened, keys 3, 3, the last and 3 checked;
    /// no check asks more statements or reads more rows at 80 than at 20, each writes the same, and a check of a key
    /// already used (within `LAST_USED_EVERY_MS` here, the old hour) asks at most 4 statements and writes nothing.
    #[test]
    fn old_authorize_sign_in_reads_the_check_reads_and_writes_no_more_with_four_times_as_many_sign_ins() {
        const SMALL: usize = 20;
        let small = check_work(SMALL, &[3, 3, SMALL - 1, 3]);
        let big = check_work(4 * SMALL, &[3, 3, 4 * SMALL - 1, 3]);
        for (index, (call, other)) in small.iter().zip(&big).enumerate() {
            assert!(other.0 <= call.0, "call {index}: {} statements at {SMALL} sign-ins, {} at {}", call.0, other.0, 4 * SMALL);
            assert!(other.1 <= call.1 && other.2 <= call.2, "call {index}: {call:?} at {SMALL} sign-ins, {other:?} at {}", 4 * SMALL);
            assert_eq!(other.3, call.3, "call {index} writes the same rows at any size");
        }
        for call in &big[1..] {
            assert!(call.0 <= 4, "a check of a sign-in already seen asks {} statements", call.0);
            assert_eq!(call.3, 0, "a check of a sign-in used recently writes nothing");
        }
    }

    /// Ported from old test/authorize-sign-in-reads.test.mjs, "real authorization answers retain invocation SQL counts
    /// on accepted and refused paths": an accepted check and a refused one (its key turned off) are both answered by a
    /// real store lookup, counted by the work meter. The old `authorization_timing.method_counts` on the answer has no
    /// owner: the count is the meter's, not the answer's.
    #[test]
    fn old_authorize_sign_in_reads_accepted_and_refused_checks_are_both_real_counted_lookups() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().canonicalize().unwrap().join("sign-in.sqlite");
        let meter = crate::sqlite_work::WorkMeter::new();
        let storage = crate::storage::sqlite::open_owned_observed(&path, "sign_in", bounds(), meter.clone()).unwrap();
        crate::account::sign_in::lists::prefill(&storage, &["owner"]);
        let store = Store::new(&storage);
        let (active, _) = keys::issue(&store, "owner", OWNER, "active", &scopes(), 0).unwrap();
        let (ended, ended_id) = keys::issue(&store, "owner", OWNER, "ended", &scopes(), 0).unwrap();
        keys::turn_off(&store, "owner", &ended_id).unwrap();
        for (key, accepted) in [(active, true), (ended, false)] {
            let before = meter.snapshot().unwrap().work.sql_statements;
            assert_eq!(admit(&storage, Some(&format!("Bearer {key}")), None).unwrap().is_some(), accepted);
            assert!(meter.snapshot().unwrap().work.sql_statements > before, "the real store lookup is counted even on a refusal");
        }
    }

    /// Ported from old test/authorize-sign-in-reads.test.mjs, "repeated missing revocation roots read once and writes or
    /// rollback take effect immediately" and "browser generation reuses an absent root and sign-out or rollback is
    /// observed immediately", in what the check owns: a key turned off is refused at once and a later key still passes;
    /// a browser signed out is refused at once, a new browser is accepted, and signing browsers out does not take back an
    /// AI's key. (Deleting the account refuses at once too: account_routes.rs `admitted`, its own test.)
    #[test]
    fn old_authorize_sign_in_reads_taking_a_sign_in_back_takes_effect_immediately() {
        let storage = storage();
        let store = Store::new(&storage);
        let (key, id) = keys::issue(&store, "owner", OWNER, "script", &scopes(), 0).unwrap();
        let bearer = format!("Bearer {key}");
        for _ in 0..8 {
            assert!(admit(&storage, Some(&bearer), None).unwrap().is_some());
        }
        assert!(keys::turn_off(&store, "owner", &id).unwrap());
        assert!(admit(&storage, Some(&bearer), None).unwrap().is_none(), "a key taken back is refused immediately");
        let (later, _) = keys::issue(&store, "owner", OWNER, "later", &scopes(), 0).unwrap();
        assert!(admit(&storage, Some(&format!("Bearer {later}")), None).unwrap().is_some(), "a later sign-in still passes");

        let old_browser = sessions::start(&store, "owner", "passkey").unwrap();
        let old_cookie = old_browser.split(';').next().unwrap().to_string();
        assert!(admit(&storage, None, Some(&old_cookie)).unwrap().is_some());
        for row in sessions::listed(&store, "owner").unwrap() {
            assert!(sessions::end_one(&store, "owner", &row.id).unwrap());
        }
        assert!(admit(&storage, None, Some(&old_cookie)).unwrap().is_none(), "the old browser is refused immediately");
        let new_browser = sessions::start(&store, "owner", "passkey").unwrap();
        assert!(admit(&storage, None, Some(new_browser.split(';').next().unwrap())).unwrap().is_some(), "a new browser is accepted");
        assert!(admit(&storage, Some(&format!("Bearer {later}")), None).unwrap().is_some(), "browser sign-out does not take back AI sign-ins");
    }
}
