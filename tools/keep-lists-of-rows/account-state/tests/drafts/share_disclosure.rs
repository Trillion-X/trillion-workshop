// Synthetic identities exercise the exact transport-to-owner transfer, not an
// OAuth substitute. The original source's own custody still receives its parent.
fn principal(who: &str) -> Principal {
    Principal { kind: trillion_local::mcp::PrincipalKind::Person,
        account_id: "test-account".into(),
        sign_in: who.into(),
        client_id: "test-client".into(),
    }
}
fn call() -> crate::mcp::Operation {
    crate::mcp::Operation { person_present: None,
        resource: "@records".into(),
        operation: "read".into(),
        request_key: "test-operation".into(),
        input: serde_json::json!({"id":"one"}),
    }
}
struct ParentCustody;
impl FinalBodyCustody for ParentCustody {
    fn finish(
        self: Box<Self>,
        body: Body,
        who: &Principal,
        bearer: Zeroizing<Vec<u8>>,
        _: Arc<dyn Send + Sync>,
    ) -> Result<Body, crate::refusal_cause::CodedError<()>> {
        if who != &principal("grant:original-oauth") || bearer.as_slice() != b"synthetic-parent" {
            return Err(crate::refusal_cause::CodedError::new(()));
        }
        Ok(body)
    }
}
fn transferred(current: Arc<AtomicBool>) -> RequestDisclosure {
    let outer = RequestDisclosure::default();
    let child = outer.delegated_child();
    child.register(Box::new(ParentCustody)).unwrap();
    let proof = ShareActProof::admitted(
        &principal("grant:share"),
        b"synthetic-share",
        &principal("grant:original-oauth"),
        b"synthetic-parent",
        &call(),
        Arc::new(move || current.load(Ordering::Acquire)),
    );
    proof.transfer(&call(), &child, &outer).unwrap();
    drop(child);
    assert!(!outer.cancellation_flag().load(Ordering::Acquire));
    outer
}
#[test]
fn child_keeps_original_start_cancel_and_does_not_cancel_on_drop() {
    let outer = RequestDisclosure::default();
    let child = outer.delegated_child();
    assert_eq!(outer.started_at(), child.started_at());
    assert!(Arc::ptr_eq(
        &outer.cancellation_flag(),
        &child.cancellation_flag()
    ));
    let flag = child.cancellation_flag();
    drop(child);
    assert!(!flag.load(Ordering::Acquire));
    drop(outer);
    assert!(flag.load(Ordering::Acquire));
}
#[tokio::test]
async fn exact_share_transport_reaches_only_original_parent_custody() {
    let outer = transferred(Arc::new(AtomicBool::new(true)));
    let body = outer
        .take()
        .unwrap()
        .unwrap()
        .finish(
            Body::from("bounded answer"),
            &principal("grant:share"),
            Zeroizing::new(b"synthetic-share".to_vec()),
            Arc::new(()),
        )
        .unwrap();
    assert_eq!(
        axum::body::to_bytes(body, 100).await.unwrap(),
        "bounded answer"
    );
}
#[test]
fn wrong_outer_principal_or_bearer_refuses_delegation() {
    for (who, bearer) in [
        (
            principal("grant:other-share"),
            b"synthetic-share".as_slice(),
        ),
        (principal("grant:share"), b"other-share".as_slice()),
        (
            principal("grant:original-oauth"),
            b"synthetic-parent".as_slice(),
        ),
    ] {
        let outer = transferred(Arc::new(AtomicBool::new(true)));
        assert!(outer
            .take()
            .unwrap()
            .unwrap()
            .finish(
                Body::from("secret"),
                &who,
                Zeroizing::new(bearer.to_vec()),
                Arc::new(())
            )
            .is_err());
    }
}
#[test]
fn changed_operation_cannot_transfer_an_admitted_proof() {
    let outer = RequestDisclosure::default();
    let child = outer.delegated_child();
    let proof = ShareActProof::admitted(
        &principal("grant:share"),
        b"synthetic-share",
        &principal("grant:original-oauth"),
        b"synthetic-parent",
        &call(),
        Arc::new(|| true),
    );
    let mut changed = call();
    changed.input["id"] = serde_json::json!("different-record");
    assert!(proof.transfer(&changed, &child, &outer).is_err());
    assert!(outer.take().unwrap().is_none());
}
#[tokio::test]
async fn withdrawn_share_withholds_the_final_chunk() {
    let current = Arc::new(AtomicBool::new(true));
    let outer = transferred(current.clone());
    let body = outer
        .take()
        .unwrap()
        .unwrap()
        .finish(
            Body::from("secret"),
            &principal("grant:share"),
            Zeroizing::new(b"synthetic-share".to_vec()),
            Arc::new(()),
        )
        .unwrap();
    current.store(false, Ordering::Release);
    assert!(axum::body::to_bytes(body, 100).await.is_err());
}

#[test]
fn oauth_transfer_refuses_missing_original_source_custody() {
    let outer = RequestDisclosure::default();
    let child = outer.delegated_child();
    let proof = ShareActProof::admitted(
        &principal("grant:share"),
        b"synthetic-share",
        &principal("grant:original-oauth"),
        b"synthetic-parent",
        &call(),
        Arc::new(|| true),
    );
    assert!(proof.transfer(&call(), &child, &outer).is_err());
}

#[tokio::test]
async fn unprotected_personal_receipt_rechecks_original_key_and_gate_at_final_chunk() {
    let outer = RequestDisclosure::default();
    let child = outer.delegated_child();
    let key_current = Arc::new(AtomicBool::new(true));
    let check = key_current.clone();
    let proof = ShareActProof::admitted(
        &principal("grant:share"),
        b"synthetic-share",
        &principal("key:synthetic"),
        b"synthetic-personal",
        &call(),
        Arc::new(|| true),
    );
    proof
        .transfer_personal(
            &call(),
            &child,
            &outer,
            Arc::new(move || check.load(Ordering::Acquire)),
        )
        .unwrap();
    let body = outer
        .take()
        .unwrap()
        .unwrap()
        .finish(
            Body::from("receipt"),
            &principal("grant:share"),
            Zeroizing::new(b"synthetic-share".to_vec()),
            Arc::new(()),
        )
        .unwrap();
    key_current.store(false, Ordering::Release);
    assert!(axum::body::to_bytes(body, 100).await.is_err());
}

#[tokio::test]
async fn existing_source_custody_owns_its_original_gate_without_an_extra_owner_read_after_its_chunk(
) {
    let outer = RequestDisclosure::default();
    let child = outer.delegated_child();
    child.register(Box::new(ParentCustody)).unwrap();
    let proof = ShareActProof::admitted(
        &principal("grant:share"),
        b"synthetic-share",
        &principal("grant:original-oauth"),
        b"synthetic-parent",
        &call(),
        Arc::new(|| true),
    );
    proof
        .transfer_personal(
            &call(),
            &child,
            &outer,
            Arc::new(|| panic!("source custody already owns the original gate")),
        )
        .unwrap();
    let body = outer
        .take()
        .unwrap()
        .unwrap()
        .finish(
            Body::from("answer"),
            &principal("grant:share"),
            Zeroizing::new(b"synthetic-share".to_vec()),
            Arc::new(()),
        )
        .unwrap();
    assert_eq!(axum::body::to_bytes(body, 100).await.unwrap(), "answer");
}

struct FinalCheckCustody(Arc<AtomicBool>);
impl FinalBodyCustody for FinalCheckCustody {
    fn finish(
        self: Box<Self>,
        body: Body,
        _: &Principal,
        _: Zeroizing<Vec<u8>>,
        _: Arc<dyn Send + Sync>,
    ) -> Result<Body, crate::refusal_cause::CodedError<()>> {
        Ok(Body::new(FinalCheckBody {
            inner: body,
            final_check: self.0,
        }))
    }
}
struct FinalCheckBody {
    inner: Body,
    final_check: Arc<AtomicBool>,
}
impl http_body::Body for FinalCheckBody {
    type Data = axum::body::Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        assert!(
            !self.final_check.load(Ordering::Acquire),
            "outer wrapper must not add another poll after physical check"
        );
        let chunk = std::pin::Pin::new(&mut self.inner).poll_frame(cx);
        if matches!(&chunk, std::task::Poll::Ready(Some(Ok(_)))) {
            self.final_check.store(true, Ordering::Release);
        }
        chunk
    }
}
#[tokio::test]
async fn protected_chunk_never_reopens_source_after_its_physical_check() {
    let outer = RequestDisclosure::default();
    let child = outer.delegated_child();
    let final_check = Arc::new(AtomicBool::new(false));
    child
        .register(Box::new(FinalCheckCustody(final_check.clone())))
        .unwrap();
    let observed = final_check.clone();
    let proof = ShareActProof::admitted(
        &principal("grant:share"),
        b"synthetic-share",
        &principal("grant:original-oauth"),
        b"synthetic-parent",
        &call(),
        Arc::new(move || {
            assert!(
                !observed.load(Ordering::Acquire),
                "source read after physical check reopens erasure interval"
            );
            true
        }),
    );
    proof.transfer(&call(), &child, &outer).unwrap();
    let body = outer
        .take()
        .unwrap()
        .unwrap()
        .finish(
            Body::from("protected answer"),
            &principal("grant:share"),
            Zeroizing::new(b"synthetic-share".to_vec()),
            Arc::new(()),
        )
        .unwrap();
    assert_eq!(
        axum::body::to_bytes(body, 100).await.unwrap(),
        "protected answer"
    );
    assert!(final_check.load(Ordering::Acquire));
}

#[tokio::test]
async fn direct_share_attenuation_lives_through_its_output_then_drop_revokes_it() {
    use crate::account_rights::run_capability::{held, mint, Rights};
    let rights = Rights::declared(
        &serde_json::json!({"rights":[{"kind":"note","operations":["records:read"]}]}),
    )
    .unwrap();
    let capability = mint(
        "test-account",
        b"synthetic-parent",
        rights,
        None,
        Duration::from_secs(60),
    )
    .unwrap();
    let token = capability.token().to_owned();
    let run = held(token.as_bytes()).unwrap().unwrap();
    let current = run.current_checker();
    drop(run);
    let outer = RequestDisclosure::default();
    let child = outer.delegated_child();
    child.register(Box::new(ParentCustody)).unwrap();
    let proof = ShareActProof::admitted(
        &principal("grant:share"),
        b"synthetic-share",
        &principal("grant:original-oauth"),
        b"synthetic-parent",
        &call(),
        current.clone(),
    )
    .keeping_run(capability);
    proof.transfer(&call(), &child, &outer).unwrap();
    assert!(current());
    let body = outer
        .take()
        .unwrap()
        .unwrap()
        .finish(
            Body::from("bounded answer"),
            &principal("grant:share"),
            Zeroizing::new(b"synthetic-share".to_vec()),
            Arc::new(()),
        )
        .unwrap();
    let bytes = axum::body::to_bytes(body, 100).await.unwrap();
    assert_eq!(bytes, "bounded answer");
    assert!(current(), "output still owns exact live attenuation");
    drop(bytes);
    assert!(
        !current(),
        "dropping final output revokes the same capability"
    );
}


#[test]
fn the_inner_disclosure_refusal_keeps_its_cause_through_the_share_wrapper() {
    struct RefusingCustody(crate::refusal_cause::Cause);
    impl FinalBodyCustody for RefusingCustody {
        fn finish(self: Box<Self>, _: Body, _: &Principal, _: Zeroizing<Vec<u8>>,
            _: Arc<dyn Send + Sync>) -> Result<Body, crate::refusal_cause::CodedError<()>> {
            Err(crate::refusal_cause::CodedError::with_cause((), self.0))
        }
    }
    let original = trillion_local::cause!(condition: synthetic_inner_disclosure_refusal);
    let outer = RequestDisclosure::default();
    let child = outer.delegated_child();
    child.register(Box::new(RefusingCustody(original.clone()))).unwrap();
    let proof = ShareActProof::admitted(&principal("grant:share"), b"synthetic-share",
        &principal("grant:original-oauth"), b"synthetic-parent", &call(), Arc::new(|| true));
    proof.transfer(&call(), &child, &outer).unwrap();
    let refused = outer.take().unwrap().unwrap().finish(Body::from("private synthetic answer"),
        &principal("grant:share"), Zeroizing::new(b"synthetic-share".to_vec()), Arc::new(())).err().unwrap();
    assert_eq!(refused.cause(), original);
    assert!(!refused.cause().id().contains("private synthetic answer"));
}
