// src/account_rights/run_cause.rs
//
// Purpose: The one issuer of every Workshop tool run's records pass, from the run's live cause. A run's cause is who
// started it now: the signed-in page's own session, any party's key or OAuth grant, or, for a scheduled run, the party
// that wrote the rule row causing it (a wake it switched on, a rule's send, or a run's own child of those). The pass is
// minted at the moment of the run, short-lived, for exactly what the cause may reach now ∩ what the row declares
// (`invoke.records`); every call it makes is admitted again as that cause at the account's routes, so a cause that ends
// (signed out, key turned off, app disconnected, party without rights) stops the run at its next call. Nothing is kept
// ahead of time: no key, no grant, no vault entry. The pass names no tool, page or kind of party.
//
// Non-Negotiable Invariants:
// - A cause is named by its name (`session:`, `key:`, `grant:` or `party:`, `account_routes::SignIn::standing`), never
//   by a credential; a name no sign-in or party stands under now issues nothing.
// - A pass never exceeds the row's declaration nor the cause's own rights: the account routes decide every call as the
//   cause (`SignInParent` in native_boot/mcp_local.rs).
// - A run's own scheduled child is never wider than its root: its pass is bounded by what the root row declares now
//   (`Root`); a child whose root row is gone gets nothing.
// - No branch on the kind of party: a person, an organisation and an AI reach through the same names and the same check.
// - The issuer never takes the account's owner: whether a cause still stands is read from the account's sign-in alone,
//   so a run asked while a call holds the owner answers (the owner deadlock class).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::run_capability::{issue_from_authority, Issued, Issuer, ParentAuthority, ParentKey, Refusal, Rights, Route};
use crate::wake::{Declared, Failure as WakeFailure, Source, Waker};
use serde_json::{json, Value};
use std::{collections::HashMap, fmt, net::SocketAddr, sync::{Arc, Mutex, OnceLock, Weak}, time::Duration};

/// The account's own routes, which resolve a cause's name into its owned parent. Only an owner installed on this
/// account's routes can resolve one; opaque DATA cannot create an authority callback.
pub trait ParentResolver: Send + Sync {
    /// The live cause of a run, named by its name (`account_routes::SignIn::standing`): the same owned parent for
    /// every party, admitted again as that cause at every call. Nothing is read from any vault.
    fn resolve_cause(&self, _account: &str, _cause: &str) -> Result<Arc<dyn ParentAuthority>, Refusal> {
        Err(crate::cause!(Refusal::Unavailable))
    }
    /// This account's own loopback routes address, supplied by its native listener.
    fn door(&self) -> Option<SocketAddr> { None }
}
fn resolvers() -> &'static Mutex<HashMap<String, Weak<dyn ParentResolver>>> {
    static RESOLVERS: OnceLock<Mutex<HashMap<String, Weak<dyn ParentResolver>>>> = OnceLock::new();
    RESOLVERS.get_or_init(|| Mutex::new(HashMap::new()))
}
/// The account routes' resolver lifetime. Dropping it removes only that exact installed
/// owner, so older routes cannot remove a replacement account's resolver.
pub struct ResolverRegistration { account: String, resolver: Arc<dyn ParentResolver> }
impl Drop for ResolverRegistration {
    fn drop(&mut self) {
        if let Ok(mut owners) = resolvers().lock() {
            if owners.get(&self.account).is_some_and(|held| held.ptr_eq(&Arc::downgrade(&self.resolver))) {
                owners.remove(&self.account);
            }
        }
    }
}
/// Install this account's existing local routes' authority owner for its runs. No credential, route or account is
/// created by registration.
pub fn register_resolver(account: &str, resolver: Arc<dyn ParentResolver>) -> Result<ResolverRegistration, Refusal> {
    if account.is_empty() { return Err(crate::cause!(Refusal::Undeclared)); }
    resolvers().lock().map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?.insert(account.into(), Arc::downgrade(&resolver));
    Ok(ResolverRegistration { account: account.into(), resolver })
}

/// The owned parent of a run's live cause `cause` on `account`, from the account's registered routes.
pub fn resolve_cause(account: &str, cause: &str) -> Result<Arc<dyn ParentAuthority>, Refusal> {
    let resolver = resolvers().lock().map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?
        .get(account).and_then(Weak::upgrade).ok_or(crate::cause!(Refusal::Unavailable))?;
    resolver.resolve_cause(account, cause)
}

/// The admitted account's running local routes address, never a port inferred from the
/// request or a product default. Remote tool runs use this same listener.
pub fn local_door(account: &str) -> Option<SocketAddr> {
    resolvers().lock().ok()?.get(account)?.upgrade()?.door().filter(|door| door.ip().is_loopback())
}

/// Why a switch did not happen: its input or the tool's declaration (`Input`), or the store did not answer.
#[derive(Clone, Debug)]
pub enum SwitchFailure {
    Input(crate::refusal_cause::Cause),
    Unavailable(crate::refusal_cause::Cause),
}
impl SwitchFailure { pub fn cause(&self) -> crate::refusal_cause::Cause { match self {
Self::Input(cause)=>cause.clone(),
Self::Unavailable(cause)=>cause.clone(),
} } }
crate::impl_caused!(SwitchFailure);
impl PartialEq for SwitchFailure {fn eq(&self, other:&Self)->bool {std::mem::discriminant(self)==std::mem::discriminant(other)}}
impl Eq for SwitchFailure {}

/// One wake switch a party asked for: `id` of `tool`, on or off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Switch<'a> {
    pub tool: &'a str,
    pub id: &'a str,
    pub on: bool,
}
impl<'a> Switch<'a> {
    /// A wake switch call's input: exactly `{tool, id, on}`.
    pub fn asked(input: &'a Value) -> Option<Self> {
        let fields = input.as_object().filter(|fields| fields.len() == 3)?;
        let text = |name: &str| fields.get(name).and_then(Value::as_str).filter(|text| !text.is_empty());
        Some(Switch { tool: text("tool")?, id: text("id")?, on: fields.get("on")?.as_bool()? })
    }
}

/// The account's wakes as wake reads them: its owner, the account its book is kept under and the wakes declared now.
#[derive(Clone, Copy)]
pub struct Wakes<'a> {
    pub waker: &'a Waker,
    pub account: &'a str,
    pub declared: &'a [Declared],
}

/// Apply `asked` on the wake book in `source`, the switch written by the party whose cause name is `by`
/// (`account_routes::SignIn::party_of`): that party is what the wake's runs act as from then on (`CauseIssuer`),
/// whichever of its sign-ins it arrived through. Nothing else is kept.
pub fn switch(wakes: &Wakes<'_>, source: &mut dyn Source, asked: Switch<'_>, by: &str) -> Result<(), SwitchFailure> {
    let Wakes { waker, account, declared } = *wakes;
    waker.switch(account, source, declared, asked.tool, asked.id, asked.on, by).map_err(|failure| {
        if matches!(failure, WakeFailure::Data(_)) { SwitchFailure::Input(failure.cause()) } else { SwitchFailure::Unavailable(failure.cause()) }
    })
}

/// The root a run's own scheduled child was made under: the root tool row's `invoke.records` as declared now (none
/// when that row declares none or is gone), which bounds the child.
#[derive(Clone, Copy, Debug)]
pub struct Root<'a> {
    pub records: Option<&'a Value>,
}

/// The issuer of one run from its live cause `cause_name` (`session:`, `key:`, `grant:` or `party:`), for the run whose
/// wake cause key is `cause` (none for a page run), bounded by its root (`root`, a scheduled child only), calling back
/// to the account's own loopback `route`.
#[derive(Clone, Copy)]
pub struct CauseIssuer<'a> {
    pub account: &'a str,
    pub sign_in: &'a str,
    pub cause: Option<&'a str>,
    pub route: &'a Route,
    pub root: Option<Root<'a>>,
}
impl fmt::Debug for CauseIssuer<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CauseIssuer([redacted])")
    }
}
impl CauseIssuer<'_> {
    /// The cause's owned parent, standing now on this account.
    fn parent(&self) -> Result<Arc<dyn ParentAuthority>, Refusal> {
        let parent = resolve_cause(self.account, self.sign_in)?;
        match parent.authenticate() {
            Ok(principal) if principal.valid() && principal.account_id == self.account => Ok(parent),
            Err(crate::mcp::http::AuthenticationFailure::Unavailable(cause)) => Err(Refusal::Unavailable(cause)),
            _ => Err(crate::cause!(Refusal::NotGranted)),
        }
    }
    /// What a scheduled child's root declares now; none for a root run.
    fn bound(&self) -> Result<Option<Rights>, Refusal> {
        self.root.map(|root| Rights::declared(root.records.ok_or(crate::cause!(Refusal::NotGranted))?)).transpose()
    }
}
impl Issuer for CauseIssuer<'_> {
    fn issue(&self, records: &Value, lifetime: Duration) -> Result<Issued, Refusal> {
        let bound = self.bound()?;
        let authority = self.parent()?;
        let parent = ParentKey { account: self.account, address: &self.route.address, bearer: self.sign_in.as_bytes(),
            door: self.route.door, cause: self.cause };
        issue_from_authority(&parent, records, bound.as_ref(), lifetime, authority)
    }

    fn recovery_source(&self) -> Result<Value, Refusal> {
        let bound = self.bound()?;
        let source = self.parent()?.recovery_source()?;
        Ok(json!({"account_id": self.account, "parent": source, "cause": self.cause,
            "root": bound.map(|rights| rights.recovery_witness())}))
    }

    fn task_context(&self) -> Option<crate::tool_runs::tools::task_context::Context> {
        use crate::tool_runs::tools::task_context::Context;
        let denied = || Some(Context::account_at(self.account, Arc::new(|| false)));
        if self.bound().is_err() { return denied(); }
        let Ok(parent) = self.parent() else { return denied() };
        let Ok(principal) = parent.authenticate() else { return denied() };
        let current = Arc::new(move || parent.authenticate().is_ok_and(|now| now.valid()
            && now.account_id == principal.account_id && now.sign_in == principal.sign_in));
        Some(Context::account_at(self.account, current))
    }
}

#[cfg(test)]
mod tests;
