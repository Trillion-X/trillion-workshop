// Read-only original-result controls reuse the existing selected-account
// fixture and its current-key admission. No principal or key fixture is added.
use super::*;
use crate::local_account::record_writer::native_command_context::{
    NativeCommandResult, OriginalRecordsResultReadProof, SelectedRecordsWriteCall,
};
use crate::workspace_domain::DomainCommand;

struct RecordsParent {
    binding: CommandBinding,
    sign_in: String,
    command: DomainCommand,
    request: Request,
    context: Context,
}
impl RecordsParent {
    fn new(fixture: &Fixture, key: &str, words: &str) -> Self {
        let input = json!({"records":[{"id":"synthetic-original-result-page","type":"page",
            "value":{"words":words}}]});
        let parsed = ecma(&input.to_string());
        let mut binding = super::binding(fixture, &parsed, key);
        binding.operation = crate::record_write_model::write_command::Command::shipped()
            .unwrap()
            .operation()
            .to_owned();
        binding.identity = database_identity(&EcmaValue::Array(vec![
            EcmaValue::String(binding.operation.as_str().into()),
            parsed,
            EcmaValue::String(key.into()),
        ]));
        let command = DomainCommand {
            operation: binding.operation.clone(),
            input,
            request_key: key.into(),
            key_carried: true,
        };
        Self {
            binding,
            sign_in: format!("key:{}", fixture.key.identity()),
            command,
            request: Request {
                key: key.into(),
                sent_at_ms: 1_790_000_000_000,
            },
            context: Context {
                actor: json!({}),
                application_time: "2026-10-27T00:00:00.000Z".into(),
                system_time: "2026-10-27T00:00:00.000Z".into(),
                accepted_at_ms: 1_790_000_000_000,
            },
        }
    }
    fn call(&self) -> SelectedRecordsWriteCall<'_> {
        SelectedRecordsWriteCall {
            binding: &self.binding,
            sign_in: &self.sign_in,
            command: &self.command,
            request: &self.request,
            context: &self.context,
            cancel: Arc::new(AtomicBool::new(false)),
            deadline: Instant::now() + Duration::from_secs(10),
            within: None,
        cause: None,
            person_present: None,
        }
    }
    fn write(&self, fixture: &Fixture, owner: &mut LocalAccount) -> NativeCommandResult {
        owner
            .execute_selected_records_write_checked(
                &self.call(),
                &mut Ids::ordinary(),
                &|| fixture.assert_source_pin(),
                &mut current_key(fixture),
            )
            .unwrap()
    }
    fn recover(
        &self,
        fixture: &Fixture,
        owner: &mut LocalAccount,
    ) -> record_writer::Result<(NativeCommandResult, OriginalRecordsResultReadProof)> {
        let mut ids = Ids::ordinary();
        let answer = owner.recover_selected_records_write_with_proof_checked(
            &self.call(),
            &mut ids,
            &|| fixture.assert_source_pin(),
            &mut current_key(fixture),
        );
        assert_eq!(
            ids.next, 0,
            "readback allocates no execution, key or log identities"
        );
        answer
    }
    fn result_id(&self) -> String {
        format!(
            "{}:{}",
            crate::record_write_model::write_command::Command::shipped()
                .unwrap()
                .result_record()
                .kind,
            self.binding.permit_id
        )
    }
}
fn current_key(fixture: &Fixture) -> impl FnMut(&mut LocalAccount) -> AccountResult<()> + '_ {
    let key = fixture.key.identity();
    move |owner| {
        owner
            .personal_key(&key)?
            .map(|_| ())
            .ok_or(trillion_local::cause!(AccountError::KeyWithdrawn))
    }
}

#[test]
fn original_records_result_cold_read_succeeds_while_another_writer_is_reserved() {
    let fixture = setup();
    let parent = RecordsParent::new(&fixture, "synthetic-original-result-cold", "kept");
    let original = parent.write(&fixture, &mut fixture.open());
    let before = fixture.counts();
    let mut owner = fixture.open();
    let rival = Connection::open(&fixture.records).unwrap();
    rival.busy_timeout(Duration::ZERO).unwrap();
    rival.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert_eq!(owner.original_records_read_generation().unwrap(), 1);
    let (result, proof) = parent.recover(&fixture, &mut owner).unwrap();
    assert!(result.duplicate);
    assert_eq!(result.value, original.value);
    let (readers, routes) = owner.own_read_context().unwrap();
    assert!(proof.unchanged(&readers, OWNER, routes.as_ref()).unwrap());
    rival.execute_batch("ROLLBACK").unwrap();
    assert_eq!(fixture.counts(), before, "original readback writes nothing");
}

#[test]
fn original_records_result_missing_changed_input_and_revoked_admission_refuse() {
    let fixture = setup();
    let parent = RecordsParent::new(&fixture, "synthetic-original-result-current", "kept");
    let mut owner = fixture.open();
    let before = fixture.counts();
    assert!(matches!(
        parent.recover(&fixture, &mut owner),
        Err(record_writer::Error::OutcomeUnknown(_))
    ));
    assert_eq!(fixture.counts(), before);
    parent.write(&fixture, &mut owner);
    let before = fixture.counts();
    let changed = RecordsParent::new(&fixture, "synthetic-original-result-current", "different");
    assert!(matches!(
        changed.recover(&fixture, &mut owner),
        Err(record_writer::Error::Conflict(_))
    ));
    let mut other = RecordsParent::new(&fixture, "synthetic-original-result-current", "kept");
    other.binding.owner = "synthetic-other-owner".into();
    assert!(other.recover(&fixture, &mut owner).is_err());
    assert!(matches!(
        owner.recover_selected_records_write_with_proof_checked(
            &parent.call(),
            &mut Ids::ordinary(),
            &|| fixture.assert_source_pin(),
            &mut |_| Err(trillion_local::cause!(AccountError::KeyWithdrawn))
        ),
        Err(record_writer::Error::Refused(_))
    ));
    assert_eq!(fixture.counts(), before);
}

#[test]
fn original_records_result_proof_withholds_a_later_erased_key_or_result() {
    for erase_key in [true, false] {
        let fixture = setup();
        let parent = RecordsParent::new(&fixture, "synthetic-original-result-erasure", "kept");
        let mut owner = fixture.open();
        parent.write(&fixture, &mut owner);
        let (_, proof) = parent.recover(&fixture, &mut owner).unwrap();
        if erase_key {
            fixture.rewrite(
                crate::local_account::own_records::KEYS,
                &parent.result_id(),
                Some(json!({"erased":true})),
            );
        } else {
            fixture.rewrite(
                crate::local_account::own_records::RESOURCE,
                &parent.result_id(),
                None,
            );
        }
        let before = fixture.counts();
        let (readers, routes) = owner.own_read_context().unwrap();
        assert!(!proof.unchanged(&readers, OWNER, routes.as_ref()).unwrap());
        assert!(parent.recover(&fixture, &mut owner).is_err());
        assert_eq!(
            fixture.counts(),
            before,
            "erased outcomes remain unknown without a repair write"
        );
    }
}

#[test]
fn original_records_result_proof_refuses_generation_file_or_sidecar_changes() {
    for change in 0..3 {
        let fixture = setup();
        let parent = RecordsParent::new(&fixture, "synthetic-original-result-source", "kept");
        let mut owner = fixture.open();
        parent.write(&fixture, &mut owner);
        let (_, proof) = parent.recover(&fixture, &mut owner).unwrap();
        let (readers, routes) = owner.own_read_context().unwrap();
        match change {
            0 => {
                let mut header = fixture.current("own-resource-identity", "1").unwrap();
                header["generation"] = json!(2);
                fixture.rewrite("own-resource-identity", "1", Some(header));
                assert!(!proof.unchanged(&readers, OWNER, routes.as_ref()).unwrap());
            }
            1 => {
                let saved = fixture.records.with_extension("retained");
                fs::rename(&fixture.records, &saved).unwrap();
                fs::write(&fixture.records, b"replaced source").unwrap();
                assert!(!proof.unchanged(&readers, OWNER, routes.as_ref()).unwrap());
                fs::remove_file(&fixture.records).unwrap();
                fs::rename(saved, &fixture.records).unwrap();
            }
            _ => {
                let wal = fixture.records.with_file_name("records.sqlite-wal");
                let saved = fixture.records.with_extension("retained-wal");
                let existed = wal.exists();
                if existed {
                    fs::rename(&wal, &saved).unwrap();
                }
                std::os::unix::fs::symlink(&saved, &wal).unwrap();
                assert!(!proof.unchanged(&readers, OWNER, routes.as_ref()).unwrap());
                fs::remove_file(&wal).unwrap();
                if existed {
                    fs::rename(saved, wal).unwrap();
                }
            }
        }
    }
}


fn mark_next_command_committed(fixture: &Fixture) -> Arc<AtomicBool> {
    let committed = Arc::new(AtomicBool::new(false));
    let seen = committed.clone();
    crate::local_account::record_writer::native_command_context::AFTER_COMMIT
        .lock().unwrap()
        .push((fixture.records.clone(), Box::new(move || seen.store(true, Ordering::Release))));
    committed
}

fn write_with_current(
    parent: &RecordsParent,
    fixture: &Fixture,
    owner: &mut LocalAccount,
    current: &mut dyn FnMut(&mut LocalAccount) -> AccountResult<()>,
) -> record_writer::Result<NativeCommandResult> {
    owner.execute_selected_records_write_checked(
        &parent.call(), &mut Ids::ordinary(), &|| fixture.assert_source_pin(), current,
    )
}

#[test]
fn committed_delivery_does_not_spend_local_snapshot_budget_on_current_admission() {
    let fixture = setup();
    let parent = RecordsParent::new(&fixture, "synthetic-delivery-slow-admission", "kept");
    let mut owner = fixture.open();
    let committed = mark_next_command_committed(&fixture);
    let slowed = Arc::new(AtomicBool::new(false));
    let mut key_current = current_key(&fixture);
    let mut current = |owner: &mut LocalAccount| {
        if committed.load(Ordering::Acquire) && !slowed.swap(true, Ordering::AcqRel) {
            // A genuine caller check can outlive the local snapshot budget.
            // It remains current and bounded by its own admission owner.
            std::thread::sleep(DELIVERY_BOUND + Duration::from_millis(10));
        }
        key_current(owner)
    };
    let before = fixture.counts();
    let first = write_with_current(&parent, &fixture, &mut owner, &mut current).unwrap();
    assert!(slowed.load(Ordering::Acquire));
    assert!(!first.duplicate);
    assert_eq!(fixture.counts().1, before.1 + 1);
    drop(owner);
    let before = fixture.counts();
    let repeated = parent.write(&fixture, &mut fixture.open());
    assert!(repeated.duplicate);
    assert_eq!(first.value, repeated.value);
    assert_eq!(fixture.counts(), before, "cold same-key delivery never repeats the effect");
}

#[test]
fn committed_delivery_rechecks_result_and_key_after_current_admission() {
    for erase_key in [true, false] {
        let fixture = setup();
        let parent = RecordsParent::new(&fixture, "synthetic-delivery-erased-result", "kept");
        let mut owner = fixture.open();
        let committed = mark_next_command_committed(&fixture);
        let mut erased = false;
        let mut key_current = current_key(&fixture);
        let mut current = |owner: &mut LocalAccount| {
            if committed.load(Ordering::Acquire) && !erased {
                erased = true;
                if erase_key {
                    fixture.rewrite(crate::local_account::own_records::KEYS,
                        &parent.result_id(), Some(json!({"erased":true})));
                } else {
                    fixture.rewrite(crate::local_account::own_records::RESOURCE,
                        &parent.result_id(), None);
                }
            }
            key_current(owner)
        };
        assert!(write_with_current(&parent, &fixture, &mut owner, &mut current).is_err(),
            "a current callback erased the protected result before delivery");
        assert!(erased);
        let before = fixture.counts();
        assert!(parent.recover(&fixture, &mut owner).is_err());
        assert_eq!(fixture.counts(), before, "erasure never causes an effect replay");
    }
}

#[test]
fn committed_delivery_withholds_a_genuinely_withdrawn_caller() {
    let fixture = setup();
    let parent = RecordsParent::new(&fixture, "synthetic-delivery-withdrawn-caller", "kept");
    let mut owner = fixture.open();
    let key_path = fixture.kv.clone();
    let key_id = fixture.key.identity();
    crate::local_account::record_writer::native_command_context::AFTER_COMMIT
        .lock().unwrap().push((fixture.records.clone(), Box::new(move || {
            Connection::open(&key_path).unwrap().execute(
                "DELETE FROM _mf_entries WHERE key=?", [format!("personal-key:{key_id}")],
            ).unwrap();
        })));
    let before = fixture.counts();
    assert!(matches!(write_with_current(&parent, &fixture, &mut owner, &mut current_key(&fixture)),
        Err(record_writer::Error::CommittedAnswerWithheld(_))));
    assert_eq!(fixture.counts().1, before.1 + 1, "the original effect is already committed");
    let before = fixture.counts();
    assert!(parent.recover(&fixture, &mut owner).is_err());
    assert_eq!(fixture.counts(), before);
}

#[test]
fn noncanonical_original_policy_cannot_enroll_a_scoped_history() {
    let fixture = noncanonical_setup();
    let parent = scoped_parent(&fixture, "noncanonical-domain", "must-refuse");
    let before = primary_domain_stamps(&fixture);
    let answer = fixture.open().execute_selected_records_write_checked(
        &parent.call(), &mut Ids::ordinary(), &|| fixture.assert_source_pin(), &mut current_key(&fixture));
    assert!(matches!(answer, Err(record_writer::Error::Refused(_))));
    assert_eq!(primary_domain_stamps(&fixture), before);
    let policy = Connection::open(fixture.root.join("policy.sqlite")).unwrap();
    let enrolled: i64 = policy.query_row("SELECT count(*) FROM policy_directory WHERE name LIKE 'native-resource-incarnation:%'", [], |row|row.get(0)).unwrap();
    assert_eq!(enrolled, 0, "a refusal cannot bless the original noncanonical policy");
}

fn scoped_parent(fixture: &Fixture, key: &str, words: &str) -> RecordsParent {
    let mut parent = RecordsParent::new(fixture, key, words);
    parent.command.input["scope"] = json!({"id":"synthetic-domain","incarnation":"first","generation":1,"create":true});
    bind_scoped_input(&mut parent);
    parent
}

fn bind_scoped_input(parent: &mut RecordsParent) {
    let input = ecma(&parent.command.input.to_string());
    parent.binding.input_identity = database_identity(&input).strip_prefix("1f:").unwrap().to_owned();
    parent.binding.identity = database_identity(&EcmaValue::Array(vec![
        EcmaValue::String(parent.binding.operation.as_str().into()), input,
        EcmaValue::String(parent.request.key.as_str().into()),
    ]));
}

#[test]
fn one_domain_effect_and_receipt_retry_leave_the_primary_unchanged() {
    let fixture = setup();
    let parent = scoped_parent(&fixture,"synthetic-domain-retry","once");
    let before = primary_domain_stamps(&fixture);
    let first = parent.write(&fixture,&mut fixture.open());
    assert!(!first.duplicate);
    let duplicate = parent.write(&fixture,&mut fixture.open());
    assert!(duplicate.duplicate);
    assert_eq!(first.value, duplicate.value);
    let (recovered, proof) = parent.recover(&fixture,&mut fixture.open()).unwrap();
    assert_eq!(first.value,recovered.value);
    assert!(proof.domain.is_some());
    let after = primary_domain_stamps(&fixture);
    assert_eq!(before,after,"no effect, key, index or receipt is published to the primary");
}

#[test]
fn one_domain_precommit_refusal_rolls_back_effect_keys_indexes_and_receipt() {
    let fixture = setup();
    let parent = scoped_parent(&fixture,"synthetic-domain-refused","not committed");
    let mut checks = 0;
    let result = fixture.open().execute_selected_records_write_checked(
        &parent.call(),&mut Ids::ordinary(),&|| fixture.assert_source_pin(),
        &mut |owner| {
            checks += 1;
            current_key(&fixture)(owner)?;
            if checks >= 3 { return Err(trillion_local::cause!(AccountError::RightsRefused)); }
            Ok(())
        },
    );
    assert!(result.is_err());
    assert!(parent.recover(&fixture,&mut fixture.open()).is_err(),"a refused transaction has no receipt");
    let first = parent.write(&fixture,&mut fixture.open());
    assert!(!first.duplicate,"rollback left no duplicate identity or key");
}

#[test]
fn one_domain_read_proof_holds_no_writer_reservation_while_output_stalls() {
    let fixture = setup();
    let parent = scoped_parent(&fixture,"synthetic-domain-stalled","first");
    parent.write(&fixture,&mut fixture.open());
    let (_, retained) = parent.recover(&fixture,&mut fixture.open()).unwrap();
    let next = scoped_parent(&fixture,"synthetic-domain-next","second");
    let mut next_owner = fixture.open();
    let mut ids = Ids::ordinary(); ids.next = 100;
    assert!(!next_owner.execute_selected_records_write_checked(&next.call(), &mut ids,
        &|| fixture.assert_source_pin(), &mut current_key(&fixture)).unwrap().duplicate);
    drop(next_owner);
    let mut owner = fixture.open();
    let (readers,routes) = owner.own_read_context().unwrap();
    assert!(retained.unchanged(&readers,OWNER,routes.as_ref()).unwrap(),"unrelated command does not invalidate the original result key");
}

fn primary_domain_stamps(fixture: &Fixture) -> Vec<i64> {
    let store = crate::storage::record_store_resources::open(&fixture.records, crate::sqlite_work::WorkMeter::new()).unwrap();
    [crate::local_account::own_records::RESOURCE, crate::local_account::own_records::KEYS,
     crate::local_account::own_records::COMMANDS, crate::local_account::own_records::IDENTITY]
        .iter().map(|resource| store.stamp(OWNER,resource).unwrap()).collect()
}

#[test]
fn one_domain_changed_input_and_stale_incarnation_cannot_replay_or_replace_history() {
    let fixture = setup();
    let parent = scoped_parent(&fixture,"synthetic-domain-bound","first");
    parent.write(&fixture,&mut fixture.open());
    let changed = scoped_parent(&fixture,"synthetic-domain-bound","changed");
    let mut owner = fixture.open();
    assert!(matches!(owner.execute_selected_records_write_checked(
        &changed.call(),&mut Ids::ordinary(),&|| fixture.assert_source_pin(),&mut current_key(&fixture)),
        Err(record_writer::Error::Conflict(_))));
    let mut stale = scoped_parent(&fixture,"synthetic-domain-stale","wrong history");
    stale.command.input["scope"]["incarnation"] = json!("replacement");
    assert!(owner.execute_selected_records_write_checked(
        &stale.call(),&mut Ids::ordinary(),&|| fixture.assert_source_pin(),&mut current_key(&fixture)).is_err());
    assert!(parent.recover(&fixture,&mut owner).is_ok());
}

#[test]
fn one_domain_commit_and_result_key_share_the_same_observer_snapshot() {
    let fixture = setup();
    let parent = scoped_parent(&fixture,"synthetic-domain-observer","kept");
    parent.write(&fixture,&mut fixture.open());
    let (_,proof) = parent.recover(&fixture,&mut fixture.open()).unwrap();
    let result_id = parent.result_id();
    proof.domain.as_ref().unwrap().readers().unwrap().read::<_,crate::records::Error>(|store| {
        for (resource,id) in [
            (crate::local_account::own_records::RESOURCE,"synthetic-original-result-page"),
            (crate::local_account::own_records::RESOURCE,result_id.as_str()),
            (crate::local_account::own_records::KEYS,result_id.as_str()),
            (crate::local_account::own_records::COMMANDS,parent.binding.permit_id.as_str()),
        ] {
            assert!(store.held_record_with_version(OWNER,resource,id)?.1.is_some(),"the complete committed closure is visible");
        }
        Ok(())
    }).unwrap();
}

#[test]
fn one_domain_revoked_after_commit_keeps_effect_but_withholds_result() {
    let fixture = setup();
    let parent = scoped_parent(&fixture,"synthetic-domain-revoked","committed");
    let mut owner = fixture.open();
    let domain = owner.selected_command_domain(&parent.command.input,OWNER,1).unwrap().unwrap();
    let path = domain.writer().unwrap().path().to_path_buf();
    let key_path = fixture.kv.clone();
    let key_id = fixture.key.identity();
    crate::local_account::record_writer::native_command_context::AFTER_COMMIT
        .lock().unwrap().push((path,Box::new(move || {
            Connection::open(&key_path).unwrap().execute("DELETE FROM _mf_entries WHERE key=?",
                [format!("personal-key:{key_id}")]).unwrap();
        })));
    assert!(matches!(write_with_current(&parent,&fixture,&mut owner,&mut current_key(&fixture)),
        Err(record_writer::Error::CommittedAnswerWithheld(_))));
    domain.readers().unwrap().read::<_,crate::records::Error>(|store| {
        assert!(store.held_record_with_version(OWNER,crate::local_account::own_records::COMMANDS,
            &parent.binding.permit_id)?.1.is_some());
        Ok(())
    }).unwrap();
    assert!(parent.recover(&fixture,&mut owner).is_err());
}

#[test]
fn one_domain_erased_result_key_and_cancellation_refuse_before_disclosure() {
    let fixture = setup();
    let parent = scoped_parent(&fixture,"synthetic-domain-erasure","kept");
    let mut owner = fixture.open();
    parent.write(&fixture,&mut owner);
    let (_,proof) = parent.recover(&fixture,&mut owner).unwrap();
    let path = proof.domain.as_ref().unwrap().readers().unwrap().path().to_path_buf();
    let mut store = crate::storage::record_store_resources::open(&path,crate::sqlite_work::WorkMeter::new()).unwrap();
    let (version,_) = store.held_record_with_version(OWNER,crate::local_account::own_records::KEYS,&parent.result_id()).unwrap();
    store.mutate(OWNER,crate::local_account::own_records::KEYS,Mutation {
        id:parent.result_id(),expected_version:version,request_key:"erase-domain-result-key".into(),deleted:false,value:json!({"erased":true}),
    }).unwrap();
    let (readers,routes) = owner.own_read_context().unwrap();
    assert!(!proof.unchanged(&readers,OWNER,routes.as_ref()).unwrap());
    assert!(parent.recover(&fixture,&mut owner).is_err());
    let call = parent.call(); call.cancel.store(true,Ordering::Release);
    assert!(owner.recover_selected_records_write_with_proof_checked(&call,&mut Ids::ordinary(),
        &|| fixture.assert_source_pin(),&mut current_key(&fixture)).is_err());
}

#[test]
fn one_domain_base_generation_changed_before_commit_refuses_the_whole_effect() {
    let fixture = setup();
    let parent = scoped_parent(&fixture,"synthetic-domain-generation","not committed");
    let mut owner = fixture.open();
    let domain = owner.selected_command_domain(&parent.command.input,OWNER,1).unwrap().unwrap();
    let domain_path = domain.readers().unwrap().path().to_path_buf();
    let mut changed = false;
    let result = owner.execute_selected_records_write_checked(
        &parent.call(),&mut Ids::ordinary(),&|| fixture.assert_source_pin(),
        &mut |owner| {
            current_key(&fixture)(owner)?;
            // Canonical enrollment performs its own admission checks. Trigger
            // this fault only after the actual domain writer has opened.
            if !changed && domain_path.is_file() {
                changed = true;
                let mut header = fixture.current(crate::local_account::own_records::IDENTITY,"1").unwrap();
                header["generation"] = json!(2);
                fixture.rewrite(crate::local_account::own_records::IDENTITY,"1",Some(header));
            }
            Ok(())
        });
    assert!(changed, "the actual domain-open boundary was reached before withdrawal");
    assert!(result.is_err());
    assert!(parent.recover(&fixture,&mut owner).is_err());
    domain.readers().unwrap().read::<_,crate::records::Error>(|store| {
        assert!(store.held_record_with_version(OWNER,crate::local_account::own_records::COMMANDS,
            &parent.binding.permit_id)?.1.is_none());
        assert!(store.held_record_with_version(OWNER,crate::local_account::own_records::RESOURCE,
            "synthetic-original-result-page")?.1.is_none());
        Ok(())
    }).unwrap();
}

#[test]
fn one_domain_same_expected_state_has_one_native_successor() {
    let fixture = setup();
    let mut owner = fixture.open();
    let baseline = scoped_parent(&fixture,"synthetic-domain-cas-base","baseline");
    baseline.write(&fixture,&mut owner);
    let mut a = scoped_parent(&fixture,"synthetic-domain-cas-a","a");
    let mut b = scoped_parent(&fixture,"synthetic-domain-cas-b","b");
    for parent in [&mut a,&mut b] {
        parent.command.input["records"][0]["expected"] = json!({"type":"page","value":{"words":"baseline"}});
        bind_scoped_input(parent);
    }
    let a_owner = owner.command_owner().unwrap();
    let b_owner = owner.command_owner().unwrap();
    let a_domain = a_owner.selected_command_domain(&baseline.command.input,OWNER,1).unwrap().unwrap();
    let b_domain = b_owner.selected_command_domain(&baseline.command.input,OWNER,1).unwrap().unwrap();
    assert!(Arc::ptr_eq(&a_domain.writer().unwrap(),&b_domain.writer().unwrap()),
        "request-owned account contexts retain the same bounded domain owner");
    let key = fixture.key.identity();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let launch = |mut actor: LocalAccount, parent: RecordsParent, first_id, key: String, barrier: Arc<std::sync::Barrier>| {
        std::thread::spawn(move || {
            let mut ids = Ids::ordinary(); ids.next = first_id;
            barrier.wait();
            let result = actor.execute_selected_records_write_checked(&parent.call(),&mut ids,&|| Ok(()),
                &mut |owner| owner.personal_key(&key)?.map(|_| ()).ok_or(trillion_local::cause!(AccountError::KeyWithdrawn)));
            (parent,result)
        })
    };
    let a = launch(a_owner,a,100,key.clone(),barrier.clone());
    let b = launch(b_owner,b,200,key,barrier.clone());
    barrier.wait();
    let outcomes = [a.join().unwrap(),b.join().unwrap()];
    assert_eq!(outcomes.iter().filter(|(_,result)| result.is_ok()).count(),1);
    for (parent,result) in &outcomes {
        let mut ids = Ids::ordinary(); ids.next = 300;
        let retried = owner.execute_selected_records_write_checked(&parent.call(),&mut ids,
            &|| fixture.assert_source_pin(),&mut current_key(&fixture));
        if result.is_ok() { assert!(retried.unwrap().duplicate); }
        else { assert!(matches!(retried,Err(record_writer::Error::Conflict(_)))); }
    }
    let domain = owner.selected_command_domain(&baseline.command.input,OWNER,1).unwrap().unwrap();
    domain.readers().unwrap().read::<_,crate::records::Error>(|store| {
        assert_eq!(store.held_record_with_version(OWNER,crate::local_account::own_records::RESOURCE,
            "synthetic-original-result-page")?.0,2,"only one successor version committed");
        Ok(())
    }).unwrap();
}

#[test]
fn physical_domain_authority_is_installed_only_with_a_new_logical_domain() {
    use crate::local_account::own_records::InCommand;
    let fixture = setup();
    let owner = fixture.open();
    let parent = scoped_parent(&fixture, "physical-domain", "synthetic");
    let domain = owner.selected_command_domain(&parent.command.input, OWNER, 1).unwrap().unwrap();
    let writer = domain.writer().unwrap();
    let source = writer.lend(Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(10)).unwrap();
    let tx = source.begin_waiting(crate::storage::sqlite::TransactionBehavior::Immediate, Instant::now() + Duration::from_secs(10)).unwrap();
    let mut records = InCommand::lend(&tx, OWNER, InCommand::limits(&tx, writer.path()).unwrap()).unwrap();
    records.command_domain_with_authority(domain.selection(), "first-physical-token").unwrap();
    assert_eq!(records.command_authority().unwrap(), "first-physical-token");
    assert!(records.command_domain_with_authority(domain.selection(), "different-token").is_err());
    drop(records); tx.commit().unwrap();
    domain.readers().unwrap().read::<_, crate::records::Error>(|store| {
        assert_eq!(crate::local_account::own_records::domain_authority(&store, OWNER, &domain.selection().identity())?, "first-physical-token");
        let mut other = domain.selection().identity(); other.incarnation.push_str("-other");
        assert!(crate::local_account::own_records::domain_authority(&store, OWNER, &other).is_err());
        Ok(())
    }).unwrap();
    let tx = source.begin_waiting(crate::storage::sqlite::TransactionBehavior::Immediate, Instant::now() + Duration::from_secs(10)).unwrap();
    let mut raw = crate::workspace_store::lend_store(&tx, crate::storage::sqlite::Access::Write).unwrap();
    let version = raw.held_record_with_version(OWNER, crate::local_account::own_records::IDENTITY, "command-authority").unwrap().0;
    raw.mutate_local_with_check(OWNER, crate::local_account::own_records::IDENTITY, crate::records::Mutation {
        id: "command-authority".into(), expected_version: version, request_key: "remove-physical-proof".into(),
        deleted: true, value: serde_json::Value::Null,
    }, || Ok(())).unwrap();
    drop(raw);
    let mut records = InCommand::lend(&tx, OWNER, InCommand::limits(&tx, writer.path()).unwrap()).unwrap();
    assert!(records.command_domain_with_authority(domain.selection(), "new-token").is_err(), "create cannot bless existing headerless history");
    drop(records); tx.commit().unwrap();
}

#[test]
fn native_internal_cas_rolls_back_failed_ack_and_currentness_then_retries_one_frame() {
    use crate::storage::record_store_resources::carry::{commit_log, live_adopt};
    use crate::records::{changes::{AccountChanges, HeldChanges, Moved}, Mutation};
    let fixture = setup();
    let mut owner = fixture.open();
    let parent = scoped_parent(&fixture, "native-internal-cas", "initial");
    parent.write(&fixture, &mut owner);
    let mut input = parent.command.input.clone(); input["scope"]["create"] = serde_json::json!(false);
    let domain = owner.selected_command_domain(&input, OWNER, 1).unwrap().unwrap();
    let history = serde_json::to_value(domain.selection().identity()).unwrap();
    let slot = live_adopt::command_slot(OWNER, &history).unwrap();
    let limits = crate::storage::record_store::settings::shipped().unwrap().live_adoption;
    let authority = owner.native_domain_authority(&domain.selection().identity(), Arc::new(AtomicBool::new(false)),
        Instant::now()+Duration::from_secs(10), &mut current_key(&fixture)).unwrap();
    let mutation = |id: &str| Mutation { id: id.into(), expected_version: 0, request_key: id.into(),
        deleted: false, value: serde_json::json!({"synthetic":true}) };
    let resource = crate::local_account::own_records::COMMANDS;
    let notices = AccountChanges::of(OWNER).unwrap(); let mut cursor = notices.cursor();
    let mutate = |input, fail_ack: bool, fail_current: bool| {
        let acknowledged = std::cell::Cell::new(false);
        crate::local_account::own_records::mutate_internal_checked(&domain, &authority, OWNER, resource, input,
            Arc::new(AtomicBool::new(false)), Instant::now()+Duration::from_secs(10), true,
            || if fail_current && acknowledged.get() { Err(trillion_local::cause!(crate::records::Error::Conflict)) } else { Ok(()) },
            |store, frame| {
                if let Some(frame) = frame {
                    assert_eq!(commit_log::frontiers(store, &slot, limits).unwrap().stored, frame.sequence);
                    assert!(!frame.effects.is_empty());
                }
                acknowledged.set(true);
                if fail_ack { Err(trillion_local::cause!(crate::records::Error::Unavailable)) } else { Ok(()) }
            }, || HeldChanges::begin_in_scope(Some(history.clone())), None)
    };
    for (id, ack, current) in [("synthetic-failed-ack",true,false),("synthetic-failed-current",false,true)] {
        assert!(mutate(mutation(id), ack, current).is_err());
        domain.readers().unwrap().read::<_, crate::records::Error>(|store| {
            assert!(store.current_record(OWNER, resource, id)?.is_none());
            assert_eq!(commit_log::frontiers(store.storage(), &slot, limits).unwrap().stored, 0);
            Ok(())
        }).unwrap();
        assert_eq!(cursor.wait(&notices, Duration::ZERO, &AtomicBool::new(false)), Moved::Still);
    }
    let committed = mutate(mutation("synthetic-one-cas"), false, false).unwrap();
    let duplicate = mutate(mutation("synthetic-one-cas"), false, false).unwrap();
    assert_eq!(committed, duplicate);
    domain.readers().unwrap().read::<_, crate::records::Error>(|store| {
        assert!(store.current_record(OWNER, resource, "synthetic-one-cas")?.is_some());
        assert_eq!(commit_log::frontiers(store.storage(), &slot, limits).unwrap().stored, 1);
        Ok(())
    }).unwrap();
    let Moved::Changes(changes) = cursor.wait(&notices, Duration::ZERO, &AtomicBool::new(false)) else { panic!("confirmed commit must publish"); };
    assert!(changes.iter().all(|change| change.scope.as_ref() == Some(&history)));
    assert_eq!(changes.iter().filter(|change| change.resource == resource && change.id == "synthetic-one-cas").count(), 1);
}

#[test]
fn native_complete_domain_adoption_captures_late_effect_keys_and_original_receipt() {
    use crate::storage::record_store_resources::{domains, StateResources, carry::live_adopt::{Fence, FenceGuard, Progress}};
    struct External;
    struct Held;
    impl FenceGuard for Held {}
    impl Fence for External {
        fn hold(&self, incarnation: &str) -> crate::storage::Result<Box<dyn FenceGuard + '_>> {
            if ["synthetic-source-epoch", "synthetic-target-epoch"].contains(&incarnation) { Ok(Box::new(Held)) }
            else { Err(trillion_local::cause!(crate::storage::Error::Moved)) }
        }
        fn hold_owned(self: Arc<Self>, incarnation: &str) -> crate::storage::Result<Box<dyn FenceGuard + Send + Sync>> {
            self.hold(incarnation)?;
            Ok(Box::new(Held))
        }
    }
    // This fixture is a synthetic external-authority positive control, never
    // claimed as production writer-lease qualification.
    let authority = Arc::new(External);
    let fixture = setup();
    let mut owner = fixture.open();
    let original = scoped_parent(&fixture, "native-move-first", "first");
    original.write(&fixture, &mut owner);
    let target_root = tempfile::tempdir().unwrap();
    let target_resources = Arc::new(StateResources::new(target_root.path(), crate::sqlite_work::WorkMeter::new()).unwrap());
    let mut source_selection: domains::Selection = serde_json::from_value(original.command.input["scope"].clone()).unwrap();
    source_selection.create = false;
    let mut target_selection = source_selection.clone(); target_selection.create = true;
    let target = domains::Bound::new(target_resources, OWNER, target_selection, 1).unwrap();
    let begin = |owner: &mut LocalAccount| owner.begin_command_domain_adoption(&source_selection, &target,
        "native-move", "synthetic-source-epoch", "synthetic-target-epoch", authority.clone(),
        Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(30),
        &|| fixture.assert_source_pin(), &mut current_key(&fixture)).unwrap();
    let mover = begin(&mut owner);
    let step = |mover: &crate::local_account::record_writer::native_command_context::NativeDomainAdoption, owner: &mut LocalAccount|
        mover.advance(owner, Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(30),
            &|| fixture.assert_source_pin(), &mut current_key(&fixture)).unwrap();
    assert_eq!(step(&mover, &mut owner), Progress::Copying);
    // An actual native command after the first copy page must publish its
    // effect, erased-field key, protected result and original receipt together.
    let late = scoped_parent(&fixture, "native-move-late", "late");
    let mut ids = Ids::ordinary(); ids.next = 100;
    let late_result = owner.execute_selected_records_write_checked(&late.call(), &mut ids,
        &|| fixture.assert_source_pin(), &mut current_key(&fixture)).unwrap();
    assert!(!late_result.duplicate);
    drop(mover);
    // Restart has no current external guard. Local copied metadata grants no
    // permission to reopen the old writer, even before the durable seal.
    let without_fence = scoped_parent(&fixture, "native-move-no-fence", "must refuse");
    let mut ids = Ids::ordinary(); ids.next = 200;
    assert!(owner.execute_selected_records_write_checked(&without_fence.call(), &mut ids,
        &|| fixture.assert_source_pin(), &mut current_key(&fixture)).is_err());
    let mover = begin(&mut owner);
    let mut progress = step(&mover, &mut owner);
    let mut turns = 0;
    while !matches!(progress, Progress::Active { .. }) {
        assert!(turns < 200, "bounded turns must finish this finite fixture");
        progress = step(&mover, &mut owner); turns += 1;
    }
    assert!(matches!(progress, Progress::Active { sealed_through: 1 }));
    let slot = crate::storage::record_store_resources::carry::live_adopt::command_slot(OWNER,
        &serde_json::to_value(source_selection.identity()).unwrap()).unwrap();
    let native_read = || target.readers().unwrap().read::<_, crate::records::Error>(|store| {
        crate::storage::record_store_resources::carry::live_adopt::native_access(store.storage(), &slot)
            .map_err(|_| trillion_local::cause!(crate::records::Error::Unavailable))
    });
    assert!(native_read().unwrap().is_some(), "Active requires an actual retained read permit");
    target.readers().unwrap().read::<_, crate::records::Error>(|store| {
        let row = store.current_record(OWNER, crate::local_account::own_records::RESOURCE,
            "synthetic-original-result-page")?.unwrap();
        assert!(row.value.to_string().contains("late"));
        for parent in [&original, &late] {
            for (resource, id) in [
                (crate::local_account::own_records::RESOURCE, parent.result_id()),
                (crate::local_account::own_records::KEYS, parent.result_id()),
                (crate::local_account::own_records::COMMANDS, parent.binding.permit_id.clone()),
            ] { assert!(store.current_record(OWNER, resource, &id)?.is_some(), "complete closure {resource}"); }
        }
        Ok(())
    }).unwrap();
    let mut ids = Ids::ordinary(); ids.next = 300;
    assert!(owner.execute_selected_records_write_checked(&without_fence.call(), &mut ids,
        &|| fixture.assert_source_pin(), &mut current_key(&fixture)).is_err(), "the source seal fences every later native commit");
    drop(mover);
    assert!(native_read().is_err(), "saved Active alone grants no restored read authority");
    // Simulate a lost final activation reply and reopening the same move.
    let recovered = begin(&mut owner);
    assert_eq!(step(&recovered, &mut owner), progress);
}


#[test]
fn committed_domain_retry_does_not_activate_another_model_revision() {
    use crate::local_account::own_records::{InCommand, IDENTITY};
    let fixture=setup();let parent=scoped_parent(&fixture,"synthetic-domain-model-retry","original");
    let mut owner=fixture.open();let first=parent.write(&fixture,&mut owner);
    let domain=owner.selected_command_domain(&parent.command.input,OWNER,1).unwrap().unwrap();
    let writer=domain.writer().unwrap();
    let model=crate::record_model_policy::Installed::from_rows(&[json!({"record_model": {
        "kinds":[{"type":"synthetic-later-model-kind"}]
    }})],true).unwrap();
    {
        let source=writer.lend(Arc::new(AtomicBool::new(false)),Instant::now()+Duration::from_secs(10)).unwrap();
        let tx=source.begin(crate::storage::sqlite::TransactionBehavior::Immediate).unwrap();
        let mut records=InCommand::lend(&tx,OWNER,InCommand::limits(&tx,writer.path()).unwrap()).unwrap();
        records.activate_command_closure(&domain.selection().identity(),&model).unwrap();
        drop(records);tx.commit().unwrap();
    }
    let held=||domain.readers().unwrap().read(|store|store.held_record_with_version(OWNER,IDENTITY,"command-closure")).unwrap();
    let before=held();let duplicate=parent.write(&fixture,&mut owner);
    assert!(duplicate.duplicate);assert_eq!(duplicate.value,first.value);
    assert_eq!(held(),before,"committed recovery never rewrites closure metadata under its original key");
}

#[test]
fn native_remote_domain_adoption_rechecks_canonical_seal_and_survives_request_fence_drop() {
    use crate::storage::{Storage,Intent};
    use crate::storage::record_store_resources::carry::{commit_log,live_adopt::{self as adoption,portable,Progress}};
    let fixture=setup();let mut owner=fixture.open();
    let original=scoped_parent(&fixture,"synthetic-remote-first","first");original.write(&fixture,&mut owner);
    let history:crate::storage::record_store_resources::domains::Identity=serde_json::from_value(
        serde_json::json!({"id":"synthetic-domain","incarnation":"first","generation":1})).unwrap();
    let cancel=Arc::new(AtomicBool::new(false));let until=Instant::now()+Duration::from_secs(30);
    let before=owner.native_domain_authority(&history,cancel.clone(),until,&mut current_key(&fixture)).unwrap();
    let revision=before.registration().revision;
    let drained=before.drain_native().unwrap();
    let (mut source,authority)=owner.prepare_remote_domain_source(&history,"synthetic-remote-move","synthetic-remote-request",revision,
        cancel.clone(),until,&mut current_key(&fixture),Some(drained)).unwrap();
    source.prepare(&authority,cancel.clone(),until).unwrap();
    let limits=crate::storage::record_store::settings::shipped().unwrap().live_adoption;
    let target=crate::storage::memory::Memory::open("record_store").unwrap();
    adoption::prepare(&target,&source.plan,false,limits,&authority).unwrap();
    let first=portable::request(&target,&source.plan,limits,&authority).unwrap().unwrap();
    let first_response={let held=source.writer.lend(cancel.clone(),until).unwrap();let storage=held.storage().unwrap();
        portable::export(&storage,&source.plan,&first,limits,&authority).unwrap()};
    portable::accept(&target,&source.plan,&first_response,limits,&authority).unwrap();
    // Capture an actual native successor after the first copied page. Its
    // field keys, original command result and receipt belong to that command.
    let late=scoped_parent(&fixture,"synthetic-remote-late","late");let mut ids=Ids::ordinary();ids.next=400;
    assert!(!owner.execute_selected_records_write_checked(&late.call(),&mut ids,&||fixture.assert_source_pin(),&mut current_key(&fixture)).unwrap().duplicate);
    let mut seal=None;
    for turn in 0..500 {
        let Some(request)=portable::request(&target,&source.plan,limits,&authority).unwrap() else {break;};
        let response={let held=source.writer.lend(cancel.clone(),until).unwrap();let storage=held.storage().unwrap();
            portable::export(&storage,&source.plan,&request,limits,&authority).unwrap()};
        if matches!(portable::accept(&target,&source.plan,&response,limits,&authority).unwrap(),portable::Accepted::AwaitSeal {..}) {
            let held=source.writer.lend(cancel.clone(),until).unwrap();let storage=held.storage().unwrap();
            seal=Some(portable::seal_reply(&storage,&source.plan,limits,&authority).unwrap());
        }
        assert!(turn<499,"bounded protocol finishes finite full synthetic history");
    }
    assert!(matches!(adoption::recover(&target,&source.plan,&authority).unwrap(),Progress::Ready {sealed_through:1}));
    // No caller-supplied seal text can retire canonical source authority.
    assert!(owner.change_native_domain_authority(&history,&crate::account_rights::resource_connection::NativeChange::Activate {
        request_key:"synthetic-forged-retirement".into(),expected_revision:authority.registration().revision,move_id:source.plan.move_id.clone(),
    },cancel.clone(),until,&mut current_key(&fixture),None).is_err());
    let fresh=owner.native_domain_authority(&history,cancel.clone(),until,&mut current_key(&fixture)).unwrap();
    let drained=fresh.drain_native().unwrap();
    source.activate_canonical(&mut owner,cancel.clone(),until,&mut current_key(&fixture),drained).unwrap();
    let current=owner.native_domain_authority(&history,cancel.clone(),until,&mut current_key(&fixture)).unwrap();
    assert_eq!(current.current_incarnation(),source.plan.target_incarnation);
    let head={let held=source.writer.lend(cancel.clone(),until).unwrap();let storage=held.storage().unwrap();
        (commit_log::frontiers(&storage,&source.plan.slot,limits).unwrap(),commit_log::last_digest(&storage,&source.plan.slot,limits).unwrap())};
    target.open_scope(Intent::Write).unwrap();
    let mut baseline=commit_log::MaterializedBaselineCursor::begin(&target,&source.plan.slot,head.0.materialized,head.1,limits).unwrap();
    while !baseline.step(&target).unwrap() {}baseline.finish(&target).unwrap();
    portable::activate(&target,&source.plan,&seal.unwrap(),limits,&current,|storage| {
        let mut records=crate::storage::record_store::RecordStore::new(storage,Box::new(crate::storage::record_store::RealClock),
            crate::storage::record_store::settings::Limits::fixed(1<<20,1<<30)).unwrap();
        crate::local_account::own_records::replace_domain_authority(&mut records,OWNER,&history,&source.plan.source_incarnation,&source.plan.target_incarnation,&source.plan.move_id)
            .map_err(|error| crate::carry_cause!(crate::storage::Error::Moved, error))
    }).unwrap();target.close_scope(true).unwrap();
    drop(authority);drop(before);drop(fresh);
    assert!(owner.execute_selected_records_write_checked(&scoped_parent(&fixture,"synthetic-retired-source","must refuse").call(),
        &mut Ids::ordinary(),&||fixture.assert_source_pin(),&mut current_key(&fixture)).is_err(),"the old actual source cannot be a writable fallback");
    // A new admitted request owns its own original canonical producer. No
    // global registration from the completed transfer request is retained.
    target.open_scope(Intent::Write).unwrap();
    let capture=adoption::CommandCapture::begin_admitted(&target,&source.plan.slot,limits,Some(Arc::new(current.clone()))).unwrap().unwrap();
    let native=capture.native_fence().unwrap();let _permit=native.hold(&source.plan.target_incarnation).unwrap();
    target.close_scope(false).unwrap();
    let records=crate::storage::record_store::RecordStore::new(&target,Box::new(crate::storage::record_store::RealClock),
        crate::storage::record_store::settings::Limits::fixed(1<<20,1<<30)).unwrap();
    assert!(records.current_record(OWNER,crate::local_account::own_records::RESOURCE,"synthetic-original-result-page").unwrap().unwrap().value.to_string().contains("late"));
    for parent in [&original,&late] {
        assert!(records.current_record(OWNER,crate::local_account::own_records::COMMANDS,&parent.binding.permit_id).unwrap().is_some(),"original protected receipt remains in the transferred command closure");
    }
}

/// Step the timer of a copy until it holds the writer turn: a write asks the timer for the turn and is refused until the
/// timer takes it (`Copies::write`, `WriteRefused::NotWriter`). A test's own cluster is stepped here once, before its writes.
fn hold_writer(copies: &crate::account::computers::copies::Copies) {
    for _ in 0..16 {
        if copies.holding().is_some() { return; }
        copies.tick();
    }
    assert!(copies.holding().is_some(), "the timer takes the writer turn of a copy with its voters");
}

#[test]
fn native_actual_group_ack_then_current_key_withdrawal_cannot_promote_aborted_effect() {
    use crate::account::computers::{self,AccountKey,ComputerSigner,ComputersRow,copies::{self,Copies,CopiesConfig,Link},messages::{Message,Answer,GroupAnswer}};
    use crate::secrets::secrets_key::{self,ComputerKey};
    use std::collections::HashMap;
    use std::sync::{Mutex,Weak,atomic::AtomicI64};
    struct Network {from:String,peers:Arc<Mutex<HashMap<String,Weak<Copies>>>>,withdraw:Arc<AtomicBool>,kv:PathBuf,key:String}
    impl Link for Network {
        fn send(&self,to:&str,message:&Message)->Option<Answer> {
            let peer=self.peers.lock().unwrap().get(to).and_then(Weak::upgrade)?;
            let answer=peer.answer(&self.from,message.clone());
            if matches!(&answer,Answer::Group {answer:GroupAnswer::Applied {..}}) && self.withdraw.swap(false,Ordering::AcqRel) {
                let db=Connection::open(&self.kv).unwrap();
                assert_eq!(db.execute("DELETE FROM _mf_entries WHERE key=?",[format!("personal-key:{}",self.key)]).unwrap(),1,
                    "the actual source credential is withdrawn after the peer durably acknowledged");
            }
            Some(answer)
        }
    }
    let fixture=setup();let mut owner=fixture.open();let peer_root=tempfile::tempdir().unwrap();
    let keys=[Arc::new(ComputerKey::from_bytes(vec![130;32]).unwrap()),Arc::new(ComputerKey::from_bytes(vec![131;32]).unwrap())];
    let ids=keys.iter().map(|key|ComputerSigner::of(key).unwrap().computer_id()).collect::<Vec<_>>();
    let account=AccountKey::generate().unwrap();let address=account.address();
    let row=ComputersRow::sign_with_voters(&address,1,&ids,&ids,&ids,&account).unwrap();
    let peers=Arc::new(Mutex::new(HashMap::new()));let withdraw=Arc::new(AtomicBool::new(false));
    let now=Arc::new(AtomicI64::new(chrono::Utc::now().timestamp_millis()));let root=secrets_key::generate().unwrap();
    let mut copies_set=Vec::new();
    for at in 0..2 {
        let folder=if at==0 {fixture.root.clone()}else{peer_root.path().to_path_buf()};
        let clock=now.clone();let raw=crate::account::rows::open(&folder).unwrap();
        let copies=Copies::new(CopiesConfig {user:"person".into(),address:address.clone(),owner:OWNER.into(),computer:ids[at].clone(),row:row.clone(),
            records:if at==0 {fixture.records.clone()}else{folder.join("records.sqlite")},limits:Some(crate::storage::record_store::settings::Limits::fixed(1<<20,1<<30)),sign_in:raw,stores:None},
            Arc::new(Network {from:ids[at].clone(),peers:peers.clone(),withdraw:if at==0 {withdraw.clone()}else{Arc::new(AtomicBool::new(false))},kv:fixture.kv.clone(),key:fixture.key.identity()}),
            Arc::new(move||clock.load(Ordering::Acquire))).unwrap().with_state(folder.clone())
            .with_secrets_key(keys[at].clone(),folder,Some(root.duplicate()));
        let copies=Arc::new(copies);peers.lock().unwrap().insert(ids[at].clone(),Arc::downgrade(&copies));copies_set.push(copies);
    }
    let source=&copies_set[0];let peer=&copies_set[1];
    hold_writer(&source);
    source.write(|store|store.mutate_local_with_check(OWNER,crate::local_account::own_records::RESOURCE,crate::records::Mutation {
        id:"synthetic-prime-copies".into(),expected_version:0,request_key:"synthetic-prime-copies".into(),deleted:false,value:json!({"synthetic":true})},||Ok(())).map(|_|())).unwrap();
    copies::register(source);
    let original=scoped_parent(&fixture,"synthetic-ack-rights-first","committed");original.write(&fixture,&mut owner);
    assert!(source.holding().is_some());
    withdraw.store(true,Ordering::Release);
    let late=scoped_parent(&fixture,"synthetic-ack-rights-aborted","must not commit");let mut ids_out=Ids::ordinary();ids_out.next=700;
    let outcome=owner.execute_selected_records_write_checked(&late.call(),&mut ids_out,&||fixture.assert_source_pin(),&mut current_key(&fixture));
    assert!(outcome.is_err(),"the real post-ack current-rights witness refuses the withdrawn key");
    assert!(!withdraw.load(Ordering::Acquire),"the test actually crossed a durable complete-group acknowledgement");
    let domain=owner.selected_command_domain(&original.command.input,OWNER,1).unwrap().unwrap();
    domain.readers().unwrap().read::<_,crate::records::Error>(|store| {
        let held=store.current_record(OWNER,crate::local_account::own_records::RESOURCE,"synthetic-original-result-page")?.unwrap();
        assert!(held.value.to_string().contains("committed"));assert!(!held.value.to_string().contains("must not commit"));Ok(())
    }).unwrap();
    source.hand_over_held();
    now.fetch_add(computers::settings().renew_every_ms as i64+computers::settings().clock_margin_ms+1,Ordering::AcqRel);
    peer.tick();
    assert!(peer.holding().is_some(),"exercise actual ordinary successor election after source rollback");
    let resource=crate::account::computers::copies::group_key(&domain.selection().identity(),crate::local_account::own_records::RESOURCE).unwrap();
    if let Ok(read)=peer.read(&resource,"synthetic-original-result-page") {
        let value=read.record.unwrap().value.to_string();
        assert!(!value.contains("must not commit"),"successor election cannot commit the source's rightfully aborted native effect");
    }
}

#[test]
fn native_retired_source_recovers_current_target_through_actual_copies_bootstrap() {
    use crate::account::computers::{AccountKey,ComputerSigner,ComputersRow,copies::{self,Copies,CopiesConfig,Link},messages::{Message,Answer}};
    use crate::secrets::secrets_key::{self,ComputerKey};
    use crate::storage::Intent;
    use crate::storage::record_store_resources::carry::{commit_log,live_adopt::{self as adoption,portable,Progress}};
    use std::{collections::HashMap,sync::{Mutex,Weak,atomic::AtomicI64}};
    struct Network {from:String,peers:Arc<Mutex<HashMap<String,Weak<Copies>>>>}
    impl Link for Network {fn send(&self,to:&str,message:&Message)->Option<Answer> {
        let peer=self.peers.lock().unwrap().get(to).and_then(Weak::upgrade)?;Some(peer.answer(&self.from,message.clone()))
    }}
    let fixture=setup();let mut owner=fixture.open();let peer_root=tempfile::tempdir().unwrap();
    let selected_state=crate::local_account::SelectedLocalState {root:fixture.root.clone(),receipt:fixture.receipt_pin.clone(),
        app_kv_sqlite:"storage/kv/trillion-local-app/current.sqlite".into(),app_kv_store:crate::local_account::EXISTING_APP_KV_STORE.into(),prior_processes:vec![]};
    let service=Arc::new(Mutex::new(crate::native_boot::SelectedAccount::chosen(owner.command_owner().unwrap(),
        crate::native_boot::Chosen::computer(selected_state,"https://synthetic-replica.example".into())).unwrap()));
    let maintenance=Arc::new(crate::native_entry::computer::domain_transfer::Handler::new(&service));
    let keys=[Arc::new(ComputerKey::from_bytes(vec![140;32]).unwrap()),Arc::new(ComputerKey::from_bytes(vec![141;32]).unwrap())];
    let ids=keys.iter().map(|key|ComputerSigner::of(key).unwrap().computer_id()).collect::<Vec<_>>();
    let account=AccountKey::generate().unwrap();let address=account.address();
    let row=ComputersRow::sign_with_voters(&address,1,&ids,&ids,&ids,&account).unwrap();
    let peers=Arc::new(Mutex::new(HashMap::new()));let now=Arc::new(AtomicI64::new(chrono::Utc::now().timestamp_millis()));let root=secrets_key::generate().unwrap();
    let mut nodes=Vec::new();
    for at in 0..2 {
        let folder=if at==0 {fixture.root.clone()}else{peer_root.path().to_path_buf()};let clock=now.clone();
        let raw=crate::account::rows::open(&folder).unwrap();
        let copies=Copies::new(CopiesConfig {user:"person".into(),address:address.clone(),owner:OWNER.into(),computer:ids[at].clone(),row:row.clone(),
            records:if at==0 {fixture.records.clone()}else{folder.join("records.sqlite")},limits:Some(crate::storage::record_store::settings::Limits::fixed(1<<20,1<<30)),sign_in:raw,stores:None},
            Arc::new(Network {from:ids[at].clone(),peers:peers.clone()}),Arc::new(move||clock.load(Ordering::Acquire))).unwrap().with_state(folder.clone())
            .with_secrets_key(keys[at].clone(),folder,Some(root.duplicate()));
        let copies=Arc::new(if at==0 {copies.with_domain_maintenance(maintenance.clone())}else{copies});
        if at==0 {maintenance.attach(&copies).unwrap();}
        peers.lock().unwrap().insert(ids[at].clone(),Arc::downgrade(&copies));nodes.push(copies);
    }
    let source_copies=&nodes[0];let target_copies=&nodes[1];
    hold_writer(&source_copies);
    source_copies.write(|store|store.mutate_local_with_check(OWNER,crate::local_account::own_records::RESOURCE,crate::records::Mutation {
        id:"synthetic-repair-prime".into(),expected_version:0,request_key:"synthetic-repair-prime".into(),deleted:false,value:json!({"synthetic":true})},||Ok(())).map(|_|())).unwrap();
    copies::register(source_copies);
    let original=scoped_parent(&fixture,"synthetic-repair-original","kept actual value");original.write(&fixture,&mut owner);
    let selected=owner.selected_command_domain(&original.command.input,OWNER,1).unwrap().unwrap();let history=selected.selection().identity();
    let cancel=Arc::new(AtomicBool::new(false));let until=Instant::now()+Duration::from_secs(30);
    let before=owner.native_domain_authority(&history,cancel.clone(),until,&mut current_key(&fixture)).unwrap();
    let drain=before.drain_native().unwrap();
    let (mut source,authority)=owner.prepare_remote_domain_source(&history,"synthetic-retire-and-repair","synthetic-retire-request",before.registration().revision,cancel.clone(),until,&mut current_key(&fixture),Some(drain)).unwrap();
    source.prepare(&authority,cancel.clone(),until).unwrap();let limits=crate::storage::record_store::settings::shipped().unwrap().live_adoption;
    let target=target_copies.open_domain_records(&history).unwrap();let storage=&**target.storage();storage.open_scope(Intent::Write).unwrap();
    let term=source_copies.holding().unwrap();let baseline=target_copies.qualify_domain_replica(storage,&ids[0],term,&history).unwrap();
    adoption::prepare_replica(storage,&source.plan,limits,&authority,&baseline).unwrap();storage.close_scope(true).unwrap();
    let mut seal=None;
    for turn in 0..500 {
        let Some(request)=portable::request(storage,&source.plan,limits,&authority).unwrap() else {break;};
        let response={let held=source.writer.lend(cancel.clone(),until).unwrap();let physical=held.storage().unwrap();portable::export(&physical,&source.plan,&request,limits,&authority).unwrap()};
        if matches!(portable::accept(storage,&source.plan,&response,limits,&authority).unwrap(),portable::Accepted::AwaitSeal {..}) {
            let held=source.writer.lend(cancel.clone(),until).unwrap();let physical=held.storage().unwrap();seal=Some(portable::seal_reply(&physical,&source.plan,limits,&authority).unwrap());
        }
        assert!(turn<499,"bounded portable image reaches its complete sealed comparison");
    }
    assert!(matches!(adoption::recover(storage,&source.plan,&authority).unwrap(),Progress::Ready {..}));
    let fresh=owner.native_domain_authority(&history,cancel.clone(),until,&mut current_key(&fixture)).unwrap();let drain=fresh.drain_native().unwrap();
    source.activate_canonical(&mut owner,cancel.clone(),until,&mut current_key(&fixture),drain).unwrap();
    let authority=owner.native_domain_authority(&history,cancel.clone(),until,&mut current_key(&fixture)).unwrap();
    let (head,digest,key)={let held=source.writer.lend(cancel.clone(),until).unwrap();let physical=held.storage().unwrap();
        (commit_log::frontiers(&physical,&source.plan.slot,limits).unwrap(),commit_log::last_digest(&physical,&source.plan.slot,limits).unwrap(),commit_log::opaque_map::wrapped_key(&physical,&source.plan.slot,limits).unwrap())};
    storage.open_scope(Intent::Write).unwrap();if let Some(key)=key {commit_log::opaque_map::bind_wrapped_key(storage,&source.plan.slot,&key,limits).unwrap();}
    let mut baseline=commit_log::MaterializedBaselineCursor::begin(storage,&source.plan.slot,head.materialized,digest,limits).unwrap();
    while !baseline.step(storage).unwrap() {}baseline.finish(storage).unwrap();
    portable::activate(storage,&source.plan,&seal.unwrap(),limits,&authority,|physical| {
        let mut records=crate::storage::record_store::RecordStore::new(physical,Box::new(crate::storage::record_store::RealClock),target.limits()).unwrap();
        crate::local_account::own_records::replace_domain_authority(&mut records,OWNER,&history,&source.plan.source_incarnation,&source.plan.target_incarnation,&source.plan.move_id).map_err(|error| crate::carry_cause!(crate::storage::Error::Moved, error))?;
        records.take_term(OWNER,&history.resource(OWNER).unwrap(),term,head.materialized).map_err(|error| crate::carry_cause!(crate::storage::Error::Moved, error))
    }).unwrap();storage.close_scope(true).unwrap();drop(target);
    assert!(source_copies.hand_over_domain_to(&history,&ids[1]).unwrap(),"actual writer handoff selects the activated target");
    let resource=crate::account::computers::copies::group_key(&history,crate::local_account::own_records::RESOURCE).unwrap();
    // A former source whose copy is byte-identical to the writer's is current, so it reads the writer's value. Its staleness
    // is refused by the settle bound once it falls behind (8eef414c3's retirement rule had no implementation; see #386).
    let current=source_copies.read(&resource,"synthetic-original-result-page").unwrap();
    assert!(current.record.unwrap().value.to_string().contains("kept actual value"),"the former source reads the writer's current value");
    // Past the settle bound the former source refuses reads: the writer's term has run out, so the copy cannot confirm its head
    // (observe_domain_head). The copy catches up again below, so this is a refusal, not a loss.
    now.fetch_add(crate::account::computers::settings().revocation_settle_ms+1,Ordering::AcqRel);
    assert!(source_copies.read(&resource,"synthetic-original-result-page").is_err(),"a former source past the settle bound refuses reads until it catches up");
    selected.readers().unwrap().read::<_,crate::records::Error>(|store| {
        assert!(crate::local_account::own_records::domain_current(&store,OWNER,&history)?);
        assert_eq!(crate::local_account::own_records::domain_authority(&store,OWNER,&history)?,source.plan.target_incarnation);
        assert!(store.current_record(OWNER,crate::local_account::own_records::COMMANDS,&original.binding.permit_id)?.is_some());Ok(())
    }).unwrap();
}

#[test]
fn native_lost_finalization_recovers_exact_original_receipt_before_redispatch() {
    use crate::account::computers::{AccountKey,ComputerSigner,ComputersRow,copies::{self,Copies,CopiesConfig,Link},messages::{Message,Answer,GroupRequest}};
    use crate::secrets::secrets_key::{self,ComputerKey};
    use std::collections::HashMap;
    use std::sync::{Mutex,Weak,atomic::AtomicI64};
    struct Network {from:String,peers:Arc<Mutex<HashMap<String,Weak<Copies>>>>,drop_finalize:Arc<AtomicBool>,dropped:Arc<AtomicBool>,select_receiver:Arc<AtomicBool>,parts:Mutex<HashMap<u64,Vec<Option<Vec<u8>>>>>}
    impl Link for Network {
        fn send(&self,to:&str,message:&Message)->Option<Answer> {
            let peer=self.peers.lock().unwrap().get(to).and_then(Weak::upgrade)?;
            let finalization=if matches!(message,Message::Group {request:GroupRequest::Finalize {..}}) {true}
                else if let Message::Part {transfer,index,count,bytes}=message {
                    use base64::Engine;
                    let decoded=base64::engine::general_purpose::STANDARD.decode(bytes).unwrap();
                    let mut parts=self.parts.lock().unwrap();
                    let held=parts.entry(*transfer).or_insert_with(||vec![None;*count as usize]);
                    assert_eq!(held.len(),*count as usize);held[*index as usize]=Some(decoded);
                    if held.iter().all(Option::is_some) {
                        let whole=held.iter().flat_map(|part|part.as_ref().unwrap().iter().copied()).collect::<Vec<_>>();
                        parts.remove(transfer);
                        matches!(serde_json::from_slice::<Message>(&whole).unwrap(),Message::Group {request:GroupRequest::Finalize {..}})
                    } else {false}
                } else {false};
            if finalization && self.drop_finalize.load(Ordering::Acquire) {self.dropped.store(true,Ordering::Release);return None;}
            if finalization && self.select_receiver.swap(false,Ordering::AcqRel) {copies::register(&peer);}
            let answer=peer.answer(&self.from,message.clone());
            Some(answer)
        }
    }
    let fixture=setup();let mut owner=fixture.open();let peer_root=tempfile::tempdir().unwrap();
    let keys=[Arc::new(ComputerKey::from_bytes(vec![160;32]).unwrap()),Arc::new(ComputerKey::from_bytes(vec![161;32]).unwrap())];
    let ids=keys.iter().map(|key|ComputerSigner::of(key).unwrap().computer_id()).collect::<Vec<_>>();
    let account=AccountKey::generate().unwrap();let address=account.address();
    let row=ComputersRow::sign_with_voters(&address,1,&ids,&ids,&ids,&account).unwrap();
    let peers=Arc::new(Mutex::new(HashMap::new()));let drop_finalize=Arc::new(AtomicBool::new(false));let dropped=Arc::new(AtomicBool::new(false));let select_receiver=Arc::new(AtomicBool::new(false));
    let now=Arc::new(AtomicI64::new(chrono::Utc::now().timestamp_millis()));let root=secrets_key::generate().unwrap();
    let mut copies_set=Vec::new();
    for at in 0..2 {
        let folder=if at==0 {fixture.root.clone()}else{peer_root.path().to_path_buf()};
        let clock=now.clone();let raw=crate::account::rows::open(&folder).unwrap();
        let copies=Copies::new(CopiesConfig {user:"person".into(),address:address.clone(),owner:OWNER.into(),computer:ids[at].clone(),row:row.clone(),
            records:if at==0 {fixture.records.clone()}else{folder.join("records.sqlite")},limits:Some(crate::storage::record_store::settings::Limits::fixed(1<<20,1<<30)),sign_in:raw,stores:None},
            Arc::new(Network {from:ids[at].clone(),peers:peers.clone(),drop_finalize:if at==0 {drop_finalize.clone()}else{Arc::new(AtomicBool::new(false))},dropped:dropped.clone(),select_receiver:select_receiver.clone(),parts:Mutex::new(HashMap::new())}),
            Arc::new(move||clock.load(Ordering::Acquire))).unwrap().with_state(folder.clone())
            .with_secrets_key(keys[at].clone(),folder,Some(root.duplicate()));
        let copies=Arc::new(copies);peers.lock().unwrap().insert(ids[at].clone(),Arc::downgrade(&copies));copies_set.push(copies);
    }
    let source=&copies_set[0];let peer=&copies_set[1];
    hold_writer(&source);
    source.write(|store|store.mutate_local_with_check(OWNER,crate::local_account::own_records::RESOURCE,crate::records::Mutation {
        id:"synthetic-prime-copies".into(),expected_version:0,request_key:"synthetic-prime-copies".into(),deleted:false,value:json!({"synthetic":true})},||Ok(())).map(|_|())).unwrap();
    copies::register(source);
    let original=scoped_parent(&fixture,"synthetic-recovery-first","committed");original.write(&fixture,&mut owner);
    assert!(source.holding().is_some());
    let domain=owner.selected_command_domain(&original.command.input,OWNER,1).unwrap().unwrap();
    let history=serde_json::to_value(domain.selection().identity()).unwrap();
    let slot=crate::storage::record_store_resources::carry::live_adopt::command_slot(OWNER,&history).unwrap();
    let limits=crate::storage::record_store::settings::shipped().unwrap().live_adoption;
    let notices=crate::records::changes::AccountChanges::of(OWNER).unwrap();let mut cursor=notices.cursor();
    let next=scoped_parent(&fixture,"synthetic-recovery-exact","committed before lost finalize");
    drop_finalize.store(true,Ordering::Release);let mut ids_out=Ids::ordinary();ids_out.next=800;
    assert!(owner.execute_selected_records_write_checked(&next.call(),&mut ids_out,&||fixture.assert_source_pin(),&mut current_key(&fixture)).is_err(),"lost finalization withholds original useful result");
    assert!(dropped.load(Ordering::Acquire),"the control actually crossed real multipart finalization delivery");
    assert_eq!(cursor.wait(&notices,Duration::ZERO,&AtomicBool::new(false)),crate::records::changes::Moved::Still,"unfinalized command discloses no notification");
    let before=domain.readers().unwrap().read::<_,crate::records::Error>(|store| {
        let front=crate::storage::record_store_resources::carry::commit_log::frontiers(store.storage(),&slot,limits).unwrap();
        let value=store.current_record(OWNER,crate::local_account::own_records::RESOURCE,"synthetic-original-result-page")?.unwrap();
        assert!(value.value.to_string().contains("committed before lost finalize"));
        assert!(store.current_record(OWNER,crate::local_account::own_records::COMMANDS,&next.binding.permit_id)?.is_some());
        Ok((front.stored,value.version))
    }).unwrap();
    drop_finalize.store(false,Ordering::Release);
    let mut recovered_ids=Ids::ordinary();recovered_ids.next=900;
    let recovered=owner.execute_selected_records_write_checked(&next.call(),&mut recovered_ids,&||fixture.assert_source_pin(),&mut current_key(&fixture)).unwrap();
    assert!(recovered.duplicate,"recovery uses the original committed command receipt");
    assert_eq!(recovered_ids.next,900,"receipt recovery allocates no new execution identities");
    domain.readers().unwrap().read::<_,crate::records::Error>(|store| {
        let front=crate::storage::record_store_resources::carry::commit_log::frontiers(store.storage(),&slot,limits).unwrap();
        assert_eq!(front.stored,before.0,"same-key recovery never emits another frame");
        assert_eq!(store.current_record(OWNER,crate::local_account::own_records::RESOURCE,"synthetic-original-result-page")?.unwrap().version,before.1,"same-key recovery never mutates useful effects twice");Ok(())
    }).unwrap();
    let crate::records::changes::Moved::Changes(changed)=cursor.wait(&notices,Duration::ZERO,&AtomicBool::new(false)) else {panic!("recovered finalized command publishes its durable scoped notification");};
    assert_eq!(changed.iter().filter(|change|change.scope.as_ref()==Some(&history)&&change.resource==crate::local_account::own_records::RESOURCE&&change.id=="synthetic-original-result-page").count(),1);
    let again=next.write(&fixture,&mut owner);assert!(again.duplicate);
    assert_eq!(cursor.wait(&notices,Duration::ZERO,&AtomicBool::new(false)),crate::records::changes::Moved::Still,"another exact receipt read publishes no duplicate notification");
    // A new actual command commits at the source, then its complete Finalize
    // delivery selects the receiving native actor. Only that receiver owns
    // the one local account consumer bus; the old source must not inject it.
    let receiver_parent=scoped_parent(&fixture,"synthetic-current-native-receiver","registered receiver value");
    select_receiver.store(true,Ordering::Release);
    let mut receiver_ids=Ids::ordinary();receiver_ids.next=1000;
    assert!(!owner.execute_selected_records_write_checked(&receiver_parent.call(),&mut receiver_ids,&||fixture.assert_source_pin(),&mut current_key(&fixture)).unwrap().duplicate);
    assert!(!select_receiver.load(Ordering::Acquire),"the real complete Finalize selected the receiving actor");
    assert!(Arc::ptr_eq(&copies::running_for(OWNER).unwrap(),peer));
    let resource=copies::group_key(&domain.selection().identity(),crate::local_account::own_records::RESOURCE).unwrap();
    assert!(peer.read(&resource,"synthetic-original-result-page").unwrap().record.unwrap().value.to_string().contains("registered receiver value"));
    let crate::records::changes::Moved::Changes(changed)=cursor.wait(&notices,Duration::ZERO,&AtomicBool::new(false)) else {panic!("the registered receiving actor publishes its committed native row");};
    assert_eq!(changed.iter().filter(|change|change.scope.as_ref()==Some(&history)&&change.resource==crate::local_account::own_records::RESOURCE&&change.id=="synthetic-original-result-page").count(),1,"the replaced source cannot duplicate its registered receiver's notification");
    copies::register(source);
    assert!(receiver_parent.write(&fixture,&mut owner).duplicate);
    assert_eq!(cursor.wait(&notices,Duration::ZERO,&AtomicBool::new(false)),crate::records::changes::Moved::Still);
}


#[test]
fn a_busy_canonical_policy_is_source_unavailable_and_the_same_scoped_command_can_recover() {
    let fixture = setup();
    let mut owner = fixture.open();
    let original = scoped_parent(&fixture, "busy-policy-original", "one admitted effect");
    let mut policy = Connection::open(fixture.root.join("policy.sqlite")).unwrap();
    let held = policy.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
    let before = primary_domain_stamps(&fixture);
    let refused = owner.execute_selected_records_write_checked(
        &original.call(), &mut Ids::ordinary(), &|| fixture.assert_source_pin(), &mut current_key(&fixture));
    assert!(matches!(refused, Err(record_writer::Error::Source(_))),
        "an independent physical writer cannot become a refusal of the valid key's rights: {refused:?}");
    assert_eq!(primary_domain_stamps(&fixture), before, "no own-record effect was committed");
    let registrations: i64 = held.query_row(
        "SELECT count(*) FROM policy_directory WHERE name LIKE 'native-resource-incarnation:%'", [], |row| row.get(0)).unwrap();
    assert_eq!(registrations, 0, "a busy enrollment committed no canonical registration");
    held.rollback().unwrap();
    let first = original.write(&fixture, &mut owner);
    assert!(!first.duplicate);
    let recovered = original.write(&fixture, &mut owner);
    assert!(recovered.duplicate, "the original key recovers the one acknowledged effect");
    assert_eq!(first.value, recovered.value);
}


#[test]
fn an_idle_scoped_command_holds_its_writer_turn_before_mutating_canonical_policy() {
    use crate::account::computers::{self,AccountKey,ComputerSigner,ComputersRow,copies::{self,Copies,CopiesConfig,Link},messages::{Message,Answer}};
    use crate::secrets::secrets_key::{self,ComputerKey};
    use std::{collections::HashMap,sync::{Mutex,Weak,atomic::{AtomicI64,AtomicUsize}}};
    struct Network {from:String,peers:Arc<Mutex<HashMap<String,Weak<Copies>>>>}
    impl Link for Network {fn send(&self,to:&str,message:&Message)->Option<Answer> {
        let peer=self.peers.lock().unwrap().get(to).and_then(Weak::upgrade)?;
        Some(peer.answer(&self.from,message.clone()))
    }}
    let fixture=setup();let mut owner=fixture.open();let peer_root=tempfile::tempdir().unwrap();
    let keys=[Arc::new(ComputerKey::from_bytes(vec![150;32]).unwrap()),Arc::new(ComputerKey::from_bytes(vec![151;32]).unwrap())];
    let computers=keys.iter().map(|key|ComputerSigner::of(key).unwrap().computer_id()).collect::<Vec<_>>();
    let account=AccountKey::generate().unwrap();let address=account.address();
    let row=ComputersRow::sign_with_voters(&address,1,&computers,&computers,&computers,&account).unwrap();
    let peers=Arc::new(Mutex::new(HashMap::new()));
    let now=Arc::new(AtomicI64::new(chrono::Utc::now().timestamp_millis()));let root=secrets_key::generate().unwrap();
    let mut nodes=Vec::new();
    for at in 0..2 {
        let folder=if at==0 {fixture.root.clone()}else{peer_root.path().to_path_buf()};let clock=now.clone();
        let raw=crate::account::rows::open(&folder).unwrap();
        let copies=Arc::new(Copies::new(CopiesConfig {user:"person".into(),address:address.clone(),owner:OWNER.into(),computer:computers[at].clone(),row:row.clone(),
            records:if at==0 {fixture.records.clone()}else{folder.join("records.sqlite")},limits:Some(crate::storage::record_store::settings::Limits::fixed(1<<20,1<<30)),sign_in:raw,stores:None},
            Arc::new(Network {from:computers[at].clone(),peers:peers.clone()}),Arc::new(move||clock.load(Ordering::Acquire))).unwrap()
            .with_state(folder.clone()).with_secrets_key(keys[at].clone(),folder,Some(root.duplicate())));
        peers.lock().unwrap().insert(computers[at].clone(),Arc::downgrade(&copies));nodes.push(copies);
    }
    let source=&nodes[0];
    hold_writer(&source);
    source.write(|store|store.mutate_local_with_check(OWNER,crate::local_account::own_records::RESOURCE,crate::records::Mutation {
        id:"canonical-order-prime".into(),expected_version:0,request_key:"canonical-order-prime".into(),deleted:false,value:json!({"synthetic":true})},||Ok(())).map(|_|())).unwrap();
    copies::register(source);
    let old_term=source.holding().unwrap();source.give_up();
    // A long-idle account is beyond the previous term and every unchanged rank-based claim turn.
    now.fetch_add(computers::settings().idle_release_ms+computers::settings().term_ms
        +computers::settings().clock_margin_ms+computers::settings().renew_every_ms+1,Ordering::AcqRel);
    assert!(source.holding().is_none(),"exercise the first actual command after the writer stopped");
    let original=scoped_parent(&fixture,"canonical-after-idle","one acknowledged effect");
    let witnessed=AtomicUsize::new(0);let mut key=current_key(&fixture);
    let mut current=|owner:&mut LocalAccount| {
        key(owner)?;
        let probe=Connection::open(fixture.root.join("policy.sqlite")).unwrap();
        probe.busy_timeout(Duration::ZERO).unwrap();
        match probe.execute_batch("BEGIN IMMEDIATE") {
            Ok(())=>probe.execute_batch("ROLLBACK").unwrap(),
            Err(error) if error.sqlite_error_code()==Some(rusqlite::ErrorCode::DatabaseBusy)=> {
                witnessed.fetch_add(1,Ordering::AcqRel);
                assert!(source.holding().is_some_and(|term|term>old_term),
                    "a canonical write must not enter while account upkeep can restore non-writer policy");
            },
            Err(error)=>panic!("physical write-scope observation failed: {error}"),
        }
        Ok(())
    };
    // Since #309 a command at an idle account asks the timer for the writer turn and is refused until the timer takes it, so
    // the first command meets the writer-less account: it is refused, takes no turn and mutates nothing; then the timer steps.
    let refused=owner.execute_selected_records_write_checked(&original.call(),&mut Ids::ordinary(),&||fixture.assert_source_pin(),&mut current);
    assert!(matches!(refused,Err(record_writer::Error::Refused(_))),"the writer-less command is refused before any effect");
    assert!(source.holding().is_none(),"a refused command takes no writer turn");
    hold_writer(&source);
    let first=owner.execute_selected_records_write_checked(&original.call(),&mut Ids::ordinary(),&||fixture.assert_source_pin(),&mut current).unwrap();
    assert!(witnessed.load(Ordering::Acquire)>0,"the current caller actually crossed Enroll's held canonical write transaction");
    assert!(!first.duplicate);
    assert!(original.write(&fixture,&mut owner).duplicate,"the same original command recovers its one effect");
}
