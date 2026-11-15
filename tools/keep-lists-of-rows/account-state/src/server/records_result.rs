//! The native result-read dispatch for one exact original records write.
//! The delivery's request key never enters the original command binding.
use super::*;
use crate::account_rights::run_capability::Admitted;

fn original_operation(call: &Operation) -> Result<Operation, OperationFailure> {
    let door = crate::record_value::account_routes::Door::shipped()
        .map_err(|_| refusal("original_workspace_source_unavailable", false))?;
    if !door.answers_result(&call.resource, &call.operation)
        || call.request_key.is_empty()
        || call.request_key.encode_utf16().count() > 512
    {
        return Err(refusal("original_input_refused", false));
    }
    let original = door
        .result_input(&call.input)
        .map_err(|_| refusal("original_input_refused", false))?;
    Ok(Operation {
        resource: call.resource.clone(),
        operation: original.operation,
        request_key: original.request_key,
        input: original.input,
        person_present: None,
    })
}

impl LocalSelectedMcp {
    pub(super) fn records_result_at(
        &self,
        caller: &Caller,
        call: &Operation,
        run: Option<&Admitted>,
        disclosure: &crate::mcp::RequestDisclosure,
        deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        let mut original = original_operation(call)?;
        // The original write used this effective input, including this run's own
        // cause stamp. A result grant cannot replace the original write's scope.
        if let Some(run) = run {
            original.input = run
                .narrow(&caller.principal, &original)
                .map_err(|_| refusal("current_workspace_rights_refused", false))?;
        }
        let sign_in = self.sign_in.clone();
        let credential = caller.credential.clone();
        let principal = caller.principal.clone();
        let held_original = original.clone();
        let held_run = run.map(Admitted::duplicate);
        let original_current = Arc::new(move || {
            let admitted = sign_in
                .admitted(&credential, &principal, &held_original.resource, &held_original.operation)
                .is_ok();
            admitted
                && held_run.as_ref().is_none_or(|run| {
                    run.narrow(&principal, &held_original)
                        .is_ok_and(|input| input == held_original.input)
                })
        });
        // Retain both admissions through the existing physical read custody:
        // outer result rights, original write rights, parent and run.
        let caller = caller.also(original_current);
        if !caller.stands() {
            return Err(refusal("current_workspace_rights_refused", false));
        }
        let mut admitted = self.admit_private_projection(&caller, disclosure, deadline_override)?;
        let limit = disclosure.started_at() + crate::legacy_records::Bounds::default().elapsed;
        let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
        let cancel = disclosure.cancellation_flag();
        let mut selected = owner_wait::acquire(&self.admission, || {
            cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline
        })
        .map_err(|_| refusal("selected_owner_unavailable", false))?;
        // Reconciliation reads the original journal under its own source proof. It shares only individual ID
        // allocations with writes, so this read never reserves the endpoint's ID sequence through file I/O.
        let mut ids = CanonicalLogIds::shared(&self.ids);
        let operation = original.operation.as_str();
        let original_input = &original.input;
        let within = run.map(|run| move |kind: &str| run.reaches_input(operation, kind, original_input));
        let (answer, proof) = selected
            .door_records_result(
                &caller,
                &original,
                cancel,
                deadline,
                &mut ids,
                within
                    .as_ref()
                    .map(|within| within as &dyn Fn(&str) -> bool),
            )
            .map_err(|error| write_refusal(error, deadline, None))?;
        drop(selected);
        // The same body owner must retain the original result's journal, key and generation witnesses.
        // A private projection alone cannot notice erasure of that protected original before its last chunk.
        admitted.retain_original_result(proof).map_err(personal_refusal)?;
        self.register_private_projection_custody(
            &caller,
            call,
            admitted,
            disclosure,
            deadline_override,
        )?;
        Ok(answer)
    }
}

#[cfg(test)]
mod controls {
    use super::*;
    use serde_json::json;

    #[test]
    fn recovery_keeps_the_original_key_input_and_operation_separate_from_delivery() {
        let call = Operation {
            resource: "@own-records".into(),
            operation: "records:result".into(),
            request_key: "delivery-key".into(),
            person_present: Some(json!({"nonce":"not-an-original-proof"})),
            input: json!({"request_key":"original-key","operation":"records:write", "input":{
                "records":[{"id":"synthetic-note","type":"note","value":{"words":"synthetic original"}}]}}),
        };
        let original = original_operation(&call).unwrap();
        assert_eq!(original.request_key, "original-key");
        assert_eq!(original.operation, "records:write");
        assert_eq!(original.input, call.input["input"]);
        assert!(original.person_present.is_none());
        let mut unknown = call.clone();
        unknown.input["operation"] = json!("unknown:write");
        assert!(original_operation(&unknown).is_err());
        let mut alias = call.clone();
        alias.resource = "@another-account".into();
        assert!(original_operation(&alias).is_err());
    }
}
