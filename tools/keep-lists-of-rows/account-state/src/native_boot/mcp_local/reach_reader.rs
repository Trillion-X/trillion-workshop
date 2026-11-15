// src/native_boot/mcp_local/reach_reader.rs
//
// Purpose: The in-process reader of a key-free reach share (`account_rights::share_grant::Collection`). A share bearer has no
// key of the sharer's to act as, so its reads are the account owner's own records reads (`records_read_at`, the door's one
// reader, opening records under the installed model exactly as a person's key read does and refusing a kind that stays on this
// computer to a remote reader), made as a caller admitted by one check only: that the bearer's reach still stands in the
// sharer's sharing records, read again at every check. Two doors lead here: the bearer at the account's records door
// (`reach_door_at`) and the public link's page and data address (`public_collection`).
//
// Non-Negotiable Invariants:
// - A call is made only inside the reach (`Collection::covers`), whatever the caller asked; any other call of a reach bearer
//   is refused as not granted.
// - The caller's currency re-reads the sharing records every time it is asked: removing a person, revoking, expiring or
//   changing the reach ends the read at once. It holds a separate admission owner, never the one the read holds.
// - A reach naming a kind that stays on this computer is no share (`kinds_stay_here`), asked before any read.
// - A public collection is read one page per request, each with its own disclosure (a disclosure holds one body custody); a record
//   too big for one message is joined from its byte pages and checked against their length and BLAKE3.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{refusal, refusal_from, LocalSelectedMcp};
use crate::{
    account::account_routes::{Caller, Current},
    account_rights::share_grant::{Collection, Grants, Read},
    mcp::{Operation, OperationFailure, RequestDisclosure},
    workspace_session::owner_wait,
};
use std::{
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::Instant,
};

/// Refusals that say the reach is not one this bearer may read, as opposed to a read that could not be made now.
const REFUSED: [&str; 3] = ["current_workspace_rights_refused", "original_input_refused", "kind_stays_on_this_computer"];

impl LocalSelectedMcp {
    /// The one reach share `bearer` reaches now, with the account it is on, read from this account's sharing records.
    fn reach_now(&self, grants: &Grants, bearer: &[u8], cancel: Arc<AtomicBool>, deadline: Instant,
    ) -> Result<(Option<Collection>, String), OperationFailure> {
        use crate::account::NativeAccountOwner;
        let mut selected = owner_wait::acquire(&self.admission, || {
            cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline
        })
        .map_err(|error| refusal_from(error, "selected_owner_unavailable", false))?;
        let account = selected.account().owner_id;
        let sharing = selected.sharing_records(grants, cancel, deadline)?;
        Ok((grants.collection(&sharing, bearer, chrono::Utc::now()), account))
    }

    /// Whether any kind `collection` reaches stays on this computer: then it is no share. Asked of the account's read owner,
    /// which no writer holds.
    fn kinds_stay_here(&self, collection: &Collection, cancel: &AtomicBool, deadline: Instant) -> bool {
        let Ok(selected) = owner_wait::acquire(&self.admission, || {
            cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline
        }) else { return true };
        let (_, state_root) = selected.tool_place();
        collection.kinds().iter().any(|kind| crate::record_model_policy::stays_on_this_device(&state_root, kind))
    }

    /// The caller a reach share reads as: the bearer's own principal, admitted while `collection`'s reach still stands in
    /// the sharer's sharing records (read afresh on a separate admission owner at every check).
    fn reach_caller(&self, grants: &'static Grants, account: &str, bearer: &[u8], collection: &Collection,
        cancel: Arc<AtomicBool>, deadline: Instant,
    ) -> Result<Caller, OperationFailure> {
        use crate::account::NativeAccountOwner;
        let digest = grants.digest(bearer).ok_or_else(|| refusal("current_workspace_rights_refused", false))?;
        let admission = {
            let owner = owner_wait::acquire(&self.admission, || {
                cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline
            })
            .map_err(|error| refusal_from(error, "current_workspace_rights_refused", false))?;
            Arc::new(Mutex::new(owner.admission_owner().map_err(|error| refusal_from(error, "current_workspace_rights_refused", false))?))
        };
        let (expected, account_id) = (collection.clone(), account.to_owned());
        let bearer_copy = zeroize::Zeroizing::new(bearer.to_vec());
        let current: Current = Arc::new(move || {
            if cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline {
                return false;
            }
            let Ok(mut selected) = owner_wait::acquire(&admission, || {
                cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline
            }) else { return false };
            if selected.account().owner_id != account_id {
                return false;
            }
            let Ok(sharing) = selected.sharing_records(grants, cancel.clone(), deadline) else { return false };
            grants.collection(&sharing, &bearer_copy, chrono::Utc::now()).is_some_and(|now| now.same_reach(&expected))
        });
        Ok(Caller::for_share(grants.principal(account, &digest), bearer, current))
    }

    /// One read of the door's records (`listing`: a list of one kind, else one record) as `caller`, an answer joined from its
    /// byte pages when one record does not fit one message. Each page is read with its own disclosure.
    fn reach_read(&self, caller: &Caller, listing: bool, input: &serde_json::Value, key: &str, disclosure: Option<&RequestDisclosure>,
    ) -> Result<serde_json::Value, OperationFailure> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let door = crate::record_value::account_routes::Door::shipped()
            .map_err(|error| refusal_from(error, "current_source_unavailable", false))?;
        let operation = if listing { door.list_operation() } else { door.read_operation() };
        let (mut joined, mut after) = (Vec::<u8>::new(), None::<u64>);
        loop {
            let mut asked = input.clone();
            if let Some(after) = after {
                asked["after_byte"] = serde_json::json!(after);
            }
            let call = Operation { resource: door.resource().to_owned(), operation: operation.to_owned(),
                request_key: key.to_owned(), input: asked, person_present: None };
            let answer = match disclosure {
                Some(disclosure) if after.is_none() => self.records_read_at(caller, &call, true, disclosure, None)?,
                _ => self.records_read_at(caller, &call, true, &RequestDisclosure::default(), None)?,
            };
            let Some(page) = answer.get("byte_page") else { return Ok(answer) };
            let unreadable = || refusal("original_read_output_unavailable", false);
            let offset = page["offset"].as_u64().ok_or_else(unreadable)?;
            if usize::try_from(offset).ok() != Some(joined.len()) {
                return Err(unreadable());
            }
            joined.extend(STANDARD.decode(page["base64"].as_str().ok_or_else(unreadable)?).map_err(|_| unreadable())?);
            match page["next_after_byte"].as_u64() {
                Some(next) => after = Some(next),
                None => {
                    let hash = content_crypto::advanced::blake3::hash(&joined).to_hex();
                    if page["total"].as_u64() != Some(joined.len() as u64) || page["blake3"].as_str() != Some(hash.as_str()) {
                        return Err(unreadable());
                    }
                    return serde_json::from_slice(&joined).map_err(|_| unreadable());
                }
            }
        }
    }

    /// A share bearer's call at the account's records door, when it reaches a reach share: None for a bearer that reaches
    /// none (its other shapes answer it). Inside the reach the read is made as the owner's records read; anything else
    /// is refused as not granted.
    pub(super) fn reach_door_at(&self, grants: &'static Grants, bearer: &[u8], call: &Operation,
        disclosure: &RequestDisclosure, deadline_override: Option<Instant>,
    ) -> Option<Result<serde_json::Value, OperationFailure>> {
        let not_granted = || refusal("current_workspace_rights_refused", false);
        let limit = disclosure.started_at() + crate::legacy_records::Bounds::default().elapsed;
        let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
        let cancel = disclosure.cancellation_flag();
        let (collection, account) = match self.reach_now(grants, bearer, cancel.clone(), deadline) {
            Ok((Some(collection), account)) => (collection, account),
            Ok((None, _)) => return None,
            Err(failure) => return Some(Err(failure)),
        };
        Some((|| {
            let door = crate::record_value::account_routes::Door::shipped()
                .map_err(|error| refusal_from(error, "current_source_unavailable", false))?;
            if call.resource != door.resource() || call.request_key.is_empty() || call.request_key.encode_utf16().count() > 512 {
                return Err(not_granted());
            }
            let listing = call.operation == door.list_operation();
            if !(listing || call.operation == door.read_operation())
                || !collection.covers(grants, listing, &call.input)
                || self.kinds_stay_here(&collection, &cancel, deadline)
            {
                return Err(not_granted());
            }
            let caller = self.reach_caller(grants, &account, bearer, &collection, cancel, deadline)?;
            self.records_read_at(&caller, call, true, disclosure, deadline_override)
        })())
    }

    /// The collection the public link or person's code `code` opens now: None when it reaches no open reach share (or a
    /// reach the reader refuses), else the collection's answer.
    pub(super) fn public_collection(&self, grants: &'static Grants, code: &str, deadline: Instant,
    ) -> Result<Option<Option<serde_json::Value>>, OperationFailure> {
        let cancel = Arc::new(AtomicBool::new(false));
        let (collection, account) = self.reach_now(grants, code.as_bytes(), cancel.clone(), deadline)?;
        let Some(collection) = collection else { return Ok(None) };
        if self.kinds_stay_here(&collection, &cancel, deadline) {
            return Ok(Some(None));
        }
        let caller = self.reach_caller(grants, &account, code.as_bytes(), &collection, cancel, deadline)?;
        let counter = std::cell::Cell::new(0u32);
        let answered = collection.answer(grants, |listing, input| {
            counter.set(counter.get() + 1);
            let key = format!("share-reach-{}-{}", collection.label(), counter.get());
            let disclosure = RequestDisclosure::default();
            match self.reach_read(&caller, listing, &input, &key, Some(&disclosure)) {
                Ok(answer) => Read::Records(answer),
                Err(failure) if REFUSED.contains(&failure.code.as_str()) => Read::OutsideReach,
                Err(_) => Read::CannotRead,
            }
        });
        match answered {
            Read::Records(answer) => Ok(Some(Some(answer))),
            Read::OutsideReach => Ok(Some(None)),
            Read::CannotRead => Err(refusal("original_workspace_source_unavailable", false)),
        }
    }
}
