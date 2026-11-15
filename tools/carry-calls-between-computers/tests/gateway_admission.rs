// tests/gateway_admission.rs
//
// Purpose: Tests bounded Mac stream and WebSocket admission under stalled reads.
//
// Non-Negotiable Invariants:
// - Pending admission capacity bounds accepted work; saturated admission must reject without reading another connection.
//
// Key Concepts:
// - Pending-admission counters cap both stream and WebSocket entry.
// - Stalled readers hold slots until released; rejected overflow must perform no read.
//
// Security Considerations:
// - Fake authenticators and registrations deny credentials, and blocked reads are released and joined before the test exits.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use std::{
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
    time::Duration,
};
use trillion_local::{
    mcp::{http::BearerAuthenticator, Principal},
    forwarder::{
        gateway::{Gateway, MAX_PENDING_MAC_ADMISSIONS},
        session::{ConnectionAdmission, ConnectionGrant},
        ClientProofIssuer,
    },
    resource_authority::InvokeMessage,
};

struct NoBearer;
impl BearerAuthenticator for NoBearer {
    fn authenticate(&self, _: &[u8]) -> Option<Principal> {
        None
    }
}
struct NoProof;
impl ClientProofIssuer for NoProof {
    fn issue(&self, _: &Principal, _: &InvokeMessage) -> Option<String> {
        None
    }
}
struct NoRegistration;
impl ConnectionAdmission for NoRegistration {
    fn admit(&self, _: &[u8], _: i64) -> Option<ConnectionGrant> {
        None
    }
    fn is_current(&self, _: &ConnectionGrant, _: i64) -> bool {
        false
    }
}

struct StalledRead {
    gate: Arc<(Mutex<bool>, Condvar)>,
    entered: mpsc::Sender<()>,
}
impl Read for StalledRead {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        self.entered.send(()).unwrap();
        let (lock, ready) = &*self.gate;
        let mut released = lock.lock().unwrap();
        while !*released {
            released = ready.wait(released).unwrap();
        }
        Ok(0)
    }
}
impl Write for StalledRead {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct ObservedEof(Arc<AtomicUsize>);
impl Read for ObservedEof {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(0)
    }
}
impl Write for ObservedEof {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn stalled_admissions_bound_both_stream_and_websocket_entry() {
    let gateway = Arc::new(Gateway::new(
        "mcp.example.test",
        Arc::new(NoBearer),
        Arc::new(NoProof),
        Arc::new(NoRegistration),
        std::sync::Arc::new(OneThousand),
    ));
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let (entered, reads) = mpsc::channel();
    let mut pending = Vec::new();
    for _ in 0..MAX_PENDING_MAC_ADMISSIONS {
        let gateway = gateway.clone();
        let gate = gate.clone();
        let entered = entered.clone();
        pending.push(thread::spawn(move || {
            gateway.admit_mac_connection(StalledRead { gate, entered })
        }));
    }
    for _ in 0..MAX_PENDING_MAC_ADMISSIONS {
        reads.recv_timeout(Duration::from_secs(3)).unwrap();
    }
    let observed = Arc::new(AtomicUsize::new(0));
    assert!(gateway
        .admit_mac_connection(ObservedEof(observed.clone()))
        .is_err());
    assert!(gateway
        .admit_mac_websocket(ObservedEof(observed.clone()), "198.51.100.9:50000")
        .is_err());
    assert_eq!(observed.load(Ordering::SeqCst), 0);

    let (lock, ready) = &*gate;
    *lock.lock().unwrap() = true;
    ready.notify_all();
    for call in pending {
        assert!(call.join().unwrap().is_err());
    }
    assert!(gateway
        .admit_mac_websocket(ObservedEof(observed.clone()), "198.51.100.9:50000")
        .is_err());
    assert_eq!(observed.load(Ordering::SeqCst), 1);
}

/// A clock that reads 1000 ms: the proofs and windows these tests check are against that time.
struct OneThousand;
impl trillion_local::storage::time_source::Clock for OneThousand {
    fn now_ms(&self) -> i64 {
        1_000
    }
}
