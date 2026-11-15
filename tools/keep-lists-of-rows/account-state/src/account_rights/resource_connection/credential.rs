//! One bounded short-lived current credential row per device in the original policy directory.
//! The existing enrolled computer key derives a recoverable capability; only its
//! digest is kept. This is not a second device issuer, auth database or log.
use super::{current, Registration};
use content_crypto::advanced::blake3;
use crate::{account::AccountIdentity, account_rights::{self, physical, put, read, MAX_SAFE}, forwarder::session::ConnectionGrant,
    storage::{Intent, Scope, Storage}};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::fmt;
use zeroize::Zeroizing;

const VERSION:&str="trillion.resource-connection-credential/v1";
const DOMAIN:&[u8]=b"trillion.resource-connection-credential/v1\0";
pub(crate) const MAX_LIFE_MS:u64=120_000;

#[derive(Clone,Debug)]
pub(crate) enum Error { Invalid(crate::refusal_cause::Cause), Unauthorized(crate::refusal_cause::Cause), Conflict(crate::refusal_cause::Cause), Expired(crate::refusal_cause::Cause), Unavailable(crate::refusal_cause::Cause), Unknown(crate::refusal_cause::Cause) }
impl Error { pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { match self {
Self::Invalid(cause)=>cause,
Self::Unauthorized(cause)=>cause,
Self::Conflict(cause)=>cause,
Self::Expired(cause)=>cause,
Self::Unavailable(cause)=>cause,
Self::Unknown(cause)=>cause,
} } }
crate::impl_caused!(Error);
impl PartialEq for Error {fn eq(&self, other:&Self)->bool {std::mem::discriminant(self)==std::mem::discriminant(other)}}
impl Eq for Error {}

impl fmt::Display for Error {
    fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result { f.write_str(match self {
        Self::Invalid(_)=>"connection credential input refused",Self::Unauthorized(_)=>"connection credential not authorized",
        Self::Conflict(_)=>"connection credential revision changed",Self::Expired(_)=>"connection credential expired",
        Self::Unavailable(_)=>"connection credential source unavailable",Self::Unknown(_)=>"connection credential outcome unknown",
    }) }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub(crate) type Result<T>=std::result::Result<T,Error>;
fn mapped(error:account_rights::Error)->Error { match error {
    account_rights::Error::Invalid(_)=>crate::cause!(Error::Invalid),
    account_rights::Error::NotAuthorized(_)=>crate::cause!(Error::Unauthorized),
    account_rights::Error::DifferentChange(_)|account_rights::Error::SourceChanged(_)=>crate::cause!(Error::Conflict),
    _=>crate::cause!(Error::Unavailable),
} }
fn hex(value:&str)->bool {value.len()==64&&value.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn request(value:&str)->bool {!value.is_empty()&&value.len()<=512&&!value.chars().any(char::is_control)}
fn name(device:&str)->Result<String> {if !hex(device){return Err(crate::cause!(Error::Invalid))};Ok(format!("resource-connection-credential:{device}"))}
fn token_device(token:&[u8])->Result<&str> {
    let digit=|b:&u8|b.is_ascii_digit()||(b'a'..=b'f').contains(b);
    if token.len()!=133||!token.starts_with(b"trc_")||token[68]!=b'_'
        ||!token[4..68].iter().all(digit)||!token[69..].iter().all(digit){return Err(crate::cause!(Error::Invalid))};
    std::str::from_utf8(&token[4..68]).map_err(|error| crate::carry_cause!(Error::Invalid, error))
}

/// The credential a renewal replaced. It stays current until its own expiry, so the session it opened keeps serving
/// until the next one is acknowledged: a renewal is never a gap. Withdrawing the registration ends both at once.
#[derive(Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Replaced { issued_at_ms:u64, expires_at_ms:u64, token_digest:String }

#[derive(Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Slot {
    version:String, account_id:String,device_id:String,resource_address:String,
    resource_generation:u64,registration_revision:u64,credential_revision:u64,
    request_key:String,input_identity:String,issued_at_ms:u64,expires_at_ms:u64,token_digest:String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    replaced:Option<Replaced>,
}
impl Slot {
    fn valid(&self)->bool {self.version==VERSION&&hex(&self.account_id)&&hex(&self.device_id)
        &&self.resource_address=="@own-records"&&(1..=MAX_SAFE).contains(&self.resource_generation)
        &&(1..=MAX_SAFE).contains(&self.registration_revision)&&(1..=MAX_SAFE).contains(&self.credential_revision)
        &&request(&self.request_key)&&hex(&self.input_identity)&&hex(&self.token_digest)
        &&self.issued_at_ms>0&&self.expires_at_ms<=MAX_SAFE
        &&self.expires_at_ms.checked_sub(self.issued_at_ms).is_some_and(|life|(1..=MAX_LIFE_MS).contains(&life))
        &&self.replaced.as_ref().is_none_or(|old|hex(&old.token_digest)&&old.token_digest!=self.token_digest
            &&old.issued_at_ms>0&&old.issued_at_ms<=self.issued_at_ms&&old.expires_at_ms<=self.expires_at_ms
            &&old.expires_at_ms.checked_sub(old.issued_at_ms).is_some_and(|life|(1..=MAX_LIFE_MS).contains(&life)))}
    /// The issue and expiry times of the credential `digest` names in this row: the current one, or the one its
    /// renewal replaced.
    fn times_of(&self,digest:&str)->Option<(u64,u64)> {
        if self.token_digest==digest {return Some((self.issued_at_ms,self.expires_at_ms))};
        self.replaced.as_ref().filter(|old|old.token_digest==digest).map(|old|(old.issued_at_ms,old.expires_at_ms))
    }
    fn registration(&self,registration:&Registration)->bool {registration.active&&self.account_id==registration.account_id
        &&self.device_id==registration.device_id&&self.resource_address==registration.resource_address
        &&self.resource_generation==registration.resource_generation&&self.registration_revision==registration.registration_revision}
    fn grant(&self,registration:&Registration)->Result<ConnectionGrant> {
        grant_of(registration,self.expires_at_ms,&self.token_digest)
    }
}
fn grant_of(registration:&Registration,expires_at_ms:u64,digest:&str)->Result<ConnectionGrant> {
    Ok(ConnectionGrant {route:registration.route().map_err(mapped)?,expires_at_ms:i64::try_from(expires_at_ms).map_err(|error| crate::carry_cause!(Error::Invalid, error))?,admission_identity:Some(digest.to_owned())})
}
fn stored(store:&dyn Storage,account:&AccountIdentity,device:&str)->Result<Option<Slot>> {
    let value=read(store,&name(device)?).map_err(mapped)?;
    if value.is_null(){return Ok(None)};
    let slot:Slot=serde_json::from_value(value).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if !slot.valid()||slot.account_id!=account.owner_id||slot.device_id!=device{return Err(crate::cause!(Error::Unavailable))};
    Ok(Some(slot))
}
fn enrolled(store:&dyn Storage,account:&AccountIdentity,device:&str)->Result<Registration> {
    current(store,account,device,"@own-records").map_err(mapped)?.filter(|r|r.active).ok_or(crate::cause!(Error::Unauthorized))
}
fn token(key:&[u8],slot:&Slot)->Result<Zeroizing<String>> {
    let bytes=Zeroizing::new(serde_json::to_vec(&(VERSION,&slot.account_id,&slot.device_id,&slot.resource_address,
        slot.resource_generation,slot.registration_revision,slot.credential_revision,&slot.request_key,&slot.input_identity,slot.issued_at_ms,slot.expires_at_ms)).map_err(|error| crate::carry_cause!(Error::Invalid, error))?);
    let mut mac=Hmac::<Sha256>::new_from_slice(key).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    mac.update(DOMAIN);mac.update(&bytes);
    let output=Zeroizing::new(mac.finalize().into_bytes().to_vec());
    let mut result=Zeroizing::new(format!("trc_{}_",slot.device_id));
    use std::fmt::Write;
    for byte in output.iter(){write!(&mut *result,"{byte:02x}").map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;}
    Ok(result)
}

/// Retained one original credential and current selected source for this exact
/// issue command. The LocalAccount implementation is private and nontransferable.
pub(crate) trait Issuer {
    fn assert_current(&mut self,store:&dyn Storage,registration:&Registration)->Result<()>;
}
pub(crate) struct IssuedCredential {
    token:Zeroizing<String>, grant:ConnectionGrant, revision:u64,
    #[cfg(test)] request_key:String,
    #[cfg(test)] expected_revision:u64,
}
impl fmt::Debug for IssuedCredential {fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result{f.write_str("IssuedCredential([redacted])")}}
impl IssuedCredential {
    /// Fixture check of the original issuance binding; no credential is revealed.
    #[cfg(test)]
    pub(crate) fn matches_issue(&self, request_key:&str, expected_revision:u64)->bool {
        self.request_key==request_key && self.expected_revision==expected_revision
    }
    pub(crate) fn as_bytes(&self)->&[u8]{self.token.as_bytes()}
    pub(crate) fn grant(&self)->&ConnectionGrant{&self.grant}
    pub(crate) fn revision(&self)->u64{self.revision}
}

/// Authenticated caller reads current revision to perform explicit rotation.
/// A missing current credential row is revision zero; expired/revoked rows are never deleted.
pub(crate) fn revision(store:&dyn Storage,account:&AccountIdentity,device:&str)->Result<u64> {
    physical(store).map_err(mapped)?;
    let tx=Scope::begin(store,Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    enrolled(&*tx,account,device)?;
    let value=stored(&*tx,account,device)?.map_or(0,|slot|slot.credential_revision);
    tx.commit().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    Ok(value)
}

/// Only the current credential row is retained: storage is bounded by enrolled devices,
/// not reconnect count. A stale expected revision cannot resurrect older work.
pub(crate) fn issue(store:&dyn Storage,owner:&mut impl Issuer,account:&AccountIdentity,key:&[u8],
    request_key:&str,expected_revision:u64,lifetime_ms:u64,now:u64)->Result<IssuedCredential> {
    if !request(request_key)||expected_revision>=MAX_SAFE||!(1..=MAX_LIFE_MS).contains(&lifetime_ms)||now==0||now>MAX_SAFE{return Err(crate::cause!(Error::Invalid))};
    // The private actual-owner Issuer verifies this same original tc_ key.
    // Its existing BLAKE3 digest is the registration's device identity.
    if key.is_empty()||key.len()>8192{return Err(crate::cause!(Error::Invalid))};
    let device=blake3::hash(key).to_hex().to_string();
    physical(store).map_err(mapped)?;
    if store.scoped(){return Err(crate::cause!(Error::Unavailable))};
    let initial=enrolled(store,account,&device)?;
    owner.assert_current(store,&initial)?;
    let tx=Scope::begin(store,Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let registration=enrolled(&*tx,account,&device)?;
    if registration!=initial{return Err(crate::cause!(Error::Conflict))};
    let identity=blake3::hash(&serde_json::to_vec(&(VERSION,&registration.account_id,&registration.device_id,
        &registration.resource_address,registration.resource_generation,registration.registration_revision,
        request_key,expected_revision,lifetime_ms)).map_err(|error| crate::carry_cause!(Error::Invalid, error))?).to_hex().to_string();
    let prior=stored(&*tx,account,&device)?;
    let mut slot=if let Some(prior)=prior.as_ref().filter(|slot|slot.request_key==request_key) {
        if prior.input_identity!=identity||!prior.registration(&registration){return Err(crate::cause!(Error::Conflict))};
        if now<prior.issued_at_ms{return Err(crate::cause!(Error::Unavailable))};
        if now>=prior.expires_at_ms{return Err(crate::cause!(Error::Expired))};
        prior.clone()
    } else {
        if prior.as_ref().map_or(0,|slot|slot.credential_revision)!=expected_revision{return Err(crate::cause!(Error::Conflict))};
        let expires=now.checked_add(lifetime_ms).filter(|n|*n<=MAX_SAFE).ok_or(crate::cause!(Error::Invalid))?;
        // The credential this renewal replaces keeps serving until its own expiry (never past the new one's).
        let replaced=prior.as_ref().filter(|old|old.registration(&registration)&&now>=old.issued_at_ms&&now<old.expires_at_ms)
            .map(|old|Replaced {issued_at_ms:old.issued_at_ms,expires_at_ms:old.expires_at_ms.min(expires),token_digest:old.token_digest.clone()});
        Slot {version:VERSION.into(),account_id:account.owner_id.clone(),device_id:device.clone(),resource_address:"@own-records".into(),
            resource_generation:registration.resource_generation,registration_revision:registration.registration_revision,
            credential_revision:expected_revision+1,request_key:request_key.into(),input_identity:identity,
            issued_at_ms:now,expires_at_ms:expires,token_digest:String::new(),replaced}
    };
    let raw=token(key,&slot)?;
    let digest=blake3::hash(raw.as_bytes()).to_hex().to_string();
    if !slot.token_digest.is_empty()&&slot.token_digest!=digest{return Err(crate::cause!(Error::Conflict))};
    slot.token_digest=digest;
    if prior.as_ref().is_none_or(|prior|prior.credential_revision!=slot.credential_revision) {
        put(&*tx,&name(&device)?,&serde_json::to_value(&slot).map_err(|error| crate::carry_cause!(Error::Invalid, error))?).map_err(mapped)?;
    }
    owner.assert_current(&*tx,&registration)?;
    physical(&*tx).map_err(mapped)?;
    let grant=slot.grant(&registration)?;
    tx.commit().map_err(|error| crate::carry_cause!(Error::Unknown, error))?;
    Ok(IssuedCredential {token:raw,grant,revision:slot.credential_revision,
        #[cfg(test)] request_key:slot.request_key,
        #[cfg(test)] expected_revision:slot.credential_revision-1})
}

/// Recover the currently retained capability using the SAME authenticated
/// original tc_ key. This reads the one current credential row and reconstructs its original
/// HMAC/time; it neither rotates nor renews it. None means a known absent or
/// expired credential, after the current registration check passes. All source ambiguity is
/// an error, and registration mismatch is Conflict rather than inferred absence.
pub(crate) fn recover_current(store:&dyn Storage,account:&AccountIdentity,key:&[u8],now:u64)->Result<Option<IssuedCredential>> {
    if key.is_empty()||key.len()>8192||now==0||now>MAX_SAFE{return Err(crate::cause!(Error::Invalid))};
    let device=blake3::hash(key).to_hex().to_string();
    physical(store).map_err(mapped)?;
    let tx=Scope::begin(store,Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let registration=enrolled(&*tx,account,&device)?;
    let slot=stored(&*tx,account,&device)?;
    let recovered=match slot {
        None=>None,
        Some(slot)=>{
            if !slot.registration(&registration){return Err(crate::cause!(Error::Conflict))};
            if now<slot.issued_at_ms{return Err(crate::cause!(Error::Unavailable))};
            if now>=slot.expires_at_ms {None} else {
                let raw=token(key,&slot)?;
                if blake3::hash(raw.as_bytes()).to_hex().as_str()!=slot.token_digest{return Err(crate::cause!(Error::Unauthorized))};
                let grant=slot.grant(&registration)?;
                Some(IssuedCredential {token:raw,grant,revision:slot.credential_revision,
                    #[cfg(test)] request_key:slot.request_key,
                    #[cfg(test)] expected_revision:slot.credential_revision-1})
            }
        }
    };
    physical(&*tx).map_err(mapped)?;
    tx.commit().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    Ok(recovered)
}

pub(crate) fn admit(store:&dyn Storage,account:&AccountIdentity,raw:&[u8],now:u64)->Result<ConnectionGrant> {
    let device=token_device(raw)?;
    physical(store).map_err(mapped)?;
    let tx=Scope::begin(store,Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let registration=enrolled(&*tx,account,device)?;
    let slot=stored(&*tx,account,device)?.ok_or(crate::cause!(Error::Unauthorized))?;
    let actual=blake3::hash(raw).to_hex().to_string();
    let Some((issued_at,expires_at))=slot.times_of(&actual).filter(|_|slot.registration(&registration)) else {return Err(crate::cause!(Error::Unauthorized))};
    if now<issued_at{return Err(crate::cause!(Error::Unavailable))};
    if now>=expires_at{return Err(crate::cause!(Error::Expired))};
    let grant=grant_of(&registration,expires_at,&actual)?;
    tx.commit().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    Ok(grant)
}

pub(crate) fn is_current(store:&dyn Storage,account:&AccountIdentity,grant:&ConnectionGrant,now:u64)->Result<()> {
    if grant.route.account_id!=account.owner_id||grant.route.resource_address!="@own-records"{return Err(crate::cause!(Error::Unauthorized))};
    let identity=grant.admission_identity.as_deref().filter(|v|hex(v)).ok_or(crate::cause!(Error::Unauthorized))?;
    physical(store).map_err(mapped)?;
    let tx=Scope::begin(store,Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let registration=enrolled(&*tx,account,&grant.route.device_id)?;
    let slot=stored(&*tx,account,&grant.route.device_id)?.ok_or(crate::cause!(Error::Unauthorized))?;
    let Some((issued_at,expires_at))=slot.times_of(identity) else {return Err(crate::cause!(Error::Unauthorized))};
    if !slot.registration(&registration)||registration.route().map_err(mapped)?!=grant.route
        ||u64::try_from(grant.expires_at_ms).ok()!=Some(expires_at){return Err(crate::cause!(Error::Unauthorized))};
    if now<issued_at{return Err(crate::cause!(Error::Unavailable))};
    if now>=expires_at{return Err(crate::cause!(Error::Expired))};
    tx.commit().map_err(|error| crate::carry_cause!(Error::Unavailable, error))
}

#[cfg(test)]
#[path = "credential_tests.rs"]
mod tests;
