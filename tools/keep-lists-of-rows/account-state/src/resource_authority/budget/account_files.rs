//! The account files byte allowance's chunk supply, held from this finite owner.
//!
//! An `Allowance` (src/account_files/source_reads.rs) asks for a chunk only from its
//! own thread, off every request path. Each chunk is one hold: reserved and
//! started (durable) before its bytes become resident, settled once when used
//! up or when its handle is dropped. A chunk never settled (a crash) stays held,
//! so it counts as consumed, never as unused. One record write per hold step,
//! never per read. The host selects a captured grant whose unit is
//! `namespace-file-bytes`; no transport, prices or origin credentials live here.

use super::{Error, Hold, Owner, Reservation};
use crate::{
    account_files::{
        objects::ObjectError,
        source_reads::{Chunk, Supply},
    },
    storage::Storage,
};
use content_crypto::advanced::blake3;
use ring::rand::{SecureRandom, SystemRandom};
use std::sync::atomic::{AtomicU64, Ordering};

/// The grant unit a byte allowance spends: admitted account files file bytes, read and written.
pub const UNIT: &str = "namespace-file-bytes";

/// Chunks of one captured grant. Every chunk, including after a restart,
/// receives a fresh hold identity.
pub struct Chunks<S: Storage> {
    owner: Owner<S>,
    invocation: String,
    next: AtomicU64,
}
impl<S: Storage + Send> Chunks<S> {
    pub fn new(owner: Owner<S>) -> Result<Self, Error> {
        if owner.terms().unit != UNIT {
            return Err(crate::cause!(Error::Invalid));
        }
        let mut nonce = [0u8; 32];
        SystemRandom::new().fill(&mut nonce).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(Self { owner, invocation: blake3::hash(&nonce).to_hex().to_string(), next: AtomicU64::new(0) })
    }
}
fn unavailable(cause: crate::refusal_cause::Cause) -> ObjectError {
    ObjectError::Unavailable("finite account files byte authority unavailable".into(), cause)
}
struct Held<S: Storage>(Hold<S>);
impl<S: Storage + Send + 'static> Supply for Chunks<S> {
    fn hold(&self, bytes: u64) -> Result<Box<dyn Chunk>, ObjectError> {
        let ordinal = self.next.fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_add(1)).map_err(|_| unavailable(crate::cause!()))?;
        let id = format!("{}:{ordinal}", self.invocation);
        let hold = match self.owner.reserve(&id, "namespace-byte-chunk", bytes).map_err(|error| unavailable(error.cause()))? {
            Reservation::New(hold) => hold,
            Reservation::Existing(_) => return Err(unavailable(crate::cause!())),
        };
        // Started before any byte of it is resident: from here an unsettled chunk is held, never released.
        if let Err(error) = hold.start() {
            hold.release_unstarted().map_err(|error| unavailable(error.cause()))?;
            return Err(unavailable(error.cause()));
        }
        Ok(Box::new(Held(hold)))
    }
}
impl<S: Storage + Send> Chunk for Held<S> {
    fn settle(self: Box<Self>, consumed: u64) -> Result<(), ObjectError> {
        self.0.finish(Some(consumed), true, "namespace-byte-chunk-consumed").map_err(|error| unavailable(error.cause()))
    }
}

/// The host's funded byte allowances for the account files door (`AccountFilesDoor::fund`): one `Allowance` per
/// account and state folder, opened on the account's first funded call from that folder's own protected funding home
/// (`funding::Native`) with the host's trusted issuers, over the capture of unit `UNIT` that expires last.
///
/// A capture is the funding issuer's signed effect, applied to that home (`Native::apply`) by the host's payment
/// owner; nothing here creates one, reads a customer balance or infers payment. An account with no current capture
/// gets no allowance, so its bytes are refused before any request. When an allowance's balance is spent and its
/// grant can hold no more, the next call looks again and opens the newest other current capture, if any. Revoking a
/// capture stops new holds at the hold owner's commit check; bytes of a chunk already held stay spendable (at most one
/// chunk).
pub struct Funded {
    keys: Vec<super::funding::TrustedIssuer>,
    clock: std::sync::Arc<dyn crate::signed_authority::AuthorityClock>,
    signature_domain: Vec<u8>,
    chunk_bytes: u64,
    low_water: u64,
    open: std::sync::Mutex<std::collections::HashMap<(std::path::PathBuf, String), Opened>>,
}

/// One account's open allowance and the capture it holds from.
struct Opened {
    capture: (String, String),
    allowance: std::sync::Arc<crate::account_files::source_reads::Allowance>,
}

/// The host's wall clock, in milliseconds since the epoch.
pub struct WallClock;
impl crate::signed_authority::AuthorityClock for WallClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()
            .and_then(|since| i64::try_from(since.as_millis()).ok()).unwrap_or(i64::MAX)
    }
}

impl Funded {
    /// The host's funded allowances from the door's DATA `funded`: refused when an issuer key is not 32 bytes of
    /// base64url or the sizes are not a chunk of at least its low-water mark.
    pub fn from_settings(settings: &crate::account_files::account_routes::FundedSettings,
        clock: std::sync::Arc<dyn crate::signed_authority::AuthorityClock>) -> Result<Self, Error> {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let keys = settings.issuers.iter().map(|issuer| {
            let public_key: [u8; 32] = URL_SAFE_NO_PAD.decode(&issuer.public_key).ok()
                .and_then(|bytes| bytes.try_into().ok()).ok_or(crate::cause!(Error::Invalid))?;
            Ok(super::funding::TrustedIssuer { issuer: issuer.issuer.clone(), key_id: issuer.key_id.clone(), public_key })
        }).collect::<Result<Vec<_>, Error>>()?;
        Self::new(keys, clock, settings.signature_domain.as_bytes().to_vec(), settings.chunk_bytes, settings.low_water_bytes)
    }

    pub fn new(keys: Vec<super::funding::TrustedIssuer>, clock: std::sync::Arc<dyn crate::signed_authority::AuthorityClock>,
        signature_domain: Vec<u8>, chunk_bytes: u64, low_water: u64) -> Result<Self, Error> {
        if chunk_bytes == 0 || low_water > chunk_bytes || signature_domain.is_empty() {
            return Err(crate::cause!(Error::Invalid));
        }
        Ok(Self { keys, clock, signature_domain, chunk_bytes, low_water, open: Default::default() })
    }

    /// The protected funding home of `account` at `state_root`, opened with this host's trusted issuers (the host's
    /// payment owner applies signed captures through it).
    pub fn home(&self, state_root: &std::path::Path, account: &str) -> Result<super::funding::Native, Error> {
        super::funding::Native::open(state_root, account, self.keys.clone(), self.clock.clone(), self.signature_domain.clone())
    }

    /// `account`'s allowance at `state_root`: the open one while it holds a balance, else one opened over the
    /// current capture that expires last.
    pub fn open_allowance(&self, state_root: &std::path::Path, account: &str)
        -> Result<std::sync::Arc<crate::account_files::source_reads::Allowance>, Error> {
        use crate::account_files::{counters::Registry, source_reads::Allowance};
        let place = (state_root.to_path_buf(), account.to_owned());
        let mut open = self.open.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(opened) = open.get(&place).filter(|opened| opened.allowance.resident() > 0) {
            return Ok(opened.allowance.clone());
        }
        if self.keys.is_empty() {
            return Err(crate::cause!(Error::Authority));
        }
        let native = self.home(state_root, account)?;
        let capture = native.current(UNIT)?.into_iter().next().ok_or(crate::cause!(Error::Authority))?;
        if let Some(opened) = open.get(&place).filter(|opened| opened.capture == capture) {
            // The same capture, spent: its own thread keeps asking it; no second allowance over one grant.
            return Ok(opened.allowance.clone());
        }
        let chunks = native.chunks(&capture.0, &capture.1)?;
        let allowance = Allowance::open(std::sync::Arc::new(chunks), self.chunk_bytes, self.low_water, &Registry::global())
            .map_err(|error| Error::Exhausted(error.cause()))?;
        open.insert(place, Opened { capture, allowance: allowance.clone() });
        Ok(allowance)
    }
}

impl crate::account_files::account_routes::FundsBytes for Funded {
    fn allowance(&self, state_root: &std::path::Path, account: &str) -> Option<std::sync::Arc<crate::account_files::source_reads::Allowance>> {
        self.open_allowance(state_root, account).ok()
    }
}
