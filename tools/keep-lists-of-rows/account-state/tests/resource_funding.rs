//! Host funding is a separate, domain-signed effect, retained through the real
//! native record store placement and consumed by the actual finite hold owner.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::signature::{Ed25519KeyPair, KeyPair};
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc, Barrier,
};
use trillion_local::{
    resource_authority::budget::{
        funding::{funding_identity, Capture, Instruction, Native, TrustedIssuer, HOLDS},
        Error, Payer, Reservation, Terms,
    },
    signed_authority::AuthorityClock,
};

struct Clock(AtomicI64);
impl AuthorityClock for Clock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}
fn signing() -> Ed25519KeyPair {
    Ed25519KeyPair::from_seed_unchecked(&[17; 32]).unwrap()
}
fn keys() -> Vec<TrustedIssuer> {
    vec![TrustedIssuer {
        issuer: "service-treasury".into(),
        key_id: "funding-key".into(),
        public_key: signing().public_key().as_ref().try_into().unwrap(),
    }]
}
fn signed(instruction: &Instruction) -> String {
    signed_with_domain(instruction, b"fixture-resource-funding:v1\0")
}
fn signed_with_domain(instruction: &Instruction, domain: &[u8]) -> String {
    let payload = serde_json::to_vec(instruction).unwrap();
    let mut message = domain.to_vec();
    message.extend_from_slice(&payload);
    serde_json::json!({"key_id":"funding-key", "payload":URL_SAFE_NO_PAD.encode(&payload), "signature":URL_SAFE_NO_PAD.encode(signing().sign(&message).as_ref())}).to_string()
}
fn capture(native: &Native) -> Capture {
    Capture {
        issuer: "service-treasury".into(),
        effect: "captured-effect-001".into(),
        physical_home: native.physical_home().into(),
        terms: Terms {
            grant: "allocation-001".into(),
            account: "account".into(),
            resource: HOLDS.into(),
            basis: "origin".into(),
            unit: "observed-source-body-bytes".into(),
            payer: Payer::Funded {
                funding_identity: funding_identity("service-treasury", "captured-effect-001"),
            },
            limit: 100,
            expires_at_ms: 1000,
        },
    }
}
fn fixture() -> (tempfile::TempDir, Arc<Clock>, Native, Capture) {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(Clock(AtomicI64::new(100)));
    let native = Native::open(
        dir.path(),
        "account",
        keys(),
        clock.clone(),
        b"fixture-resource-funding:v1\0".to_vec(),
    )
    .unwrap();
    let capture = capture(&native);
    (dir, clock, native, capture)
}

#[test]
fn only_funding_domain_and_exact_host_capture_can_create_a_budget() {
    let (_dir, _clock, native, original) = fixture();
    assert!(matches!(
        native.owner(&original.issuer, &original.effect, false),
        Err(Error::Authority(_))
    ));
    assert!(matches!(
        native.apply(&signed_with_domain(
            &Instruction::Capture {
                capture: original.clone()
            },
            b"client-access\0"
        )),
        Err(Error::Authority(_))
    ));
    for changed in [
        {
            let mut c = original.clone();
            c.terms.account = "foreign".into();
            c
        },
        {
            let mut c = original.clone();
            c.physical_home = "copied-home".into();
            c
        },
        {
            let mut c = original.clone();
            c.terms.resource = "own-records".into();
            c
        },
        {
            let mut c = original.clone();
            c.terms.payer = Payer::Funded {
                funding_identity: "editable-balance".into(),
            };
            c
        },
        {
            let mut c = original.clone();
            c.issuer = "foreign-issuer".into();
            c
        },
    ] {
        assert!(native
            .apply(&signed(&Instruction::Capture { capture: changed }))
            .is_err());
    }
    let proof = signed(&Instruction::Capture {
        capture: original.clone(),
    });
    native.apply(&proof).unwrap();
    native.apply(&proof).unwrap();
    let owner = native
        .owner(&original.issuer, &original.effect, false)
        .unwrap();
    assert_eq!(owner.terms(), &original.terms);
    let mut changed = original.clone();
    changed.terms.grant = "second-grant".into();
    assert_eq!(
        native.apply(&signed(&Instruction::Capture { capture: changed })),
        Err(trillion_local::cause!(Error::Conflict)),
        "one funding effect cannot mint another grant"
    );
}

#[test]
fn independent_native_handles_share_one_finite_funded_home() {
    let (dir, clock, native, capture) = fixture();
    native
        .apply(&signed(&Instruction::Capture {
            capture: capture.clone(),
        }))
        .unwrap();
    let barrier = Arc::new(Barrier::new(8));
    let mut workers = Vec::new();
    for i in 0..8 {
        let other = Native::open(
            dir.path(),
            "account",
            keys(),
            clock.clone(),
            b"fixture-resource-funding:v1\0".to_vec(),
        )
        .unwrap();
        let c = capture.clone();
        let barrier = barrier.clone();
        workers.push(std::thread::spawn(move || {
            let owner = other.owner(&c.issuer, &c.effect, false).unwrap();
            barrier.wait();
            match owner.reserve(&format!("read-{i}"), "input", 25) {
                Ok(Reservation::New(_)) => true,
                Err(Error::Exhausted(_) | Error::Conflict(_)) => false,
                other => panic!("unexpected: {}", other.is_ok()),
            }
        }));
    }
    assert_eq!(
        workers
            .into_iter()
            .map(|w| w.join().unwrap())
            .filter(|accepted| *accepted)
            .count(),
        4
    );
    assert_eq!(
        native
            .owner(&capture.issuer, &capture.effect, false)
            .unwrap()
            .totals()
            .unwrap()
            .held,
        100
    );
}

#[test]
fn signed_revocation_blocks_dispatch_and_signed_recovery_keeps_obligations() {
    let (dir, clock, native, capture) = fixture();
    let capture_proof = signed(&Instruction::Capture {
        capture: capture.clone(),
    });
    native.apply(&capture_proof).unwrap();
    let owner = native
        .owner(&capture.issuer, &capture.effect, false)
        .unwrap();
    let Reservation::New(running) = owner.reserve("running", "input", 70).unwrap() else {
        panic!()
    };
    running.start().unwrap();
    let Reservation::New(waiting) = owner.reserve("waiting", "input", 20).unwrap() else {
        panic!()
    };
    let other = Native::open(
        dir.path(),
        "account",
        keys(),
        clock.clone(),
        b"fixture-resource-funding:v1\0".to_vec(),
    )
    .unwrap();
    other
        .apply(&signed(&Instruction::Revoke {
            issuer: capture.issuer.clone(),
            effect: capture.effect.clone(),
            grant: capture.terms.grant.clone(),
            physical_home: capture.physical_home.clone(),
            reason: "payer-withdrew".into(),
        }))
        .unwrap();
    assert_eq!(waiting.start(), Err(trillion_local::cause!(Error::Authority)));
    assert!(native
        .owner(&capture.issuer, &capture.effect, false)
        .is_err());
    native.apply(&capture_proof).unwrap();
    assert!(
        native
            .owner(&capture.issuer, &capture.effect, false)
            .is_err(),
        "capture replay must not reactivate"
    );
    running.finish(Some(11), false, "partial").unwrap();
    clock.0.store(2000, Ordering::SeqCst);
    native.apply(&capture_proof).unwrap(); // Exact recovery retries survive expiry.
    let recovered = other.owner(&capture.issuer, &capture.effect, true).unwrap();
    assert_eq!(recovered.recovery_page("", 100).unwrap().totals.held, 90);
    assert_eq!(
        recovered.reconcile("running", 11, "timeout"),
        Err(trillion_local::cause!(Error::Authority))
    );
    let proof = signed(&Instruction::Reconcile {
        issuer: capture.issuer.clone(),
        effect: capture.effect.clone(),
        grant: capture.terms.grant.clone(),
        physical_home: capture.physical_home.clone(),
        hold: "running".into(),
        units: 11,
        evidence: "verified-terminal-receipt".into(),
    });
    other.apply(&proof).unwrap();
    other.apply(&proof).unwrap();
    recovered
        .reconcile("running", 11, "verified-terminal-receipt")
        .unwrap();
    assert_eq!(recovered.recovery_page("", 100).unwrap().totals.used, 11);
}

#[test]
fn copied_home_and_byo_are_not_new_company_funds() {
    let (_dir, clock, native, mut capture) = fixture();
    capture.terms.payer = Payer::External;
    native
        .apply(&signed(&Instruction::Capture {
            capture: capture.clone(),
        }))
        .unwrap();
    assert_eq!(
        native
            .owner(&capture.issuer, &capture.effect, false)
            .unwrap()
            .terms()
            .payer,
        Payer::External
    );
    let copied = tempfile::tempdir().unwrap();
    let other = Native::open(
        copied.path(),
        "account",
        keys(),
        clock,
        b"fixture-resource-funding:v1\0".to_vec(),
    )
    .unwrap();
    assert_eq!(
        other.apply(&signed(&Instruction::Capture { capture })),
        Err(trillion_local::cause!(Error::Authority))
    );
}

#[test]
fn revoke_before_capture_cannot_be_reordered_into_new_dispatch() {
    let (_dir, _clock, native, capture) = fixture();
    let revoke = signed(&Instruction::Revoke {
        issuer: capture.issuer.clone(),
        effect: capture.effect.clone(),
        grant: capture.terms.grant.clone(),
        physical_home: capture.physical_home.clone(),
        reason: "revoked-before-delivery".into(),
    });
    native.apply(&revoke).unwrap();
    native.apply(&revoke).unwrap();
    assert_eq!(
        native.apply(&signed(&Instruction::Capture {
            capture: capture.clone()
        })),
        Err(trillion_local::cause!(Error::Conflict))
    );
    assert!(native
        .owner(&capture.issuer, &capture.effect, false)
        .is_err());
}

/// The host's funded allowance for the account files door: none until a trusted issuer's signed capture of unit
/// `namespace-file-bytes` is applied to the account's own protected home, then an `Allowance` over that capture that
/// admits bytes up to the grant and refuses past it; a revoked or expired capture opens none.
#[test]
fn the_host_opens_a_funded_byte_allowance_only_over_a_current_signed_capture() {
    use trillion_local::{
        account_files::source_reads::{Admission, SourceRead},
        resource_authority::budget::account_files::{Funded, UNIT},
    };
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(Clock(AtomicI64::new(100)));
    let domain = b"fixture-resource-funding:v1\0".to_vec();
    let funded = Funded::new(keys(), clock.clone(), domain.clone(), 1000, 200).unwrap();
    assert!(funded.open_allowance(dir.path(), "account").is_err(), "no capture, no allowance");
    let untrusting = Funded::new(Vec::new(), clock.clone(), domain.clone(), 1000, 200).unwrap();

    let home = funded.home(dir.path(), "account").unwrap();
    let mut bytes = capture(&home);
    bytes.terms.unit = UNIT.into();
    bytes.terms.limit = 2500;
    home.apply(&signed(&Instruction::Capture { capture: bytes.clone() })).unwrap();
    assert_eq!(home.current(UNIT).unwrap(), vec![(bytes.issuer.clone(), bytes.effect.clone())]);
    assert!(untrusting.open_allowance(dir.path(), "account").is_err(), "a host that trusts no issuer funds nothing");

    let allowance = funded.open_allowance(dir.path(), "account").unwrap();
    assert!(Arc::ptr_eq(&allowance, &funded.open_allowance(dir.path(), "account").unwrap()), "one allowance per account");
    let admission = Admission::from(allowance.clone());
    let read = |bytes| SourceRead { origin: "origin".into(), offset: 0, requested_bytes: bytes };
    let mut admitted = 0;
    let started = std::time::Instant::now();
    while started.elapsed() < std::time::Duration::from_secs(2) {
        if admission.admit_read(&read(100)).is_ok() { admitted += 100 } else { std::thread::sleep(std::time::Duration::from_millis(1)) }
    }
    assert_eq!(admitted, 2000, "two whole chunks of 1000 fit a grant of 2500; a third does not");
    assert!(admission.admit_read(&read(100)).is_err(), "past the grant every read is refused before dispatch");

    // Another account in the same folder has no capture of its own.
    assert!(funded.open_allowance(dir.path(), "another").is_err());
    // Revoked: the home answers no current capture, so no new allowance opens over it.
    home.apply(&signed(&Instruction::Revoke { issuer: bytes.issuer.clone(), effect: bytes.effect.clone(),
        grant: bytes.terms.grant.clone(), physical_home: bytes.physical_home.clone(), reason: "test".into() })).unwrap();
    assert!(home.current(UNIT).unwrap().is_empty());
    let fresh = Funded::new(keys(), clock.clone(), domain, 1000, 200).unwrap();
    assert!(fresh.open_allowance(dir.path(), "account").is_err());
}
