// src/resource_authority.rs
//
// Purpose: Admit scoped addressed operations and dispatch them through independently supplied resource and authority contracts.
//
// Non-Negotiable Invariants:
// - Connection claims never establish client rights or resource ownership.
// - Keep policy independent of concrete storage providers.
// - Recheck current route, rights and deadline inside actual commitment and before retry-result disclosure.
//
// Key Concepts:
// - Admitted immutable input, route generations and client-owned retry identity.
// - CurrentClient, ClientAuthority and supplied record commitment.
//
// Security Considerations:
// - Refuse malformed or oversized messages, absent authority, expired grants and revoked clients.
// - Retain the original request key when an effect is unknown.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Purpose: admit addressed operations using current scoped client authority.
//! Invariants: connection claims are not authority; policy has no provider import.
//! The supplied resource must recheck inside its actual commitment transaction
//! and before recovered-receipt disclosure. Missing authority refuses all work.
//! Key concepts: route generation, client-owned retry identity and fresh rights.
//! Security: bounded proof/message, exact scope, deadline and revocation checks;
//! unknown effects preserve the original retry identity rather than rerunning.
#[path = "../../keep-lists-of-rows/account-state/src/resource_authority"]
mod parts {
    pub mod budget;
}
pub use parts::budget;
use crate::records::{CommitContext, Error as RecordError, Records};
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
use serde_json::Value;


const MAX_PROOF_BYTES: usize = 8_192;
const MAX_DEADLINE_MS: i64 = 120_000;

#[derive(Debug, Clone)]
pub enum Refusal {
    InvalidMessage(crate::refusal_cause::Cause),
    RouteChanged(crate::refusal_cause::Cause),
    DeadlineExpired(crate::refusal_cause::Cause),
    AuthorityUnavailable(crate::refusal_cause::Cause),
    ClientRevoked(crate::refusal_cause::Cause),
    /// The volume has less free space than the computer keeps: the write is refused before any SQL (`disk_pressure`).
    DiskPressure(crate::refusal_cause::Cause),
}
impl Refusal {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::AuthorityUnavailable(cause) => cause.clone(),
            Self::ClientRevoked(cause) => cause.clone(),
            Self::DiskPressure(cause) => cause.clone(),
            Self::DeadlineExpired(cause) => cause.clone(),
            Self::InvalidMessage(cause) => cause.clone(),
            Self::RouteChanged(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Refusal);
impl PartialEq for Refusal {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for Refusal {}


#[derive(Debug, Clone)]
pub enum DispatchFailure {
    InvalidMessage(crate::refusal_cause::Cause),
    OutcomeUnknown(crate::refusal_cause::Cause),
}
impl DispatchFailure {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::InvalidMessage(cause) => cause.clone(),
            Self::OutcomeUnknown(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(DispatchFailure);
impl PartialEq for DispatchFailure {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for DispatchFailure {}


#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Route {
    pub account_id: String,
    pub device_id: String,
    pub resource_address: String,
    pub generation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InvokeMessage {
    pub request_id: String,
    pub account_id: String,
    pub device_id: String,
    pub resource_address: String,
    /// The original operation address when an installed capability is mounted
    /// on this admitted owner. Absent in legacy/direct messages, whose bytes and
    /// proof identity remain unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_resource: Option<String>,
    pub generation: String,
    pub operation: String,
    pub input: Value,
    pub request_key: String,
    /// A confirmation by the person present the call carried beside its request key
    /// (`account::person_present::REQUEST_FIELD`). Absent in messages that carry none, whose bytes stay unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub person_present: Option<Value>,
    pub client_authorization: String,
    pub deadline_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Scope {
    pub account_id: String,
    pub device_id: String,
    pub resource_address: String,
    pub generation: String,
    pub operation: String,
    pub request_key: String,
    pub input_identity: String,
}

pub trait CurrentClient: Send + Sync {
    fn identity(&self) -> &str;
    /// This method must be synchronous and locally checkable at commit.
    fn assert_current(&self, scope: &Scope) -> bool;
}

pub trait ClientAuthority: Send + Sync {
    fn admit(&self, proof: &str, scope: &Scope) -> Option<Box<dyn CurrentClient>>;
}

pub struct AdmittedCall {
    request_id: String,
    scope: Scope,
    input: Value,
    owned_request_key: String,
    deadline_at_ms: i64,
    client: Box<dyn CurrentClient>,
}

fn valid(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.bytes().any(|byte| byte < 32)
}

/// Whether an operation's own resource routes to another resource than the message names. This tool keeps no operation
/// reach table, so every operation resource is refused.
fn routed_elsewhere(_address: &str, _operation: &str, _resource: &str) -> bool {
    true
}

fn validate_message(message: &InvokeMessage) -> Result<(), Refusal> {
    if !valid(&message.request_id, 160)
        || !valid(&message.account_id, 512)
        || !valid(&message.device_id, 160)
        || !valid(&message.resource_address, 512)
        || message.operation_resource.as_ref().is_some_and(|address|
            !valid(address, 512) || address == &message.resource_address
                || routed_elsewhere(address, &message.operation, &message.resource_address))
        || !valid(&message.generation, 512)
        || !valid(&message.operation, 256)
        || !valid(&message.request_key, 512)
        || !valid(&message.client_authorization, MAX_PROOF_BYTES)
        || !message.input.is_object()
        || message.person_present.as_ref().is_some_and(|proof| !proof.is_object())
    {
        return Err(crate::cause!(Refusal::InvalidMessage));
    }
    Ok(())
}

/// The decode of one invoke message at the account routes.
pub fn decode_message(bytes: &[u8]) -> Result<InvokeMessage, Refusal> {
    // One invoke message carries one account request (src/mcp/settings.json `request_bytes`) inside its envelope.
    if bytes.len() > crate::mcp::carried_message_bytes() {
        return Err(crate::cause!(Refusal::InvalidMessage));
    }
    let message: InvokeMessage = serde_json::from_slice(bytes).map_err(|error| crate::carry_cause!(Refusal::InvalidMessage, error))?;
    validate_message(&message)?;
    Ok(message)
}

fn matches_route(scope: &Scope, route: &Route) -> bool {
    scope.account_id == route.account_id
        && scope.device_id == route.device_id
        && scope.resource_address == route.resource_address
        && scope.generation == route.generation
}

pub(crate) fn message_scope(message: &InvokeMessage) -> Result<Scope, Refusal> {
    validate_message(message)?;
    // A mounted call binds both its owner and its original operation address;
    // a proof for one installed route set cannot authorize another with equal input.
    // Direct messages preserve the exact historical input identity.
    let input_bytes = match &message.operation_resource {
        Some(address) => serde_json::to_vec(&("mounted-operation-input", address, &message.input)),
        None => serde_json::to_vec(&message.input),
    }.map_err(|error| crate::carry_cause!(Refusal::InvalidMessage, error))?;
    let input_identity =
        blake3::hash(&input_bytes)
            .to_hex()
            .to_string();
    Ok(Scope {
        account_id: message.account_id.clone(),
        device_id: message.device_id.clone(),
        resource_address: message.resource_address.clone(),
        generation: message.generation.clone(),
        operation: message.operation.clone(),
        request_key: message.request_key.clone(),
        input_identity,
    })
}

impl AdmittedCall {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    pub fn input(&self) -> &Value {
        &self.input
    }
    pub fn owned_request_key(&self) -> &str {
        &self.owned_request_key
    }
    /// Recheck in the resource owner's synchronous write transaction. The
    /// caller supplies its current local route, not the message's route claim.
    pub fn assert_current(&self, current_route: &Route, now_ms: i64) -> Result<(), Refusal> {
        if now_ms >= self.deadline_at_ms {
            return Err(crate::cause!(Refusal::DeadlineExpired));
        }
        if !matches_route(&self.scope, current_route) {
            return Err(crate::cause!(Refusal::RouteChanged));
        }
        if !self.client.assert_current(&self.scope) {
            return Err(crate::cause!(Refusal::ClientRevoked));
        }
        Ok(())
    }
    pub fn client_identity(&self) -> &str {
        self.client.identity()
    }
}

/// Only the locally held route and trusted verifier may admit a public message.
/// No verifier means no remote operation, including reads and retries.
pub fn admit(
    message: InvokeMessage,
    current_route: &Route,
    authority: Option<&dyn ClientAuthority>,
    now_ms: i64,
) -> Result<AdmittedCall, Refusal> {
    let scope = message_scope(&message)?;
    if !matches_route(&scope, current_route) {
        return Err(crate::cause!(Refusal::RouteChanged));
    }
    if message.deadline_at_ms <= now_ms
        || message.deadline_at_ms.saturating_sub(now_ms) > MAX_DEADLINE_MS
    {
        return Err(crate::cause!(Refusal::DeadlineExpired));
    }
    let authority = authority.ok_or(crate::cause!(Refusal::AuthorityUnavailable))?;
    let client = authority
        .admit(&message.client_authorization, &scope)
        .ok_or(crate::cause!(Refusal::ClientRevoked))?;
    if !valid(client.identity(), 256) || !client.assert_current(&scope) {
        return Err(crate::cause!(Refusal::ClientRevoked));
    }
    // Keep the original caller key portable across Mac moves while preventing
    // one client's key from recovering another client's durable result.
    let identity = serde_json::to_vec(&(
        "remote-client-request",
        &scope.account_id,
        &scope.resource_address,
        client.identity(),
        &scope.request_key,
    ))
    .map_err(|error| crate::carry_cause!(Refusal::InvalidMessage, error))?;
    let owned_request_key = format!("1f:{}", blake3::hash(&identity).to_hex());
    Ok(AdmittedCall {
        request_id: message.request_id,
        scope,
        input: message.input,
        owned_request_key,
        deadline_at_ms: message.deadline_at_ms,
        client,
    })
}

/// Mac-side record consumer for a connection message. Supply uncertainty remains a
/// transport error so the public caller must retry the original request key.
/// Every refusal is correlated to the message's request ID without exposing data. The module computer has none.
pub fn dispatch_record_message(
    bytes: &[u8],
    store: &mut dyn Records,
    context: &dyn CommitContext,
    authority: Option<&dyn ClientAuthority>,
) -> Result<Vec<u8>, DispatchFailure> {
    let message = decode_message(bytes).map_err(|error| DispatchFailure::InvalidMessage(error.cause()))?;
    let request_id = message.request_id.clone();
    let scope = message_scope(&message).map_err(|error| DispatchFailure::InvalidMessage(error.cause()))?;
    let refused = |code: &str, cause: crate::refusal_cause::Cause| {
        crate::quiet_eprintln!("door-refusal code={code} cause={cause}");
        serde_json::to_vec(&serde_json::json!({
            "state":"refused", "request_id":request_id, "code":code, "cause":cause.id(),
        })).map_err(|error| crate::carry_cause!(DispatchFailure::OutcomeUnknown, error))
    };
    let Some(route) = context.current_route(&scope) else {
        return refused("resource_route_changed", crate::cause!(tokens: current_route_missing));
    };
    let call = match admit(message, &route, authority, context.now_ms()) {
        Ok(call) => call,
        Err(error) => {
            let cause = error.cause();
            return refused(refusal_code(error), cause);
        }
    };
    let change = match store.mutate_admitted(&call, context) {
        Ok(change) => change,
        Err(RecordError::OutcomeUnknown(cause)) => {
            crate::quiet_eprintln!("door-refusal code=resource_outcome_unknown cause={cause}");
            return Err(DispatchFailure::OutcomeUnknown(cause));
        }
        Err(error) => {
            let cause = error.cause();
            let code = match error {
                RecordError::Refused(refusal, _) => refusal_code(refusal),
                RecordError::Conflict(_) => "record_conflict",
                RecordError::Invalid(_, _) => "invalid_record_request",
                RecordError::Unavailable(_) => "resource_unavailable",
                RecordError::OutcomeUnknown(_) => unreachable!("handled above"),
            };
            return refused(code, cause);
        }
    };
    serde_json::to_vec(&serde_json::json!({"state":"completed","request_id":request_id,
        "value":{"sequence":change.sequence,"id":change.id,"version":change.version,
            "deleted":change.deleted}})).map_err(|error| crate::carry_cause!(DispatchFailure::OutcomeUnknown, error))
}

pub(crate) fn refusal_code(error: Refusal) -> &'static str {
    match error {
        Refusal::InvalidMessage(_) => "invalid_resource_request",
        Refusal::RouteChanged(_) => "resource_route_changed",
        Refusal::DeadlineExpired(_) => "resource_deadline_expired",
        Refusal::AuthorityUnavailable(_) => "client_authority_unavailable",
        Refusal::ClientRevoked(_) => "client_not_authorized",
        Refusal::DiskPressure(_) => "disk_pressure",
    }
}
