/// One engine under test: the supply named by `STORAGE_SUPPLY` on the server at `STORAGE_URL`, in a store name of its own
/// per engine value, reopened on the same durable rows after a crash. (Replaces the parent suite's Engine; see build.rs.)
struct Engine {
    label: String,
    clock: Manual,
    open_supply: Arc<dyn Fn() -> Box<dyn StorageSend>>,
}
impl Engine {
    fn all() -> Vec<Engine> {
        Self::record_stores()
    }
    fn record_stores() -> Vec<Engine> {
        let kind = std::env::var("STORAGE_SUPPLY").expect("STORAGE_SUPPLY names the supply under test");
        let url = std::env::var("STORAGE_URL").expect("STORAGE_URL names the server");
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let store_name = format!("t{}_{}_{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() % 100_000_000));
        let label = kind.clone();
        let open_supply: Arc<dyn Fn() -> Box<dyn StorageSend>> = Arc::new(move || {
            let supply = storage_supplies::open(&kind, &url, &store_name).unwrap_or_else(|error| panic!("{kind} at {url}: {error}"));
            Box::new(supply) as Box<dyn StorageSend>
        });
        vec![Engine { label, clock: Manual::new(), open_supply }]
    }
    fn name(&self) -> &str {
        &self.label
    }
    /// A record store on this engine's durable rows (a restart when one existed before).
    fn open(&self) -> Box<dyn Records> {
        Box::new(self.record_store(Fault::None))
    }
    fn clock(&self) -> Manual {
        self.clock.clone()
    }
    /// Another handle on this engine's durable rows, open at the same time as the others.
    fn supply(&self) -> Box<dyn StorageSend> {
        (self.open_supply)()
    }
    /// The record store whose next commit fails as told, with the suite's settings.
    fn record_store(&self, fault: Fault) -> RecordStore<Faulty<Box<dyn StorageSend>>> {
        self.record_store_with(fault, u64::MAX / 2)
    }
    /// The store with a 1 MiB record bound and `byte_budget` (the parent suite's own limits).
    fn record_store_with(&self, fault: Fault, byte_budget: u64) -> RecordStore<Faulty<Box<dyn StorageSend>>> {
        let inner = (self.open_supply)();
        RecordStore::with_settings(Faulty { inner, next: Cell::new(fault) }, Box::new(self.clock.clone()), settings(), Limits::fixed(1 << 20, byte_budget)).unwrap()
    }
}

/// How many versions the as-of case writes to its long history (the parent suite writes 100,000).
fn history_versions() -> i64 {
    std::env::var("SUPPLY_HISTORY_VERSIONS").ok().and_then(|text| text.parse().ok()).unwrap_or(100_000)
}
