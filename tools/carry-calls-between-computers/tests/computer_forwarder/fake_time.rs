//! Test-owned virtual lease time, including computers in separate processes.
//! The production binary has no environment switch or fake clock loader.
use super::*;
use std::{
    io::{BufRead, BufReader, Write},
    sync::{
        atomic::{AtomicI64, Ordering},
        mpsc, Mutex, Weak,
    },
};
use trillion_local::storage::time_source::{Clock, Event};

#[derive(Clone, Copy)]
enum Progress {
    Changed,
    Scheduled(i64),
    Required(i64),
    Transit(i64),
}

#[derive(Clone, Copy)]
enum TaskState {
    Active,
    Parked(Option<i64>),
}
struct EventWait {
    event: Weak<Event>,
    task: u64,
    generation: u64,
}

struct Remote {
    stream: Arc<Mutex<TcpStream>>,
    acknowledged: mpsc::Receiver<i64>,
}

pub fn wake_peer(control: &Arc<Mutex<TcpStream>>) {
    let _ = control.lock().unwrap().write_all(b"wake\n");
}

pub struct FakeClock {
    at: AtomicI64,
    interrupted: std::sync::atomic::AtomicU64,
    changed: std::sync::Condvar,
    lock: Mutex<()>,
    events: Mutex<Vec<EventWait>>,
    tasks: Mutex<std::collections::BTreeMap<u64, TaskState>>,
    ready: Mutex<std::collections::BTreeSet<u64>>,
    ready_changed: std::sync::Condvar,
    progress_event: Arc<Event>,
    send: mpsc::Sender<Progress>,
    take: Mutex<mpsc::Receiver<Progress>>,
    peers: Mutex<Vec<Remote>>,
    pending: Mutex<std::collections::BTreeSet<i64>>,
    required: Mutex<std::collections::BTreeSet<i64>>,
    upstream: Mutex<Option<TcpStream>>,
}

thread_local! {
    static TASK: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static PARENTS: std::cell::RefCell<Vec<u64>> = const { std::cell::RefCell::new(Vec::new()) };
}

thread_local! { static CLOCK: std::cell::RefCell<Arc<FakeClock>> = std::cell::RefCell::new(FakeClock::new(now_ms())); }

pub fn clock() -> Arc<FakeClock> {
    CLOCK.with(|clock| clock.borrow().clone())
}

pub fn use_clock(clock: Arc<FakeClock>) {
    CLOCK.with(|slot| *slot.borrow_mut() = clock);
}

impl FakeClock {
    fn new(at: i64) -> Arc<Self> {
        let (send, take) = mpsc::channel();
        Arc::new(Self {
            at: AtomicI64::new(at),
            interrupted: Default::default(),
            changed: Default::default(),
            lock: Mutex::new(()),
            events: Default::default(),
            tasks: Default::default(),
            ready: Default::default(),
            ready_changed: Default::default(),
            progress_event: Default::default(),
            send,
            take: Mutex::new(take),
            peers: Default::default(),
            pending: Default::default(),
            required: Default::default(),
            upstream: Default::default(),
        })
    }
    fn report(&self, progress: Progress) {
        if let Some(upstream) = &mut *self.upstream.lock().unwrap() {
            let (kind, due) = match progress {
                Progress::Changed => ("event", 0),
                Progress::Scheduled(due) => ("wait", due),
                Progress::Required(due) => ("due", due),
                Progress::Transit(due) => ("transit", due),
            };
            let _ = writeln!(upstream, "{kind} {due}");
        } else {
            let _ = self.send.send(progress);
            self.progress_event.notify();
        }
    }
    pub fn changed(&self) {
        self.report(Progress::Changed);
    }
    fn record_task(&self, id: u64, state: Option<TaskState>) {
        let mut tasks = self.tasks.lock().unwrap();
        match state {
            Some(TaskState::Parked(Some(due))) if due <= self.now_ms() => {
                tasks.insert(id, TaskState::Active);
            }
            Some(state) => {
                tasks.insert(id, state);
            }
            None => {
                tasks.remove(&id);
            }
        }
        drop(tasks);
        self.changed();
    }
    fn note_task(&self, id: u64, state: Option<TaskState>, acknowledge: bool) {
        if id == 0 {
            return;
        }
        let remote = {
            let mut upstream = self.upstream.lock().unwrap();
            if let Some(upstream) = upstream.as_mut() {
                match state {
                    Some(TaskState::Active) => {
                        let _ = writeln!(
                            upstream,
                            "{} {id}",
                            if acknowledge { "active" } else { "awake" }
                        );
                    }
                    Some(TaskState::Parked(Some(due))) => {
                        let _ = writeln!(upstream, "park {id} {due}");
                    }
                    Some(TaskState::Parked(None)) => {
                        let _ = writeln!(upstream, "park {id} none");
                    }
                    None => {
                        let _ = writeln!(upstream, "done {id}");
                    }
                }
                true
            } else {
                false
            }
        };
        if !remote {
            self.record_task(id, state);
        } else if acknowledge {
            let ready = self.ready.lock().unwrap();
            let (mut ready, _) = self
                .ready_changed
                .wait_timeout_while(ready, Duration::from_secs(30), |ready| !ready.contains(&id))
                .unwrap();
            assert!(ready.remove(&id), "the host did not observe callback {id}");
        }
    }
    fn parked(&self, due: Option<i64>) {
        let id = TASK.with(|task| task.get());
        self.note_task(id, Some(TaskState::Parked(due)), false);
        if let Some(due) = due {
            self.report(Progress::Scheduled(due));
        }
    }
    fn resumed(&self) {
        self.note_task(TASK.with(|task| task.get()), Some(TaskState::Active), true);
    }
    fn set(&self, at: i64) {
        let _guard = self.lock.lock().unwrap();
        self.at.fetch_max(at, Ordering::AcqRel);
        self.changed.notify_all();
        let mut events = self.events.lock().unwrap();
        events.retain(|waiting| {
            if let Some(event) = waiting.event.upgrade() {
                if event.generation() != waiting.generation {
                    self.note_task(waiting.task, Some(TaskState::Active), false);
                }
                event.pulse();
                true
            } else {
                false
            }
        });
    }
    pub fn advance(&self, duration: Duration) {
        let at = self.now_ms().saturating_add(duration.as_millis() as i64);
        self.advance_to(at);
    }
    pub fn advance_to(&self, at: i64) {
        for state in self.tasks.lock().unwrap().values_mut() {
            if matches!(state, TaskState::Parked(Some(due)) if *due <= at) {
                *state = TaskState::Active;
            }
        }
        self.set(at);
        let mut peers = self.peers.lock().unwrap();
        peers.retain_mut(|peer| {
            if writeln!(peer.stream.lock().unwrap(), "{at}").is_err() {
                return false;
            }
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                match peer
                    .acknowledged
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                {
                    Ok(observed) if observed >= at => return true,
                    Ok(_) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => return false,
                    Err(error) => {
                        panic!("a computer did not receive the virtual clock advance: {error}")
                    }
                }
            }
        });
    }

    pub fn wait_until_running(&self, due: i64, running: &AtomicBool) {
        self.parked(Some(due));
        let mut guard = self.lock.lock().unwrap();
        while self.now_ms() < due && running.load(Ordering::Acquire) {
            guard = self.changed.wait(guard).unwrap();
        }
        drop(guard);
        self.resumed();
    }
    pub fn wait_link(&self, duration: Duration) {
        let due = self.now_ms().saturating_add(duration.as_millis() as i64);
        self.report(Progress::Transit(due));
        let mut guard = self.lock.lock().unwrap();
        while self.now_ms() < due {
            guard = self.changed.wait(guard).unwrap();
        }
    }
    fn wait_to(&self, due: i64, required: bool) {
        self.parked(Some(due));
        self.report(if required {
            Progress::Required(due)
        } else {
            Progress::Scheduled(due)
        });
        let interrupted = self.interrupted.load(Ordering::Acquire);
        let mut guard = self.lock.lock().unwrap();
        while self.now_ms() < due && self.interrupted.load(Ordering::Acquire) == interrupted {
            guard = self.changed.wait(guard).unwrap();
        }
        drop(guard);
        self.resumed();
    }
    pub fn connect(self: &Arc<Self>, listener: TcpListener) -> Arc<Mutex<TcpStream>> {
        let (stream, _) = listener.accept().unwrap();
        stream.set_nodelay(true).unwrap();
        writeln!(&stream, "{}", self.now_ms()).unwrap();
        let control = Arc::new(Mutex::new(stream.try_clone().unwrap()));
        let (acknowledged, acknowledgements) = mpsc::channel();
        self.peers.lock().unwrap().push(Remote {
            stream: control.clone(),
            acknowledged: acknowledgements,
        });
        let clock = self.clone();
        let responding = control.clone();
        std::thread::spawn(move || {
            let mut owned_tasks = std::collections::BTreeSet::new();
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let fields: Vec<_> = line.split_whitespace().collect();
                if fields.len() < 2 {
                    continue;
                }
                if matches!(fields[0], "active" | "awake" | "park" | "done") {
                    let id: u64 = fields[1].parse().unwrap();
                    owned_tasks.insert(id);
                    let state = match fields[0] {
                        "active" | "awake" => Some(TaskState::Active),
                        "park" => Some(TaskState::Parked(fields[2].parse().ok())),
                        _ => None,
                    };
                    clock.record_task(id, state);
                    if fields[0] == "active" {
                        let _ = writeln!(responding.lock().unwrap(), "ready {id}");
                    }
                    continue;
                }
                let Ok(due) = fields[1].parse() else { continue };
                if fields[0] == "ack" {
                    let _ = acknowledged.send(due);
                    continue;
                }
                clock.report(match fields[0] {
                    "wait" => Progress::Scheduled(due),
                    "due" => Progress::Required(due),
                    "transit" => Progress::Transit(due),
                    _ => Progress::Changed,
                });
            }
            clock
                .tasks
                .lock()
                .unwrap()
                .retain(|id, _| !owned_tasks.contains(id));
            clock.changed();
        });
        control
    }
    pub fn child(address: &str) -> Arc<Self> {
        let stream = TcpStream::connect(address).unwrap();
        stream.set_nodelay(true).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut initial = String::new();
        reader.read_line(&mut initial).unwrap();
        let clock = Self::new(initial.trim().parse().unwrap());
        *clock.upstream.lock().unwrap() = Some(stream);
        let updating = clock.clone();
        std::thread::spawn(move || {
            for line in reader.lines().map_while(Result::ok) {
                if line == "wake" {
                    updating.wake();
                } else if let Some(id) = line.strip_prefix("ready ") {
                    updating.ready.lock().unwrap().insert(id.parse().unwrap());
                    updating.ready_changed.notify_all();
                } else {
                    let at = line.parse().unwrap();
                    updating.set(at);
                    if let Some(upstream) = &mut *updating.upstream.lock().unwrap() {
                        let _ = writeln!(upstream, "ack {at}");
                    }
                }
            }
        });
        clock
    }
    fn drain(&self) -> bool {
        let events: Vec<_> = self.take.lock().unwrap().try_iter().collect();
        let changed = !events.is_empty();
        for event in events {
            match event {
                Progress::Required(due) => {
                    self.required.lock().unwrap().insert(due);
                }
                Progress::Transit(due) => self.advance_to(due),
                Progress::Scheduled(due) => {
                    self.pending.lock().unwrap().insert(due);
                }
                Progress::Changed => {}
            }
        }
        changed
    }
    fn requested_turn(&self) -> bool {
        if self
            .tasks
            .lock()
            .unwrap()
            .values()
            .any(|state| matches!(state, TaskState::Active))
        {
            return false;
        }
        let Some(target) = self.required.lock().unwrap().first().copied() else {
            return false;
        };
        let next = {
            let mut pending = self.pending.lock().unwrap();
            pending.retain(|due| *due > self.now_ms());
            pending
                .first()
                .copied()
                .map_or(target, |due| due.min(target))
        };
        self.advance_to(next);
        self.required
            .lock()
            .unwrap()
            .retain(|due| *due > self.now_ms());
        true
    }
    fn settle(&self, deadline: Instant) {
        loop {
            let generation = self.progress_event.generation();
            self.drain();
            if self.requested_turn() {
                continue;
            }
            if !self
                .tasks
                .lock()
                .unwrap()
                .values()
                .any(|state| matches!(state, TaskState::Active))
            {
                return;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(
                !left.is_zero(),
                "scheduled computer callbacks did not complete their turn"
            );
            self.progress_event.wait(generation, Some(left));
        }
    }
    /// Run real work while advancing only its explicitly requested grant/link time.
    pub fn drive<T: Send>(
        &self,
        work: impl FnOnce() -> T + Send,
        bound: Duration,
        _background: bool,
    ) -> T {
        std::thread::scope(|scope| {
            let (send, take) = mpsc::channel();
            scope.spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work));
                send.send(result).ok();
                self.changed();
            });
            let deadline = Instant::now() + bound;
            loop {
                let generation = self.progress_event.generation();
                self.drain();
                if let Ok(result) = take.try_recv() {
                    return result.unwrap_or_else(|panic| std::panic::resume_unwind(panic));
                }
                if self.requested_turn() {
                    continue;
                }
                let left = deadline.saturating_duration_since(Instant::now());
                assert!(!left.is_zero(), "work did not finish within {bound:?}");
                self.progress_event.wait(generation, Some(left));
            }
        })
    }
    /// A retry keeps its original virtual cadence. Due callbacks finish before another turn of time starts.
    pub fn progress(&self, deadline: Instant, cadence: Duration) {
        let generation = self.progress_event.generation();
        let changed = self.drain();
        self.settle(deadline);
        self.pending
            .lock()
            .unwrap()
            .retain(|due| *due > self.now_ms());
        if !self.pending.lock().unwrap().is_empty() {
            self.advance(cadence);
            self.settle(deadline);
        } else if !changed {
            self.progress_event.wait(
                generation,
                Some(deadline.saturating_duration_since(Instant::now())),
            );
            self.drain();
            self.settle(deadline);
        }
    }
}

impl Clock for FakeClock {
    fn task_started(&self) -> u64 {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = (u64::from(std::process::id()) << 32) | NEXT.fetch_add(1, Ordering::AcqRel);
        self.note_task(id, Some(TaskState::Active), true);
        id
    }
    fn task_enter(&self, id: u64) {
        let parent = TASK.with(|task| {
            let parent = task.get();
            task.set(id);
            parent
        });
        PARENTS.with(|parents| parents.borrow_mut().push(parent));
        self.note_task(parent, Some(TaskState::Parked(None)), false);
    }
    fn task_finished(&self, id: u64) {
        let current = TASK.with(|task| task.get());
        if current == id {
            let parent = PARENTS.with(|parents| parents.borrow_mut().pop().unwrap_or(0));
            TASK.with(|task| task.set(parent));
            self.note_task(parent, Some(TaskState::Active), true);
        }
        self.events
            .lock()
            .unwrap()
            .retain(|waiting| waiting.task != id);
        self.note_task(id, None, false);
    }
    fn now_ms(&self) -> i64 {
        self.at.load(Ordering::Acquire)
    }
    fn wake(&self) {
        let _guard = self.lock.lock().unwrap();
        self.interrupted.fetch_add(1, Ordering::AcqRel);
        self.changed.notify_all();
        for event in self
            .events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|waiting| waiting.event.upgrade())
        {
            event.notify();
        }
    }
    fn wait(&self, duration: Duration) {
        self.wait_to(
            self.now_ms().saturating_add(duration.as_millis() as i64),
            false,
        );
    }
    fn wait_expiry(&self, duration: Duration) {
        self.wait_to(
            self.now_ms().saturating_add(duration.as_millis() as i64),
            true,
        );
    }
    fn wait_changed(&self, event: &Arc<Event>, generation: u64, bound: Option<Duration>) {
        let id = TASK.with(|task| task.get());
        let weak = Arc::downgrade(event);
        let mut events = self.events.lock().unwrap();
        events.retain(|old| old.task != id || !Weak::ptr_eq(&old.event, &weak));
        events.push(EventWait {
            event: weak.clone(),
            task: id,
            generation,
        });
        drop(events);
        let due = bound.map(|bound| self.now_ms().saturating_add(bound.as_millis() as i64));
        self.parked(due);
        event.wait_while(generation, || due.is_none_or(|due| self.now_ms() < due));
        self.events
            .lock()
            .unwrap()
            .retain(|waiting| waiting.task != id || !Weak::ptr_eq(&waiting.event, &weak));
        self.resumed();
    }
}

pub struct Mark {
    clock: Arc<FakeClock>,
    at: i64,
}
impl Mark {
    pub fn elapsed(&self) -> Duration {
        Duration::from_millis(self.clock.now_ms().saturating_sub(self.at).max(0) as u64)
    }
}
pub fn mark() -> Mark {
    let clock = clock();
    let at = clock.now_ms();
    Mark { clock, at }
}

#[test]
fn an_expiry_wait_completes_at_its_virtual_deadline() {
    let clock = FakeClock::new(1_000);
    let worker_clock = clock.clone();
    let (send, take) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        worker_clock.wait_expiry(Duration::from_secs(9));
        send.send(()).unwrap();
    });
    assert!(matches!(
        clock
            .take
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(1))
            .unwrap(),
        Progress::Scheduled(10_000)
    ));
    assert!(matches!(
        clock
            .take
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(1))
            .unwrap(),
        Progress::Required(10_000)
    ));
    assert!(take.try_recv().is_err());
    clock.advance(Duration::from_millis(8_999));
    assert!(take.try_recv().is_err());
    clock.advance(Duration::from_millis(1));
    take.recv_timeout(Duration::from_secs(1)).unwrap();
    worker.join().unwrap();
    assert_eq!(clock.now_ms(), 10_000);
}

#[test]
fn an_event_between_the_condition_check_and_wait_is_retained() {
    let clock = FakeClock::new(1_000);
    let event = Arc::new(Event::default());
    let generation = event.generation();
    event.notify();
    clock.wait_changed(&event, generation, None);
    assert_eq!(clock.now_ms(), 1_000);
}

#[test]
fn a_cancelled_callback_releases_its_scheduler_turn() {
    let clock = FakeClock::new(1_000);
    let callback = trillion_local::forwarder::lease_time::tracked(clock.clone(), || {
        panic!("a cancelled callback must not run")
    });
    assert_eq!(clock.tasks.lock().unwrap().len(), 1);
    drop(callback);
    assert!(clock.tasks.lock().unwrap().is_empty());
}
