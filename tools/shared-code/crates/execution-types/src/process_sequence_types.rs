//! Portable DATA contract for ordered process execution in one owner-held root.
//!
//! A sequence is the generic owner operation for jobs whose later process
//! steps consume files produced by earlier steps. Callers declare one immutable
//! seed and ordered portable process steps. They never receive or serialize the
//! host-private workspace root.

use crate::{
    encode_process_descriptor, encode_process_result, ExecutionError, ProductWordIds,
    ProcessDescriptor, ProcessInputMount, ProcessInputTreeMount, ProcessOutputArtifact,
    ProcessResult, ProcessWorkspaceExecutionBindings,
};
use content_crypto::Multihash;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Content identity of `contracts/process-sequence-descriptor.golden.json`
/// after its one repository newline is removed.
pub const PROCESS_SEQUENCE_DESCRIPTOR_GOLDEN_CONTENT_HASH: &str =
    "1f:6de48561e6b6e90d4753a46861f364f3da3b8ca09b4cb619cf20199ef7b56ee3";

fn canonical_contract_file_bytes(bytes: &'static [u8]) -> &'static [u8] {
    bytes.strip_suffix(b"\n").unwrap_or(bytes)
}

/// Literal canonical sequence-request bytes shared by every consumer.
pub fn process_sequence_descriptor_golden_bytes() -> &'static [u8] {
    canonical_contract_file_bytes(include_bytes!(
        "../contracts/process-sequence-descriptor.golden.json"
    ))
}

/// One output from an earlier sequence step required by a later step.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct ProcessSequenceOutputReference {
    pub step: String,
    pub mount_path: String,
}

/// Exact owner-generated evidence for one required predecessor output.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSequenceOutputEvidence {
    pub step: String,
    pub mount_path: String,
    pub integrity_hash: String,
    pub storage: crate::ProcessOutputStorage,
    pub content_hash: Option<String>,
    pub chunk_manifest_hash: Option<String>,
    pub chunk_manifest_address: Option<String>,
    pub chunk_size_bytes: Option<u64>,
    pub content_type: Option<String>,
    pub byte_len: u64,
    pub process_result_content_hash: String,
}

/// One ordered process step. Its seed mounts are supplied by the sequence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSequenceStep {
    pub name: String,
    pub process: ProcessDescriptor,
    #[serde(default)]
    pub workspace_bindings: ProcessWorkspaceExecutionBindings,
    #[serde(default)]
    pub predecessor_outputs: Vec<ProcessSequenceOutputReference>,
}

/// One portable ordered process request executed in a single private root.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSequenceDescriptor {
    #[serde(default)]
    pub inputs: Vec<ProcessInputMount>,
    #[serde(default)]
    pub input_trees: Vec<ProcessInputTreeMount>,
    pub steps: Vec<ProcessSequenceStep>,
}

/// One named, hash-bound result in an ordered process sequence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSequenceStepResult {
    pub name: String,
    #[serde(default)]
    pub predecessor_result_content_hash: Option<String>,
    pub process_result_content_hash: String,
    pub process_result: ProcessResult,
}

/// Complete result for one canonical sequence request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSequenceResult {
    pub request_content_hash: String,
    pub steps: Vec<ProcessSequenceStepResult>,
}

fn invalid(field: impl Into<String>, reason: impl Into<String>) -> ExecutionError {
    ExecutionError::InvalidDescriptor {
        field: field.into(),
        reason: reason.into(),
    }
}

fn canonical_json<T: Serialize>(field: &str, value: &T) -> Result<Vec<u8>, ExecutionError> {
    let value = serde_json::to_value(value)
        .map_err(|error| invalid(field, format!("JSON value encoding failed: {error}")))?;
    Ok(json_canonicalization::canonicalize_bytes(&value))
}

fn content_hash(bytes: &[u8]) -> String {
    Multihash::hash(bytes).to_code_hex()
}

fn validate_content_hash(field: &str, value: &str) -> Result<(), ExecutionError> {
    if Multihash::from_code_hex(value).is_err() || value != value.to_lowercase() {
        return Err(invalid(
            field,
            "must be a lowercase multihash code-hex identity",
        ));
    }
    Ok(())
}

fn validate_step_name(field: &str, name: &str) -> Result<(), ExecutionError> {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return Err(invalid(field, "must be nonempty"));
    };
    if !first.is_ascii_alphanumeric()
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(invalid(
            field,
            "must start with an ASCII alphanumeric and contain only ASCII alphanumerics, '.', '_', or '-'",
        ));
    }
    Ok(())
}

fn composed_process_for_validation(
    word_ids: &ProductWordIds,
    sequence: &ProcessSequenceDescriptor,
    index: usize,
) -> ProcessDescriptor {
    let mut process = sequence.steps[index].process.clone();
    process.inputs.clone_from(&sequence.inputs);
    process.input_trees.clone_from(&sequence.input_trees);
    process.env.insert(
        word_ids.sequence_request_sha256_env().into(),
        format!("1f:{}", "00".repeat(32)),
    );
    if index > 0 {
        process.env.insert(
            word_ids.sequence_predecessor_result_sha256_env().into(),
            format!("1f:{}", "00".repeat(32)),
        );
    }
    process.env.insert(
        word_ids.sequence_required_outputs_json_env().into(),
        "[]".into(),
    );
    process
}

impl ProcessSequenceDescriptor {
    /// Validate the complete portable sequence grammar without host I/O.
    pub fn validate(&self, word_ids: &ProductWordIds) -> Result<(), ExecutionError> {
        if self.steps.is_empty() {
            return Err(invalid("steps", "at least one process step is required"));
        }

        let mut step_indexes = BTreeMap::new();
        for (index, step) in self.steps.iter().enumerate() {
            validate_step_name("steps[].name", &step.name)?;
            if step_indexes.insert(step.name.as_str(), index).is_some() {
                return Err(invalid("steps[].name", "step names must be unique"));
            }
        }

        let reserved = word_ids.sequence_environment_keys();
        let mut declared_outputs = BTreeMap::new();
        for (index, step) in self.steps.iter().enumerate() {
            if !step.process.inputs.is_empty() || !step.process.input_trees.is_empty() {
                return Err(invalid(
                    format!("steps[{index}].process.inputs"),
                    "step-local seed mounts are forbidden; declare the seed once on the sequence",
                ));
            }
            if step.process.expected_termination.is_none() {
                return Err(invalid(
                    format!("steps[{index}].process.expected_termination"),
                    "ordered sequence steps must declare one exact required termination",
                ));
            }
            if let Some(key) = reserved
                .iter()
                .find(|key| step.process.env.contains_key(key.as_str()))
            {
                return Err(invalid(
                    format!("steps[{index}].process.env.{key}"),
                    "sequence evidence environment keys are owner-reserved",
                ));
            }
            if let Some(binding) = step
                .workspace_bindings
                .environment
                .iter()
                .find(|binding| reserved.contains(&binding.key))
            {
                return Err(invalid(
                    format!("steps[{index}].workspace_bindings.environment"),
                    format!(
                        "owner-reserved environment key cannot be bound: {}",
                        binding.key
                    ),
                ));
            }
            step.workspace_bindings.validate()?;
            composed_process_for_validation(word_ids, self, index).validate(word_ids)?;

            for output in &step.process.outputs {
                let normalized = crate::normalize_process_relative_path(
                    "steps[].process.outputs[].mount_path",
                    &output.mount_path,
                )?;
                if normalized != output.mount_path {
                    return Err(invalid(
                        format!("steps[{index}].process.outputs[].mount_path"),
                        "sequence output paths must already be in canonical slash-separated form",
                    ));
                }
                if declared_outputs
                    .insert(normalized.clone(), (index, step.name.as_str()))
                    .is_some()
                {
                    return Err(invalid(
                        "steps[].process.outputs[].mount_path",
                        format!("sequence output paths must be globally unique: {normalized}"),
                    ));
                }
            }
        }

        for (consumer_index, step) in self.steps.iter().enumerate() {
            let mut previous_key: Option<(usize, &str)> = None;
            let mut seen = BTreeSet::new();
            for reference in &step.predecessor_outputs {
                let normalized = crate::normalize_process_relative_path(
                    "steps[].predecessor_outputs[].mount_path",
                    &reference.mount_path,
                )?;
                if normalized != reference.mount_path {
                    return Err(invalid(
                        "steps[].predecessor_outputs[].mount_path",
                        "must already be in canonical slash-separated form",
                    ));
                }
                let Some(&producer_index) = step_indexes.get(reference.step.as_str()) else {
                    return Err(invalid(
                        "steps[].predecessor_outputs[].step",
                        format!("unknown producer step: {}", reference.step),
                    ));
                };
                if producer_index >= consumer_index {
                    return Err(invalid(
                        "steps[].predecessor_outputs[].step",
                        "references must name a strictly earlier step",
                    ));
                }
                let Some(&(declared_index, declared_step)) = declared_outputs.get(&normalized)
                else {
                    return Err(invalid(
                        "steps[].predecessor_outputs[].mount_path",
                        format!("no step declares output {normalized}"),
                    ));
                };
                if declared_index != producer_index || declared_step != reference.step {
                    return Err(invalid(
                        "steps[].predecessor_outputs",
                        format!(
                            "{} is declared by step {}, not {}",
                            reference.mount_path, declared_step, reference.step
                        ),
                    ));
                }
                let key = (producer_index, reference.mount_path.as_str());
                if previous_key.is_some_and(|previous| previous >= key) {
                    return Err(invalid(
                        "steps[].predecessor_outputs",
                        "references must be strictly ordered by producer step and mount path",
                    ));
                }
                if !seen.insert((reference.step.as_str(), reference.mount_path.as_str())) {
                    return Err(invalid(
                        "steps[].predecessor_outputs",
                        "references must be unique",
                    ));
                }
                previous_key = Some(key);
            }
        }
        Ok(())
    }

    /// Construct the exact portable request the owner executes for one step.
    /// Completed results must be the exact prefix before `step_index`.
    pub fn bind_step(
        &self,
        word_ids: &ProductWordIds,
        step_index: usize,
        completed: &[ProcessSequenceStepResult],
    ) -> Result<ProcessDescriptor, ExecutionError> {
        self.validate(word_ids)?;
        let step = self
            .steps
            .get(step_index)
            .ok_or_else(|| invalid("step_index", "is outside the sequence"))?;
        if completed.len() != step_index {
            return Err(invalid(
                "completed_steps",
                "must be the exact ordered prefix before the requested step",
            ));
        }
        for (expected, observed) in self.steps.iter().zip(completed) {
            if expected.name != observed.name {
                return Err(invalid(
                    "completed_steps[].name",
                    "must match the descriptor's exact ordered prefix",
                ));
            }
            observed.validate(word_ids)?;
        }

        let sequence_content_hash =
            content_hash(&encode_process_sequence_descriptor(word_ids, self)?);
        let mut process = step.process.clone();
        process.inputs.clone_from(&self.inputs);
        process.input_trees.clone_from(&self.input_trees);
        process.env.insert(
            word_ids.sequence_request_sha256_env().into(),
            sequence_content_hash,
        );
        if let Some(previous) = completed.last() {
            process.env.insert(
                word_ids.sequence_predecessor_result_sha256_env().into(),
                previous.process_result_content_hash.clone(),
            );
        }

        let evidence = step
            .predecessor_outputs
            .iter()
            .map(|reference| {
                let producer = completed
                    .iter()
                    .find(|result| result.name == reference.step)
                    .ok_or_else(|| {
                        invalid(
                            "steps[].predecessor_outputs[].step",
                            "producer result is absent from the completed prefix",
                        )
                    })?;
                let output = producer
                    .process_result
                    .outputs
                    .iter()
                    .find(|output| output.mount_path == reference.mount_path)
                    .ok_or_else(|| {
                        invalid(
                            "steps[].predecessor_outputs[].mount_path",
                            "producer result does not contain the declared output",
                        )
                    })?;
                Ok(ProcessSequenceOutputEvidence {
                    step: reference.step.clone(),
                    mount_path: reference.mount_path.clone(),
                    integrity_hash: output.integrity_hash.clone(),
                    storage: output.storage,
                    content_hash: output.content_hash.clone(),
                    chunk_manifest_hash: output.chunk_manifest_hash.clone(),
                    chunk_manifest_address: output.chunk_manifest_address.clone(),
                    chunk_size_bytes: output.chunk_size_bytes,
                    content_type: output.content_type.clone(),
                    byte_len: output.byte_len,
                    process_result_content_hash: producer.process_result_content_hash.clone(),
                })
            })
            .collect::<Result<Vec<_>, ExecutionError>>()?;
        let evidence_json = String::from_utf8(encode_process_sequence_output_evidence(&evidence)?)
            .map_err(|error| {
                invalid(
                    "process_sequence_output_evidence",
                    format!("canonical JSON was not UTF-8: {error}"),
                )
            })?;
        process.env.insert(
            word_ids.sequence_required_outputs_json_env().into(),
            evidence_json,
        );
        process.validate(word_ids)?;
        Ok(process)
    }
}

impl ProcessSequenceStepResult {
    pub fn validate(&self, word_ids: &ProductWordIds) -> Result<(), ExecutionError> {
        validate_step_name("steps[].name", &self.name)?;
        if let Some(hash) = &self.predecessor_result_content_hash {
            validate_content_hash("steps[].predecessor_result_content_hash", hash)?;
        }
        validate_content_hash(
            "steps[].process_result_content_hash",
            &self.process_result_content_hash,
        )?;
        self.process_result.validate(word_ids)?;
        let observed = content_hash(&encode_process_result(word_ids, &self.process_result)?);
        if self.process_result_content_hash != observed {
            return Err(invalid(
                "steps[].process_result_content_hash",
                "must equal the SHA-256 of the canonical nested process result",
            ));
        }
        Ok(())
    }
}

impl ProcessSequenceResult {
    /// Validate result-local structure and the ordered result hash chain.
    pub fn validate(&self, word_ids: &ProductWordIds) -> Result<(), ExecutionError> {
        validate_content_hash("request_content_hash", &self.request_content_hash)?;
        if self.steps.is_empty() {
            return Err(invalid("steps", "at least one step result is required"));
        }
        let mut names = BTreeSet::new();
        let mut previous_hash: Option<&str> = None;
        for step in &self.steps {
            step.validate(word_ids)?;
            if !names.insert(step.name.as_str()) {
                return Err(invalid("steps[].name", "result step names must be unique"));
            }
            if step.predecessor_result_content_hash.as_deref() != previous_hash {
                return Err(invalid(
                    "steps[].predecessor_result_content_hash",
                    "must equal the immediately preceding canonical process-result hash",
                ));
            }
            previous_hash = Some(&step.process_result_content_hash);
        }
        Ok(())
    }

    /// Verify this result against the exact request, including every effective
    /// step request hash and declared result surface.
    pub fn validate_against(
        &self,
        word_ids: &ProductWordIds,
        descriptor: &ProcessSequenceDescriptor,
    ) -> Result<(), ExecutionError> {
        descriptor.validate(word_ids)?;
        self.validate(word_ids)?;
        let request_content_hash =
            content_hash(&encode_process_sequence_descriptor(word_ids, descriptor)?);
        if self.request_content_hash != request_content_hash {
            return Err(invalid(
                "request_content_hash",
                "must equal the canonical sequence descriptor hash",
            ));
        }
        if self.steps.len() != descriptor.steps.len() {
            return Err(invalid(
                "steps",
                "result count must equal descriptor step count",
            ));
        }
        for index in 0..self.steps.len() {
            let expected = &descriptor.steps[index];
            let observed = &self.steps[index];
            if observed.name != expected.name {
                return Err(invalid(
                    format!("steps[{index}].name"),
                    "must equal the descriptor step name",
                ));
            }
            let effective = descriptor.bind_step(word_ids, index, &self.steps[..index])?;
            validate_process_result_surface(&effective, &observed.process_result)?;
            let effective_content_hash =
                content_hash(&encode_process_descriptor(word_ids, &effective)?);
            if observed
                .process_result
                .containment_receipt
                .request_content_hash()
                != effective_content_hash
            {
                return Err(invalid(
                    format!(
                        "steps[{index}].process_result.containment_receipt.request_content_hash"
                    ),
                    "must bind the exact owner-injected portable step request",
                ));
            }
        }
        Ok(())
    }
}

fn validate_process_result_surface(
    descriptor: &ProcessDescriptor,
    result: &ProcessResult,
) -> Result<(), ExecutionError> {
    if let Some(expected) = &descriptor.expected_termination {
        if &result.termination != expected {
            return Err(invalid(
                "steps[].process_result.termination",
                "does not equal the step's required termination",
            ));
        }
    }
    if descriptor.capture_fds
        != result
            .captured_fds
            .iter()
            .map(|capture| capture.fd)
            .collect::<Vec<_>>()
    {
        return Err(invalid(
            "steps[].process_result.captured_fds",
            "must equal the descriptor's exact capture list",
        ));
    }
    if descriptor.outputs.len() != result.outputs.len()
        || descriptor
            .outputs
            .iter()
            .zip(&result.outputs)
            .any(|(expected, observed)| {
                expected.mount_path != observed.mount_path
                    || expected.content_type != observed.content_type
                    || expected.storage != observed.storage
            })
    {
        return Err(invalid(
            "steps[].process_result.outputs",
            "must equal the descriptor's ordered declared-output surface",
        ));
    }
    if descriptor
        .collected_files
        .iter()
        .map(|file| file.name.as_str())
        .ne(result.collected_files.iter().map(|file| file.name.as_str()))
    {
        return Err(invalid(
            "steps[].process_result.collected_files",
            "must equal the descriptor's ordered collected-file surface",
        ));
    }
    Ok(())
}

/// Encode one deterministic sequence request using RFC 8785 JCS bytes.
pub fn encode_process_sequence_descriptor(
    word_ids: &ProductWordIds,
    descriptor: &ProcessSequenceDescriptor,
) -> Result<Vec<u8>, ExecutionError> {
    descriptor.validate(word_ids)?;
    canonical_json("process_sequence_descriptor", descriptor)
}

/// Strictly decode and validate one sequence request.
pub fn decode_process_sequence_descriptor(
    word_ids: &ProductWordIds,
    bytes: &[u8],
) -> Result<ProcessSequenceDescriptor, ExecutionError> {
    let descriptor: ProcessSequenceDescriptor = serde_json::from_slice(bytes).map_err(|error| {
        invalid(
            "process_sequence_descriptor",
            format!("strict JSON decode failed: {error}"),
        )
    })?;
    descriptor.validate(word_ids)?;
    Ok(descriptor)
}

/// Encode owner-generated predecessor-output evidence as canonical JSON.
pub fn encode_process_sequence_output_evidence(
    evidence: &[ProcessSequenceOutputEvidence],
) -> Result<Vec<u8>, ExecutionError> {
    let mut seen = BTreeSet::new();
    for item in evidence {
        validate_step_name("process_sequence_output_evidence[].step", &item.step)?;
        let normalized = crate::normalize_process_relative_path(
            "process_sequence_output_evidence[].mount_path",
            &item.mount_path,
        )?;
        if normalized != item.mount_path {
            return Err(invalid(
                "process_sequence_output_evidence[].mount_path",
                "must already be in canonical slash-separated form",
            ));
        }
        if content_crypto::Multihash::from_code_hex(&item.integrity_hash).is_err() {
            return Err(invalid(
                "process_sequence_output_evidence[].integrity_hash",
                "must be a canonical multihash",
            ));
        }
        validate_content_hash(
            "process_sequence_output_evidence[].process_result_content_hash",
            &item.process_result_content_hash,
        )?;
        match item.storage {
            crate::ProcessOutputStorage::ImmutableContent => {
                let hash = item.content_hash.as_deref().ok_or_else(|| {
                    invalid(
                        "process_sequence_output_evidence[].content_hash",
                        "immutable content requires its CAS identity",
                    )
                })?;
                validate_content_hash("process_sequence_output_evidence[].content_hash", hash)?;
                if item.chunk_manifest_hash.is_some()
                    || item.chunk_manifest_address.is_some()
                    || item.chunk_size_bytes.is_some()
                {
                    return Err(invalid(
                        "process_sequence_output_evidence[]",
                        "immutable content cannot carry addressed-chunk fields",
                    ));
                }
            }
            crate::ProcessOutputStorage::AddressedChunks => {
                if item.content_hash.is_some() {
                    return Err(invalid(
                        "process_sequence_output_evidence[].content_hash",
                        "addressed chunks cannot carry one whole-content CAS identity",
                    ));
                }
                let hash = item.chunk_manifest_hash.as_deref().ok_or_else(|| {
                    invalid(
                        "process_sequence_output_evidence[].chunk_manifest_hash",
                        "addressed chunks require a manifest identity",
                    )
                })?;
                validate_content_hash(
                    "process_sequence_output_evidence[].chunk_manifest_hash",
                    hash,
                )?;
                let address = item.chunk_manifest_address.as_deref().ok_or_else(|| {
                    invalid(
                        "process_sequence_output_evidence[].chunk_manifest_address",
                        "addressed chunks require a manifest address",
                    )
                })?;
                if address.len() % 2 != 0
                    || address
                        .bytes()
                        .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
                {
                    return Err(invalid(
                        "process_sequence_output_evidence[].chunk_manifest_address",
                        "must be lowercase encoded multihash bytes",
                    ));
                }
                if item.chunk_size_bytes.is_none_or(|size| size == 0) {
                    return Err(invalid(
                        "process_sequence_output_evidence[].chunk_size_bytes",
                        "must be positive",
                    ));
                }
            }
            _ => {
                return Err(invalid(
                    "process_sequence_output_evidence[].storage",
                    "predecessor evidence supports only immutable content or addressed chunks",
                ))
            }
        }
        let key = (item.step.as_str(), item.mount_path.as_str());
        if !seen.insert(key) {
            return Err(invalid(
                "process_sequence_output_evidence",
                "entries must be unique",
            ));
        }
    }
    canonical_json("process_sequence_output_evidence", &evidence)
}

/// Encode one deterministic sequence result.
pub fn encode_process_sequence_result(
    word_ids: &ProductWordIds,
    result: &ProcessSequenceResult,
) -> Result<Vec<u8>, ExecutionError> {
    result.validate(word_ids)?;
    canonical_json("process_sequence_result", result)
}

/// Strictly decode and validate one result-local sequence surface.
pub fn decode_process_sequence_result(
    word_ids: &ProductWordIds,
    bytes: &[u8],
) -> Result<ProcessSequenceResult, ExecutionError> {
    let result: ProcessSequenceResult = serde_json::from_slice(bytes).map_err(|error| {
        invalid(
            "process_sequence_result",
            format!("strict JSON decode failed: {error}"),
        )
    })?;
    result.validate(word_ids)?;
    Ok(result)
}

/// Strictly decode a sequence result and bind it to its exact request.
pub fn decode_process_sequence_result_for_descriptor(
    word_ids: &ProductWordIds,
    bytes: &[u8],
    descriptor: &ProcessSequenceDescriptor,
) -> Result<ProcessSequenceResult, ExecutionError> {
    let result = decode_process_sequence_result(word_ids, bytes)?;
    result.validate_against(word_ids, descriptor)?;
    Ok(result)
}

/// Return one referenced output artifact after validating the owning result.
pub fn process_sequence_output_artifact<'a>(
    word_ids: &ProductWordIds,
    completed: &'a [ProcessSequenceStepResult],
    reference: &ProcessSequenceOutputReference,
) -> Result<&'a ProcessOutputArtifact, ExecutionError> {
    let producer = completed
        .iter()
        .find(|step| step.name == reference.step)
        .ok_or_else(|| invalid("predecessor_outputs[].step", "producer result is absent"))?;
    producer.validate(word_ids)?;
    producer
        .process_result
        .outputs
        .iter()
        .find(|output| output.mount_path == reference.mount_path)
        .ok_or_else(|| {
            invalid(
                "predecessor_outputs[].mount_path",
                "producer result does not contain the referenced output",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product_word_ids::example_product_word_ids;
    use crate::process_types::tests::{golden_admission, golden_request, golden_result};
    use crate::{
        ProcessContainmentRequest, ProcessOutputMount, ProcessOutputStorage, ProcessTermination,
        DEFAULT_PROCESS_TERMINATION_GRACE_MS,
    };

    fn process(argv: &[&str]) -> ProcessDescriptor {
        ProcessDescriptor {
            argv: argv.iter().map(|value| (*value).into()).collect(),
            cwd: None,
            timeout_ms: 2_500,
            termination_grace_ms: DEFAULT_PROCESS_TERMINATION_GRACE_MS,
            expected_termination: Some(ProcessTermination::Exited { code: 0 }),
            env: BTreeMap::from([("MODE".into(), "golden".into())]),
            inputs: Vec::new(),
            input_trees: Vec::new(),
            outputs: Vec::new(),
            private_volume: None,
            readable_private_volumes: Vec::new(),
            network_access: crate::ProcessNetworkAccess::Denied,
            containment: ProcessContainmentRequest::Leaf,
            capture_fds: vec![1, 2],
            collected_files: Vec::new(),
        }
    }

    fn golden_sequence() -> ProcessSequenceDescriptor {
        ProcessSequenceDescriptor {
            inputs: Vec::new(),
            input_trees: Vec::new(),
            steps: vec![ProcessSequenceStep {
                name: "verify".into(),
                process: process(&["golden-runtime", "--verify"]),
                workspace_bindings: ProcessWorkspaceExecutionBindings::default(),
                predecessor_outputs: Vec::new(),
            }],
        }
    }

    #[cfg(feature = "regenerate-goldens")]
    #[test]
    fn regenerate_sequence_golden() {
        let bytes = encode_process_sequence_descriptor(&example_product_word_ids(), &golden_sequence())
            .expect("encode golden");
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("contracts")
            .join("process-sequence-descriptor.golden.json");
        let mut file_bytes = bytes.clone();
        file_bytes.push(b'\n');
        std::fs::write(path, file_bytes).expect("write golden contract");
        println!(
            "PROCESS_SEQUENCE_DESCRIPTOR_GOLDEN_CONTENT_HASH = {}",
            content_hash(&bytes)
        );
    }

    #[test]
    fn sequence_golden_is_literal_canonical_bytes_with_stable_hash() {
        let bytes = encode_process_sequence_descriptor(&example_product_word_ids(), &golden_sequence())
            .expect("encode golden");
        assert_eq!(bytes, process_sequence_descriptor_golden_bytes());
        assert_eq!(
            content_hash(&bytes),
            PROCESS_SEQUENCE_DESCRIPTOR_GOLDEN_CONTENT_HASH
        );
        assert_eq!(
            decode_process_sequence_descriptor(
                &example_product_word_ids(),
                process_sequence_descriptor_golden_bytes()
            )
            .expect("decode golden"),
            golden_sequence()
        );
    }

    #[test]
    fn sequence_rejects_legacy_unknown_and_owner_reserved_fields() {
        assert!(decode_process_sequence_descriptor(
            &example_product_word_ids(),
            br#"{"inputs":[],"input_trees":[],"steps":[],"cwd":"/tmp"}"#
        )
        .is_err());
        let mut sequence = golden_sequence();
        sequence.steps[0].process.env.insert(
            example_product_word_ids().sequence_request_sha256_env().into(),
            "caller".into(),
        );
        assert!(sequence.validate(&example_product_word_ids()).is_err());
        let mut sequence = golden_sequence();
        sequence.steps[0].process.expected_termination = None;
        assert!(sequence.validate(&example_product_word_ids()).is_err());
        let mut sequence = golden_sequence();
        sequence.steps[0].process.inputs.push(ProcessInputMount {
            mount_path: "duplicate.txt".into(),
            source: crate::ProcessInputSource::Inline { bytes: Vec::new() },
            content_type: None,
            executable: false,
        });
        assert!(sequence.validate(&example_product_word_ids()).is_err());
    }

    #[test]
    fn sequence_references_are_backward_declared_and_strictly_ordered() {
        let mut producer = process(&["golden-runtime"]);
        producer.outputs = vec![
            ProcessOutputMount {
                mount_path: "a.txt".into(),
                content_type: None,
                storage: ProcessOutputStorage::Inline,
                envelope_address: None,
                envelope_path: Vec::new(),
                chunk_size_bytes: None,
            },
            ProcessOutputMount {
                mount_path: "b.txt".into(),
                content_type: None,
                storage: ProcessOutputStorage::Inline,
                envelope_address: None,
                envelope_path: Vec::new(),
                chunk_size_bytes: None,
            },
        ];
        let mut sequence = ProcessSequenceDescriptor {
            inputs: Vec::new(),
            input_trees: Vec::new(),
            steps: vec![
                ProcessSequenceStep {
                    name: "producer".into(),
                    process: producer,
                    workspace_bindings: ProcessWorkspaceExecutionBindings::default(),
                    predecessor_outputs: Vec::new(),
                },
                ProcessSequenceStep {
                    name: "consumer".into(),
                    process: process(&["golden-runtime"]),
                    workspace_bindings: ProcessWorkspaceExecutionBindings::default(),
                    predecessor_outputs: vec![
                        ProcessSequenceOutputReference {
                            step: "producer".into(),
                            mount_path: "a.txt".into(),
                        },
                        ProcessSequenceOutputReference {
                            step: "producer".into(),
                            mount_path: "b.txt".into(),
                        },
                    ],
                },
            ],
        };
        sequence
            .validate(&example_product_word_ids())
            .expect("ordered declared references");
        sequence.steps[1].predecessor_outputs.swap(0, 1);
        assert!(sequence.validate(&example_product_word_ids()).is_err());
        sequence.steps[1].predecessor_outputs = vec![ProcessSequenceOutputReference {
            step: "consumer".into(),
            mount_path: "a.txt".into(),
        }];
        assert!(sequence.validate(&example_product_word_ids()).is_err());
    }

    #[test]
    fn result_hashes_are_recomputed_and_unknown_fields_fail_closed() {
        let request = golden_request();
        let process_result = golden_result(&request, &golden_admission(&request));
        let process_result_content_hash = content_hash(
            &encode_process_result(&example_product_word_ids(), &process_result)
                .expect("encode process result"),
        );
        let result = ProcessSequenceResult {
            request_content_hash: format!("1f:{}", "11".repeat(32)),
            steps: vec![ProcessSequenceStepResult {
                name: "verify".into(),
                predecessor_result_content_hash: None,
                process_result_content_hash,
                process_result,
            }],
        };
        let bytes = encode_process_sequence_result(&example_product_word_ids(), &result)
            .expect("encode sequence result");
        assert_eq!(
            decode_process_sequence_result(&example_product_word_ids(), &bytes).unwrap(),
            result
        );
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("legacy".into(), true.into());
        assert!(decode_process_sequence_result(
            &example_product_word_ids(),
            &serde_json::to_vec(&value).unwrap()
        )
        .is_err());
        let mut tampered = result;
        tampered.steps[0].process_result_content_hash = format!("1f:{}", "22".repeat(32));
        assert!(tampered.validate(&example_product_word_ids()).is_err());
    }
}
