//! Shared protected-book fixtures in isolated temporary SQLite files.
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc,
    },
    time::Duration,
};
use trillion_local::{
    resource_authority::budget::{
        CapturedGrant, HostPolicy, Hold, Owner, Payer, Reservation, Terms, View,
    },
    storage::{
        record_store::{settings, RecordStore, RealClock},
        sqlite::{self, Bounds, Connection, Spend, Supply},
    },
};
pub type Budget = Owner<Supply<Connection>>;
pub struct Policy {
    pub live: AtomicBool,
    pub now: AtomicI64,
    pub recovery: AtomicBool,
}
impl Policy {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            live: AtomicBool::new(true),
            now: AtomicI64::new(100),
            recovery: AtomicBool::new(false),
        })
    }
}
impl HostPolicy for Policy {
    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn capture(&self, terms: &Terms) -> bool {
        matches!(&terms.payer, Payer::External)
            || matches!(&terms.payer, Payer::Funded { funding_identity } if funding_identity == "verified-host-effect")
    }
    fn current(&self, terms: &Terms) -> bool {
        self.live.load(Ordering::SeqCst) && self.now.load(Ordering::SeqCst) < terms.expires_at_ms
    }
    fn recovery_current(&self, _: &Terms) -> bool {
        self.recovery.load(Ordering::SeqCst)
    }
    fn reconcile(&self, _: &Terms, _: &str, _: &View, _: u64, evidence: &str) -> bool {
        self.recovery.load(Ordering::SeqCst) && evidence == "trusted-terminal-evidence"
    }
}
pub fn terms(limit: u64) -> Terms {
    Terms {
        grant: "captured-grant".into(),
        account: "account".into(),
        // A declared internal resource in an isolated temporary test book.
        // This fixture does not install authority in a real computer-grant store.
        resource: "computer-grants".into(),
        basis: "origin".into(),
        unit: "observed-source-body-bytes".into(),
        payer: Payer::Funded {
            funding_identity: "verified-host-effect".into(),
        },
        limit,
        expires_at_ms: 1000,
    }
}
pub fn store(path: &Path) -> RecordStore<Supply<Connection>> {
    let path = path
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap()
        .join(path.file_name().unwrap());
    let supply = sqlite::open_owned(
        &path,
        "record_store",
        Bounds {
            value_bytes: 2_000_000,
            work: u64::MAX / 2,
            deadline: Duration::MAX,
            spend: Spend::EachOperation,
            cancel: None,
            busy: Duration::from_secs(5),
        },
    )
    .unwrap();
    let store = RecordStore::new(
        supply,
        Box::new(RealClock),
        settings::Limits::fixed(1 << 20, 10 << 30),
    )
    .unwrap();
    store
}
pub fn open(path: &Path, terms: Terms, policy: Arc<Policy>) -> Budget {
    Owner::new(store(path), CapturedGrant::capture(terms, policy).unwrap())
}
pub fn fresh(owner: &Budget, id: &str, bound: u64) -> Hold<Supply<Connection>> {
    match owner.reserve(id, "exact-input", bound).unwrap() {
        Reservation::New(hold) => hold,
        Reservation::Existing(_) => panic!("new request needs one capability"),
    }
}
