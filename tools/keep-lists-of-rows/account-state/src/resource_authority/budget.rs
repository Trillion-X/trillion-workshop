//! Generic finite resource holds, independent of tariffs, providers and money.
//!
//! This is the native equivalent of the old credit/permit owner: reserve an
//! upper bound atomically, durably mark dispatch, and settle one immutable
//! completion. Unknown work, lost replies, expiry and dropped handles retain
//! the bound. A physical retry needs another hold; replaying a hold returns
//! its state and never a second dispatch capability.
//!
//! Only the trusted host may capture grants. Client rights, editable account
//! balances, migrated quota rows and physical observation journals are NOT
//! funding authority. A host must supply a protected record store resource (outside
//! customer writes), globally unique captured grant identity, and current
//! policy checks. Reopening a grant requires exactly the same captured terms.
//! No commercial prices, markup or provider branches belong here.

use crate::{
    records::{Error as RecordError, Mutation, Records},
    storage::{record_store::RecordStore, Storage},
};
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

/// The account files byte allowance's chunk supply (one hold per chunk, never per read).
pub mod account_files;
/// Protected, signature-verified host capture and revocation owner. Commercial
/// funding effects are issued outside the engine; access grants are not accepted.
pub mod funding;

const MAX_HOLDS: usize = 1024;
const CAS_ATTEMPTS: usize = 32;

#[derive(Debug, Clone)]
pub enum Error {
    Invalid(crate::refusal_cause::Cause),
    Authority(crate::refusal_cause::Cause),
    Exhausted(crate::refusal_cause::Cause),
    Conflict(crate::refusal_cause::Cause),
    Unavailable(crate::refusal_cause::Cause),
    Unknown(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Authority(cause) => cause.clone(),
            Self::Conflict(cause) => cause.clone(),
            Self::Exhausted(cause) => cause.clone(),
            Self::Invalid(cause) => cause.clone(),
            Self::Unavailable(cause) => cause.clone(),
            Self::Unknown(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Error);
impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for Error {}


/// A company-funded grant must name an actual captured funding effect; this
/// string alone is not evidence: HostPolicy must attest its source and bound.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Payer {
    Funded { funding_identity: String },
    External,
}

/// Immutable finite grant terms, selected by a trusted host, never from a
/// customer's claim of entitlement. `basis` identifies the operation/origin
/// scope; `unit` is an opaque integer resource unit, not a retail currency.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Terms {
    pub grant: String,
    pub account: String,
    /// Host-selected protected, declared state resource; never customer own-records.
    pub resource: String,
    pub basis: String,
    pub unit: String,
    pub payer: Payer,
    pub limit: u64,
    pub expires_at_ms: i64,
}

/// Implemented by the trusted funding/host-policy owner. `capture` must verify
/// supplier funding (or the external payer) and prevent minting the same
/// funding twice under different grant IDs. `current` is synchronous, local,
/// includes the clock/revision/revocation and runs INSIDE the storage check.
/// Revocation stops dispatch, not the obligation to keep terminal receipts.
/// Reconciliation requires independent trusted evidence, never a timeout.
pub trait HostPolicy: Send + Sync {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|d| i64::try_from(d.as_millis()).ok())
            .unwrap_or(i64::MAX)
    }
    fn capture(&self, terms: &Terms) -> bool;
    fn current(&self, terms: &Terms) -> bool;
    /// Separate host-only recovery read authority. Expiry/revocation of work
    /// admission must not make orphaned holds undiscoverable to their owner.
    fn recovery_current(&self, _terms: &Terms) -> bool {
        false
    }
    fn reconcile(
        &self,
        _terms: &Terms,
        _hold: &str,
        _prior: &View,
        _units: u64,
        _evidence: &str,
    ) -> bool {
        false
    }
}

/// Cannot be deserialized from an own-record or a public request.
pub struct CapturedGrant {
    terms: Terms,
    policy: Arc<dyn HostPolicy>,
}
impl CapturedGrant {
    pub fn capture(terms: Terms, policy: Arc<dyn HostPolicy>) -> Result<Self, Error> {
        let grant = Self::restore(terms, policy)?;
        if grant.policy.now_ms() < 0
            || grant.policy.now_ms() >= grant.terms.expires_at_ms
            || !grant.policy.current(&grant.terms)
        {
            return Err(crate::cause!(Error::Authority));
        }
        Ok(grant)
    }
    /// Restore only host-attested immutable grant terms after a restart, even
    /// after revocation or expiry. This permits receipt recovery, never new
    /// dispatch: reserve/start still enforce current authority and expiry.
    pub fn restore(terms: Terms, policy: Arc<dyn HostPolicy>) -> Result<Self, Error> {
        if [
            &terms.grant,
            &terms.account,
            &terms.resource,
            &terms.basis,
            &terms.unit,
        ]
        .iter()
        .any(|s| !valid(s))
            || terms.resource == "own-records"
            || terms.limit == 0
            || terms.expires_at_ms <= 0
            || matches!(&terms.payer, Payer::Funded { funding_identity } if !valid(funding_identity))
            || !policy.capture(&terms)
        {
            return Err(crate::cause!(Error::Authority));
        }
        Ok(Self { terms, policy })
    }
}
fn valid(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= 512 && !s.chars().any(char::is_control)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum State {
    Reserved,
    Started,
    Unknown {
        observed: Option<u64>,
        evidence: String,
    },
    Settled {
        units: u64,
        evidence: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct View {
    pub identity: String,
    pub bound: u64,
    pub state: State,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Book {
    terms: Terms,
    held: u64,
    used: u64,
    #[serde(rename = "leases")] holds: BTreeMap<String, View>,
}

struct Inner<S: Storage> {
    store: Mutex<RecordStore<S>>,
    grant: CapturedGrant,
}
pub struct Owner<S: Storage>(Arc<Inner<S>>);
impl<S: Storage> Clone for Owner<S> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

/// A replay carries no dispatch capability. A New hold is non-cloneable.
pub enum Reservation<S: Storage> {
    New(Hold<S>),
    Existing(View),
}
pub struct Hold<S: Storage> {
    owner: Owner<S>,
    id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Totals {
    pub held: u64,
    pub used: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveryPage {
    pub totals: Totals,
    pub holds: Vec<(String, View)>,
    pub next: Option<String>,
}

impl<S: Storage + Send> Owner<S> {
    /// Storage must be protected from the customer and shared by every host
    /// spending this grant. A copied account book cannot become another grant.
    pub fn new(store: RecordStore<S>, grant: CapturedGrant) -> Self {
        Self(Arc::new(Inner {
            store: Mutex::new(store),
            grant,
        }))
    }
    pub fn terms(&self) -> &Terms {
        &self.0.grant.terms
    }
    fn id(&self) -> String {
        blake3::hash(self.terms().grant.as_bytes())
            .to_hex()
            .to_string()
    }
    fn current(&self) -> Result<(), Error> {
        if self.0.grant.policy.now_ms() >= 0
            && self.0.grant.policy.now_ms() < self.terms().expires_at_ms
            && self.0.grant.policy.current(self.terms())
        {
            Ok(())
        } else {
            Err(crate::cause!(Error::Authority))
        }
    }
    fn load(&self, store: &RecordStore<S>) -> Result<(i64, Book), Error> {
        let row = store
            .get(&self.terms().account, &self.terms().resource, &self.id())
            .map_err(map_error)?
            .record;
        let Some(row) = row else {
            return Ok((
                0,
                Book {
                    terms: self.terms().clone(),
                    held: 0,
                    used: 0,
                    holds: BTreeMap::new(),
                },
            ));
        };
        let book: Book = serde_json::from_value(row.value).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if book.terms != *self.terms() {
            return Err(crate::cause!(Error::Conflict));
        }
        // Do not trust corrupt counters even inside the protected resource.
        let (mut held, mut used) = (0u64, 0u64);
        for hold in book.holds.values() {
            match hold.state {
                State::Settled { units, .. } => {
                    if units > hold.bound {
                        return Err(crate::cause!(Error::Invalid));
                    }
                    used = used.checked_add(units).ok_or(crate::cause!(Error::Invalid))?;
                }
                _ => held = held.checked_add(hold.bound).ok_or(crate::cause!(Error::Invalid))?,
            }
        }
        if (held, used) != (book.held, book.used)
            || held.checked_add(used).ok_or(crate::cause!(Error::Invalid))? > book.terms.limit
        {
            return Err(crate::cause!(Error::Invalid));
        }
        Ok((row.version, book))
    }
    fn change<R>(
        &self,
        fresh: bool,
        mut edit: impl FnMut(&mut Book) -> Result<R, Error>,
        mut check: impl FnMut() -> Result<(), Error>,
    ) -> Result<R, Error> {
        let mut store = self.0.store.lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        for _ in 0..CAS_ATTEMPTS {
            if fresh {
                self.current()?;
            }
            let (version, mut book) = self.load(&store)?;
            let result = edit(&mut book)?;
            let value = serde_json::to_value(&book).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
            let encoded = serde_json::to_vec(&(version, &value)).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
            // Exact successor identity; retry after an ambiguous commit reads
            // the kept state rather than applying an arithmetic delta again.
            let request_key = blake3::hash(&encoded).to_hex().to_string();
            let mutation = Mutation {
                id: self.id(),
                expected_version: version,
                request_key,
                deleted: false,
                value,
            };
            let mut refused = None;
            match store.mutate_local_with_check(
                &self.terms().account,
                &self.terms().resource,
                mutation,
                || {
                    let still = if fresh { self.current() } else { Ok(()) }.and_then(|_| check());
                    still.map_err(|error| {
                        let cause = error.cause();
                        refused = Some(error);
                        RecordError::Unavailable(cause)
                    })
                },
            ) {
                Ok(_) => return Ok(result),
                Err(RecordError::Conflict(_)) => continue,
                Err(error) => return Err(refused.unwrap_or_else(|| map_error(error))),
            }
        }
        Err(crate::cause!(Error::Conflict))
    }
    pub fn reserve(&self, id: &str, identity: &str, bound: u64) -> Result<Reservation<S>, Error> {
        if !valid(id) || !valid(identity) || bound == 0 {
            return Err(crate::cause!(Error::Invalid));
        }
        let existing = self.change(
            true,
            |book| {
                if let Some(old) = book.holds.get(id) {
                    return if old.identity == identity && old.bound == bound {
                        Ok(Some(old.clone()))
                    } else {
                        Err(crate::cause!(Error::Conflict))
                    };
                }
                if book.holds.len() >= MAX_HOLDS {
                    return Err(crate::cause!(Error::Exhausted));
                }
                let total = book
                    .held
                    .checked_add(book.used)
                    .and_then(|n| n.checked_add(bound))
                    .ok_or(crate::cause!(Error::Exhausted))?;
                if total > book.terms.limit {
                    return Err(crate::cause!(Error::Exhausted));
                }
                book.held += bound;
                book.holds.insert(
                    id.into(),
                    View {
                        identity: identity.into(),
                        bound,
                        state: State::Reserved,
                    },
                );
                Ok(None)
            },
            || Ok(()),
        )?;
        Ok(match existing {
            Some(view) => Reservation::Existing(view),
            None => Reservation::New(Hold {
                owner: self.clone(),
                id: id.into(),
            }),
        })
    }
    pub fn view(&self, id: &str) -> Result<Option<View>, Error> {
        self.current()?;
        let store = self.0.store.lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let (_, book) = self.load(&store)?;
        self.current()?;
        Ok(book.holds.get(id).cloned())
    }
    pub fn totals(&self) -> Result<Totals, Error> {
        self.current()?;
        let store = self.0.store.lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let (_, book) = self.load(&store)?;
        self.current()?;
        Ok(Totals {
            held: book.held,
            used: book.used,
        })
    }
    /// Discover abandoned holds after a restart through independent host
    /// recovery authority. A page never returns a dispatch capability.
    pub fn recovery_page(&self, after: &str, limit: usize) -> Result<RecoveryPage, Error> {
        if limit == 0 || limit > 100 || (!after.is_empty() && !valid(after)) {
            return Err(crate::cause!(Error::Invalid));
        }
        let allowed = || self.0.grant.policy.recovery_current(self.terms());
        if !allowed() {
            return Err(crate::cause!(Error::Authority));
        }
        let store = self.0.store.lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let (_, book) = self.load(&store)?;
        let mut holds = book
            .holds
            .into_iter()
            .filter(|(id, _)| id.as_str() > after);
        let page: Vec<_> = holds.by_ref().take(limit).collect();
        let next = holds
            .next()
            .and_then(|_| page.last().map(|(id, _)| id.clone()));
        if !allowed() {
            return Err(crate::cause!(Error::Authority));
        }
        Ok(RecoveryPage {
            totals: Totals {
                held: book.held,
                used: book.used,
            },
            holds: page,
            next,
        })
    }
    /// Recovery cannot mint another dispatch permit. Only host-attested
    /// terminal evidence can close started/unknown work after a crash.
    pub fn reconcile(&self, id: &str, units: u64, evidence: &str) -> Result<(), Error> {
        if !valid(evidence) {
            return Err(crate::cause!(Error::Invalid));
        }
        let captured = std::cell::RefCell::new(None);
        self.change(
            false,
            |book| {
                let old = book.holds.get(id).ok_or(crate::cause!(Error::Invalid))?.clone();
                *captured.borrow_mut() = Some(old.clone());
                if !self
                    .0
                    .grant
                    .policy
                    .reconcile(self.terms(), id, &old, units, evidence)
                {
                    return Err(crate::cause!(Error::Authority));
                }
                settle(book, id, units, evidence)
            },
            || {
                let prior = captured.borrow();
                if prior.as_ref().is_some_and(|prior| {
                    self.0
                        .grant
                        .policy
                        .reconcile(self.terms(), id, prior, units, evidence)
                }) {
                    Ok(())
                } else {
                    Err(crate::cause!(Error::Authority))
                }
            },
        )
    }
}
fn map_error(error: RecordError) -> Error {
    match error {
        RecordError::Conflict(cause) => Error::Conflict(cause),
        RecordError::OutcomeUnknown(cause) => Error::Unknown(cause),
        error => Error::Unavailable(error.cause()),
    }
}
fn settle(book: &mut Book, id: &str, units: u64, evidence: &str) -> Result<(), Error> {
    let view = book.holds.get_mut(id).ok_or(crate::cause!(Error::Invalid))?;
    if let State::Settled {
        units: old,
        evidence: ref prior,
    } = view.state
    {
        return if old == units && prior == evidence {
            Ok(())
        } else {
            Err(crate::cause!(Error::Conflict))
        };
    }
    if units > view.bound
        || matches!(view.state, State::Unknown { observed: Some(n), .. } if units < n)
    {
        return Err(crate::cause!(Error::Invalid));
    }
    book.held = book.held.checked_sub(view.bound).ok_or(crate::cause!(Error::Invalid))?;
    book.used = book.used.checked_add(units).ok_or(crate::cause!(Error::Invalid))?;
    view.state = State::Settled {
        units,
        evidence: evidence.into(),
    };
    Ok(())
}
impl<S: Storage + Send> Hold<S> {
    pub fn id(&self) -> &str {
        &self.id
    }
    /// Persist before dispatch. Never callable twice, even for identical input.
    pub fn start(&self) -> Result<(), Error> {
        self.owner.change(
            true,
            |book| {
                let view = book.holds.get_mut(&self.id).ok_or(crate::cause!(Error::Invalid))?;
                if view.state != State::Reserved {
                    return Err(crate::cause!(Error::Conflict));
                }
                view.state = State::Started;
                Ok(())
            },
            || Ok(()),
        )
    }
    /// Explicit no-dispatch release. Expiry/drop never calls this implicitly.
    pub fn release_unstarted(&self) -> Result<(), Error> {
        self.owner.change(false, |book| {
            let state = &book.holds.get(&self.id).ok_or(crate::cause!(Error::Invalid))?.state;
            if matches!(state, State::Settled { units: 0, evidence } if evidence == "not-dispatched") { return Ok(()); }
            if *state != State::Reserved { return Err(crate::cause!(Error::Conflict)); }
            settle(book, &self.id, 0, "not-dispatched")
        }, || Ok(()))
    }
    /// Terminal observation remains writable after revocation. A partial or
    /// unknown result retains the WHOLE bound, with observed work kept apart.
    pub fn finish(
        &self,
        observed: Option<u64>,
        terminal: bool,
        evidence: &str,
    ) -> Result<(), Error> {
        if !valid(evidence) {
            return Err(crate::cause!(Error::Invalid));
        }
        self.owner.change(
            false,
            |book| {
                let view = book.holds.get_mut(&self.id).ok_or(crate::cause!(Error::Invalid))?;
                if terminal {
                    if view.state == State::Reserved {
                        return Err(crate::cause!(Error::Conflict));
                    }
                    return settle(book, &self.id, observed.ok_or(crate::cause!(Error::Invalid))?, evidence);
                }
                if observed.is_some_and(|n| n > view.bound) {
                    return Err(crate::cause!(Error::Invalid));
                }
                match view.state {
                    State::Started => {
                        view.state = State::Unknown {
                            observed,
                            evidence: evidence.into(),
                        }
                    }
                    State::Unknown {
                        observed: prior,
                        evidence: ref old,
                    } if prior == observed && old == evidence => {}
                    _ => return Err(crate::cause!(Error::Conflict)),
                }
                Ok(())
            },
            || Ok(()),
        )
    }
}
