//! Behavioral source: trillion@b6ae0ebf815f2f5271eed34e6e023c7e1767ec04
//! src/execution-context.mjs:245-291 (recordExecution). Current native journal
//! custody remains in native_command_context; no Worker writer is retained.
//! Verified source observations share the original command journal and record
//! transaction. No ordinary record write, external dispatch or new store is added.
use super::*;
use crate::account::hooks::executions::Verified;
use original_mutations::{Record, Write};
pub(crate) struct Call<'a> {
    pub(crate) binding: &'a CommandBinding,
    pub(crate) sign_in: &'a str,
    pub(crate) command: &'a DomainCommand,
    pub(crate) request: &'a Request,
    pub(crate) context: &'a Context,
    pub(crate) cancel: Arc<AtomicBool>,
    pub(crate) deadline: Instant,
}
fn json(v: &Value) -> Result<serde_json::Value> {
    serde_json::from_str(&encode(v)?).map_err(|error| crate::carry_cause!(Error::Source, error))
}
fn ecma(v: &serde_json::Value) -> Result<Value> {
    parse(&serde_json::to_string(v).map_err(|error| crate::carry_cause!(Error::Invalid, error))?)
}
fn without_time(v: &serde_json::Value) -> serde_json::Value {
    let mut v = v.clone();
    v.as_object_mut().map(|v| v.remove("updated_at"));
    v
}
fn identity(receipt: &serde_json::Value) -> Result<String> {
    execution_metadata::reference(&receipt["call_id"].as_str().ok_or(crate::cause!(Error::Invalid))?.into())
        .map_err(|error| crate::carry_cause!(Error::Invalid, error))?
        .to_rust_string()
        .map_err(|error| crate::carry_cause!(Error::Invalid, error))
}
fn merge(
    prior: Option<&serde_json::Value>,
    proof: &Verified,
    reader: &str,
    now: &str,
    lookup: &mut impl FnMut(&str) -> Result<String>,
) -> Result<serde_json::Value> {
    use serde_json::json;
    let receipt = &proof.receipt;
    let mut record = match prior {
        Some(prior) => {
            if prior["call_id"] != receipt["call_id"]
                || prior["capture_kind"] != "host_transcript"
                || prior["claimed"]["conversation_id"] != receipt["claimed"]["conversation_id"]
                || prior["claimed"]["tool_call_id"] != receipt["claimed"]["tool_call_id"]
                || prior.get("operation").is_some()
                    && receipt.get("operation").is_some()
                    && prior["operation"] != receipt["operation"]
            {
                return Err(crate::cause!(Error::Conflict));
            }
            prior.clone()
        }
        None => {
            json!({"call_id":receipt["call_id"],"execution_ref":identity(receipt)?,"capture_kind":"host_transcript","origin":"unknown","phase":"recorded",
            "actor":{"basis":"unknown"},"recorder":{"reader":reader,"basis":"authenticated","app_basis":"unknown"},"claimed":receipt["claimed"],
            "captured_at":receipt["captured_at"],"created_at":now,"coverage":{"before_dispatch":false,"input_output":"not_captured","native_host":"verified_transcript_occurrence","references":"declared_metadata_only"},"references":[],"links":{"record_refs":[]}})
        }
    };
    if record.get("operation").is_none() {
        if let Some(operation) = receipt.get("operation") {
            record["operation"] = operation.clone();
        }
    }
    let mut refs = record["references"].as_array().cloned().unwrap_or_default();
    for reference in receipt["references"].as_array().ok_or(crate::cause!(Error::Invalid))? {
        if !refs.contains(reference) {
            refs.push(reference.clone());
        }
    }
    if refs.len() > proof.max_references
        || serde_json::to_vec(&refs).map_err(|error| crate::carry_cause!(Error::Invalid, error))?.len() > proof.max_bytes
    {
        return Err(crate::cause!(Error::Bounds));
    }
    let mut links = Vec::new();
    for reference in &refs {
        let key = lookup(reference["ref"].as_str().ok_or(crate::cause!(Error::Invalid))?)?;
        if key.encode_utf16().count() > proof.max_id_chars { return Err(crate::cause!(Error::Bounds)); }
        if !links.contains(&key) {
            links.push(key)
        }
    }
    if serde_json::to_vec(&links).map_err(|error| crate::carry_cause!(Error::Invalid, error))?.len() > proof.max_bytes {
        return Err(crate::cause!(Error::Bounds));
    }
    record["references"] = json!(refs);
    record["links"]["record_refs"] = json!(links);
    if receipt["event_phase"] != "called"
        || !matches!(record["event_phase"].as_str(), Some("returned" | "failed"))
    {
        record["event_phase"] = receipt["event_phase"].clone();
    }
    if let Some(observation) = receipt.get("observation") {
        let mut observation = observation.clone();
        observation["basis"] = json!("claimed");
        observation["origin"] = json!("unknown");
        observation["observed_at"] = receipt["captured_at"].clone();
        record["observation"] = observation;
    }
    record["updated_at"] = json!(now);
    Ok(
        if prior.is_some_and(|prior| without_time(prior) == without_time(&record)) {
            prior.unwrap().clone()
        } else {
            record
        },
    )
}
impl NativeTransaction<'_, '_, '_> {
    fn keep_host_observation(&mut self, proof: &Verified) -> Result<()> {
        self.current()?;
        let record_kind = self.captured_record_kind;
        let model = crate::record_model_policy::installed(self.state.owner.state_root())
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let policy = model.open_policy();
        let read = |values: &mut InCommand<'_>, id: &str| -> Result<Option<Record>> {
            crate::record_value::read(id, values, policy, Default::default())
                .map_err(|error| crate::carry_cause!(Error::Source, error))
                .map(|row| {
                    row.map(|r| Record {
                        kind: Some(r.record_type().into()),
                        identity: r.sequence().into(),
                        value: r.into_value(),
                    })
                })
        };
        let registered = self
            .with_current_values(|v| read(v, &proof.registration))?
            .ok_or(crate::cause!(Error::Refused))?;
        let card = json(&registered.value)?;
        if registered.kind.as_ref() != Some(&proof.registration_kind.as_str().into())
            || card["source_id"] != proof.receipt["claimed"]["conversation_id"]
        {
            return Err(crate::cause!(Error::Refused));
        }
        let id = identity(&proof.receipt)?;
        let prior = self.with_current_values(|v| read(v, &id))?;
        if prior
            .as_ref()
            .is_some_and(|r| r.kind.as_ref() != Some(&record_kind.into()))
        {
            return Err(crate::cause!(Error::Conflict));
        }
        // An erased or removed identity must never be reminted.
        if prior.is_none() && !self.state.external.fresh(self.db, &id)? {
            return Err(crate::cause!(Error::OutcomeUnknown));
        }
        let previous = prior.as_ref().map(|r| json(&r.value)).transpose()?;
        // Only the index keys are canonicalized. The claimed references,
        // including their exact spelling, role and source path, stay intact.
        // This uses the same current-value supply and transaction as the receipt
        // write (old execution-context.mjs:195-204 referenceLookupLinks).
        let mut keys: BTreeMap<String, String> = BTreeMap::new();
        let reader = self.state.external.reader.clone();
        let now = self.context.system_time.clone();
        let next = merge(
            previous.as_ref(),
            proof,
            &reader,
            &now,
            &mut |requested| {
                if let Some(key) = keys.get(requested) { return Ok(key.clone()); }
                let key = self.with_current_values(|values| {
                    crate::record_value::reference::canonical_lookup(requested, values, &model, Default::default())
                        .map_err(|error| crate::carry_cause!(Error::Source, error))
                })?;
                keys.insert(requested.to_owned(), key.clone());
                Ok(key)
            },
        )?;
        self.write_observed(
            &BTreeMap::from([(id.clone(), prior)]),
            &[Write {
                id: id.as_str().into(),
                kind: record_kind.into(),
                value: Some(ecma(&next)?),
            }],
            None,
        )?;
        self.current()
    }
}
impl LocalAccount {
    pub(crate) fn keep_verified_host_observations(
        &mut self,
        call: &Call<'_>,
        proofs: &[Verified],
        ids: &mut dyn LogIds,
        selection: &dyn Fn() -> Result<()>,
        current: &mut dyn FnMut(&mut LocalAccount) -> crate::account::AccountResult<()>,
    ) -> Result<NativeCommandResult> {
        let generation = call.binding.generation.as_i64().ok_or(crate::cause!(Error::Refused))?;
        let schema = ecma(
            &serde_json::json!({"type":"object","properties":{"executions":{"writeOnly":true},"payload":{"writeOnly":true},"messages":{"writeOnly":true}}}),
        )?;
        let mut current = |owner: &mut LocalAccount| {
            current(owner)?;
            if proofs
                .iter()
                .enumerate()
                .any(|(i, p)| !proofs[..i].iter().any(|q| p.same_source(q)) && !p.current())
            {
                return Err(crate::cause!(crate::account::AccountError::SourceChanged));
            }
            Ok(())
        };
        let command = CommandCall {
            admitter: Admitter::Personal {
                sign_in: call.sign_in,
                current: &mut current,
            },
            cancel: call.cancel.clone(),
            command: call.command,
            input_schema: &schema,
            permit_id: &call.binding.permit_id,
            original_identity: &call.binding.identity,
            request: call.request,
            log_context: call.context,
            deadline: call.deadline,
        };
        self.execute_command_effect_checked(
            command,
            ids,
            selection,
            Some(generation),
            false,
            |tx| {
                for proof in proofs {
                    tx.keep_host_observation(proof)?;
                }
                Ok(EffectResult::Counts { removals: Vec::new() })
            },
        )
    }
}
