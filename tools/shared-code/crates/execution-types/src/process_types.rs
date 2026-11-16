// crates/execution-contract/src/process_types.rs
//
// Purpose: Process execution types — descriptor, result, limits.
//   Pure data types for OS process execution. Zero I/O.
//   Extracted from process-engine/types.rs per leaf extraction pattern (BD-02).
//
// L088: N>1 consumers (process-engine + compilation) both need these types.
//   Shared ancestor = execution-contract (both already import it).
//   Same pattern as sandbox-policy leaf extraction.

use content_crypto::Multihash;
use serde::{Deserialize, Serialize};
use slot_protocol::{FactAddress, PathSegment};
use std::collections::BTreeMap;
use std::path::{Component, Path};
use std::time::Duration;

use crate::{ExecutionError, ProductWordIds};

/// Canonical migration/default grace between process-tree termination signals.
/// Portable request DATA remains explicit; callers use this owner constant
/// instead of inventing per-package values.
pub const DEFAULT_PROCESS_TERMINATION_GRACE_MS: u64 = 1_000;

/// Canonical migration/default deadline for descendant-owned capture pipes to
/// reach EOF after the direct child terminates.
pub const DEFAULT_PROCESS_DESCENDANT_PIPE_EOF_TIMEOUT_MS: u64 = 1_000;

/// Exact process-containment receipt checksum contract. The receipt schema id
/// is product-word: [`ProductWordIds::containment_receipt_schema`].
pub const PROCESS_CONTAINMENT_RECEIPT_CHECKSUM_CANONICALIZATION: &str =
    "rfc8785-jcs-omit-checksum-member";

/// A false flag is the shape every reader already assumes, including the ones
/// compiled before the flag existed, so leaving it out is what lets one receipt
/// be read by more than one generation of reader.
fn bool_is_false(value: &bool) -> bool {
    !*value
}

/// Input file mounted into a process job directory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessInputSource {
    /// Materialize the file from inline bytes already present in the descriptor.
    Inline {
        #[serde(default)]
        #[serde(with = "slot_protocol::json_bytes")]
        bytes: Vec<u8>,
    },
    /// Materialize the file by reading a content-addressed blob from Envelope CAS.
    BlobRef { hash: String },
    /// Materialize one file from an existing addressed-chunk output. The
    /// manifest locates the ordered chunks while byte_len and integrity_hash
    /// bind the exact reassembled file selected by the caller.
    AddressedChunks {
        chunk_manifest_hash: String,
        byte_len: u64,
        integrity_hash: String,
    },
}

/// Input file mounted into a process job directory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessInputMount {
    /// Relative path inside the job directory.
    pub mount_path: String,
    /// Where the mounted file's bytes come from.
    pub source: ProcessInputSource,
    /// Optional content type for downstream consumers.
    #[serde(default)]
    pub content_type: Option<String>,
    /// Whether the mounted file should be executable.
    #[serde(default)]
    pub executable: bool,
}

/// Canonical portable source tree materialized beneath a private process root.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSourceArchive {
    pub format: String,
    pub files: Vec<ProcessSourceArchiveFile>,
}

/// One exact source-tree file. Path segments stay machine-readable and avoid
/// platform-specific path encodings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSourceArchiveFile {
    pub path: Vec<String>,
    #[serde(with = "slot_protocol::json_bytes")]
    pub bytes: Vec<u8>,
    /// Canonical content-crypto multihash `code:hex` of `bytes`.
    pub integrity_hash: String,
    #[serde(default)]
    pub executable: bool,
}

/// Portable source-tree archive source.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessInputTreeSource {
    Inline {
        archive: ProcessSourceArchive,
    },
    BlobRef {
        hash: String,
    },
    /// A large source archive stored through the existing addressed-chunk
    /// output contract. The manifest identity locates the chunks while the
    /// length and integrity hash bind their reassembled bytes to the exact
    /// archive the caller selected.
    AddressedChunks {
        chunk_manifest_hash: String,
        byte_len: u64,
        integrity_hash: String,
    },
}

/// Mount one portable source tree beneath the owner-created private job root.
/// An empty `mount_path` selects the root itself.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessInputTreeMount {
    #[serde(default)]
    pub mount_path: Vec<String>,
    pub source: ProcessInputTreeSource,
}

/// Output file collected from a process job directory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessOutputMount {
    /// Relative path inside the job directory to collect after execution.
    pub mount_path: String,
    /// Optional content type for downstream consumers.
    #[serde(default)]
    pub content_type: Option<String>,
    /// How this output should cross the process-result boundary.
    #[serde(default)]
    pub storage: ProcessOutputStorage,
    /// Exact Envelope address for `envelope_rewrite` outputs.
    #[serde(default)]
    pub envelope_address: Option<FactAddress>,
    /// Optional exact Envelope path for `envelope_rewrite` outputs.
    #[serde(default)]
    pub envelope_path: Vec<PathSegment>,
    /// Requested chunk size when `storage` is `addressed_chunks`.
    #[serde(default)]
    pub chunk_size_bytes: Option<u64>,
}

/// How a process-produced address label becomes an Envelope address.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessOutputAddressMode {
    /// Hash the label into a fixed-size content-derived address.
    #[default]
    LabelHash,
    /// Preserve the UTF-8 label as an identity multihash address.
    IdentityText,
}

/// One exact write requested by a process-produced write-set manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessOutputWriteSetEntry {
    /// Exact Envelope address wire hex. Mutually exclusive with `address_label`.
    #[serde(default)]
    pub address: Option<FactAddress>,
    /// Stable label to hash into an Envelope address. Mutually exclusive with `address`.
    #[serde(default)]
    pub address_label: Option<String>,
    /// Address derivation for `address_label`; omitted means `label_hash`.
    ///
    /// This is invalid with an exact `address`.
    #[serde(default)]
    pub address_mode: Option<ProcessOutputAddressMode>,
    /// Exact Envelope path segments.
    #[serde(default)]
    pub path: Vec<PathSegment>,
    /// Stable path labels to hash into Envelope path segments.
    #[serde(default)]
    pub path_labels: Vec<String>,
    /// Relative file path inside the job directory containing bytes to write.
    #[serde(default)]
    pub content_path: Option<String>,
    /// True means remove the target value instead of writing bytes.
    #[serde(default)]
    pub remove: bool,
}

/// Manifest for process-produced exact writes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessOutputWriteSet {
    pub version: u32,
    #[serde(default)]
    pub writes: Vec<ProcessOutputWriteSetEntry>,
}

/// Output transport mode for a declared process output.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessOutputStorage {
    /// Return bytes inside `ProcessResult`; charged to `ProcessLimits::max_output_bytes`.
    #[default]
    Inline,
    /// Publish the exact output file in immutable CAS and return only its hash.
    ImmutableContent,
    /// Write bounded chunks to Envelope CAS and return only a manifest reference.
    AddressedChunks,
    /// Rewrite one exact Envelope address with the output bytes and return only metadata.
    EnvelopeRewrite,
    /// Read a generic manifest of exact Envelope writes and commit one atomic batch.
    EnvelopeWriteSet,
}

/// One chunk entry inside an addressed process-output manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessOutputChunk {
    pub index: u64,
    pub address: String,
    pub content_hash: String,
    pub byte_len: u64,
}

/// Manifest for a declared output written as addressed chunks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessOutputChunkManifest {
    pub version: u32,
    pub mount_path: String,
    #[serde(default)]
    pub content_type: Option<String>,
    pub byte_len: u64,
    pub integrity_hash: String,
    pub chunk_size_bytes: u64,
    pub chunks: Vec<ProcessOutputChunk>,
}

/// Materialized process output returned to callers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessOutputArtifact {
    /// Relative path inside the job directory that produced this output.
    pub mount_path: String,
    /// Optional content type for downstream consumers.
    #[serde(default)]
    pub content_type: Option<String>,
    /// How the output body is represented in this result.
    #[serde(default)]
    pub storage: ProcessOutputStorage,
    /// Total output file length in bytes.
    #[serde(default)]
    pub byte_len: u64,
    /// Self-describing integrity hash of the output bytes in canonical
    /// content-crypto multihash `code:hex` form.
    pub integrity_hash: String,
    /// Immutable CAS identity when `storage` is `immutable_content`.
    #[serde(default)]
    pub content_hash: Option<String>,
    /// Manifest content hash when `storage` is `addressed_chunks`.
    #[serde(default)]
    pub chunk_manifest_hash: Option<String>,
    /// Manifest Envelope address when `storage` is `addressed_chunks`.
    #[serde(default)]
    pub chunk_manifest_address: Option<String>,
    /// Exact Envelope address written when `storage` is `envelope_rewrite`.
    #[serde(default)]
    pub envelope_address: Option<FactAddress>,
    /// Exact Envelope path written when `storage` is `envelope_rewrite`.
    #[serde(default)]
    pub envelope_path: Vec<PathSegment>,
    /// Chunk size used when `storage` is `addressed_chunks`.
    #[serde(default)]
    pub chunk_size_bytes: Option<u64>,
    /// Raw output bytes.
    #[serde(default)]
    #[serde(with = "slot_protocol::json_bytes")]
    pub bytes: Vec<u8>,
}

/// Portable reference to one owner-bound persistent process workspace.
///
/// The reference is an opaque DATA key. It never contains a host path, user
/// name, application directory, or account identifier. The process owner maps
/// it to one app/account-scoped private root only after admission.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessPrivateVolumeRef {
    pub name: String,
}

/// Portable network capability requested by process DATA. Denial is the
/// default; permission is still bounded by the selected runtime's host-private
/// admission binding.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessNetworkAccess {
    #[default]
    Denied,
    /// AF_UNIX sockets only; IP and packet socket creation is denied by the
    /// native authority before the target starts.
    UnixSocketOnly,
    Allowed,
}

impl ProcessNetworkAccess {
    fn is_denied(&self) -> bool {
        matches!(self, Self::Denied)
    }
}

/// Host-granted access to the person's computer. Package/process requests cannot
/// widen this value; it comes only from the installed app's runtime binding.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessComputerAccess {
    #[default]
    Contained,
    Full,
}

impl ProcessComputerAccess {
    pub const fn is_full(self) -> bool {
        matches!(self, Self::Full)
    }

    pub const fn is_contained(&self) -> bool {
        matches!(self, Self::Contained)
    }
}

/// Portable process request accepted at the Envelope/package boundary.
///
/// This type contains caller intent only. It never carries an absolute host
/// executable, an executable digest, or an absolute containment root. The
/// process owner materializes inputs in a private job root and resolves
/// `argv[0]` through registered runtime-alias DATA before producing an
/// [`AdmittedProcessDescriptor`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessDescriptor {
    /// Full argv vector. `argv[0]` selects exactly one registered runtime alias
    /// or one normalized executable input mount. Absolute paths and parent
    /// traversal are forbidden.
    pub argv: Vec<String>,
    /// Optional relative directory beneath the owner-created private job root.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Execution timeout in milliseconds.
    pub timeout_ms: u64,
    /// Grace between process-group SIGTERM and SIGKILL.
    pub termination_grace_ms: u64,
    /// Optional exact terminal state required by the caller. `None` admits any
    /// exact exit or signal and returns it in [`ProcessResult`].
    pub expected_termination: Option<ProcessTermination>,
    /// Exact environment. The owner clears the inherited environment before
    /// `execve`; these are the only entries the child receives.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Input files to materialize before execution.
    #[serde(default)]
    pub inputs: Vec<ProcessInputMount>,
    /// Portable source-tree archives to materialize before file inputs.
    #[serde(default)]
    pub input_trees: Vec<ProcessInputTreeMount>,
    /// Output files to collect after execution.
    #[serde(default)]
    pub outputs: Vec<ProcessOutputMount>,
    /// Optional persistent workspace selected by an opaque owner-registered
    /// volume reference. Absence selects an ephemeral owner-created root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_volume: Option<ProcessPrivateVolumeRef>,
    /// Opaque volume references this process may READ and never write.
    ///
    /// A private volume is leased exclusively because two writers would
    /// overwrite each other. Reading has no such conflict, and binding the two
    /// permissions to one declaration made every durable byte a resident writer
    /// produced unreachable by every other process: the writer never terminates,
    /// so post-termination collection never fires, and no second process can take
    /// the lease. These names are resolved into readable roots only; no lease is
    /// taken, and a volume that does not already exist is refused rather than
    /// created, because a reader that creates its own empty copy reports a clean
    /// listing forever and looks healthy while seeing nothing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub readable_private_volumes: Vec<String>,
    /// Explicit portable network intent. The owner rejects `allowed` unless
    /// the selected runtime binding independently grants it.
    #[serde(default, skip_serializing_if = "ProcessNetworkAccess::is_denied")]
    pub network_access: ProcessNetworkAccess,
    /// Portable containment intent. Absolute enforcement roots are owner-derived.
    pub containment: ProcessContainmentRequest,
    /// Independently captured file descriptors (for example 1, 2, and 3).
    pub capture_fds: Vec<u16>,
    /// Files read through held no-follow descriptors after parent termination
    /// and capture-pipe EOF.
    #[serde(default)]
    pub collected_files: Vec<ProcessCollectedFileSpec>,
}

/// Portable immutable-publication intent. The destination is a registered
/// owner-side reference, never a host filesystem path in package DATA.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessImmutablePublicationRequest {
    pub name: String,
    pub source_relative_path: String,
    pub destination_ref: String,
    #[serde(default)]
    pub expected_content_hash: Option<String>,
}

/// Portable containment intent. There is intentionally no uncontained mode.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessContainmentRequest {
    /// Deny child creation and confine writable effects to the private job root.
    Leaf,
    /// Permit descendants only when the platform can prove complete effect
    /// containment for the whole descendant tree.
    DescendantEffectContained {
        pipe_eof_timeout_ms: u64,
        #[serde(default)]
        publications: Vec<ProcessImmutablePublicationRequest>,
    },
}

/// Cryptographic admission binding for a native executable.
///
/// Contained execution never resolves an executable through `PATH`. The
/// process owner opens this absolute path without following a final symlink,
/// hashes the held file, and proves that the image stopped before its first
/// instruction is the same vnode.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessExecutableBinding {
    pub absolute_path: String,
    pub content_hash: String,
    #[serde(default)]
    pub expected_unix_mode: Option<u32>,
}

/// Host-private admission. The tag is mandatory: native kernel admission and
/// an external provider admission have different authorities and are never
/// interchangeable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AdmittedProcessDescriptor {
    Native(AdmittedNativeProcessDescriptor),
    ExternalProvider(AdmittedExternalProcessDescriptor),
}

/// Host-private native admission produced only by `process-engine`.
///
/// Every machine-specific fact is confined to this lifecycle state: the held
/// executable binding, absolute private-root working directory, and resolved
/// absolute containment/publication roots. Package DATA never serializes this
/// type.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AdmittedNativeProcessDescriptor {
    /// Content identity of the canonical portable [`ProcessDescriptor`] bytes.
    pub request_content_hash: String,
    pub executable: ProcessExecutableBinding,
    /// Full argv vector with `argv[0] == executable.absolute_path`.
    pub argv: Vec<String>,
    /// Absolute working directory beneath the private containment root.
    pub cwd: String,
    pub timeout_ms: u64,
    pub termination_grace_ms: u64,
    pub expected_termination: Option<ProcessTermination>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub inputs: Vec<ProcessInputMount>,
    #[serde(default)]
    pub input_trees: Vec<ProcessInputTreeMount>,
    #[serde(default)]
    pub outputs: Vec<ProcessOutputMount>,
    #[serde(default, skip_serializing_if = "ProcessNetworkAccess::is_denied")]
    pub network_access: ProcessNetworkAccess,
    #[serde(default, skip_serializing_if = "ProcessComputerAccess::is_contained")]
    pub computer_access: ProcessComputerAccess,
    /// Effects the machine boundary confines on its own, each named after the
    /// policy field it covers, declared by whoever owns the machine. Empty means
    /// nothing was vouched for, so an axis the host offers no mechanism for
    /// stops the process rather than passing unenforced.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub host_enforced_isolation: Vec<String>,
    /// Host-owned Linux worker boundary. The process owner mounts only admitted
    /// paths into a new user/mount/PID product word before target execution.
    #[serde(default, skip_serializing_if = "bool_is_false")]
    pub linux_mount_namespace: bool,
    pub containment: ProcessContainmentPolicy,
    pub capture_fds: Vec<u16>,
    #[serde(default)]
    pub collected_files: Vec<ProcessCollectedFileSpec>,
}

/// Provider capability set. Each bit is independently attested because a
/// provider that can run work is not thereby authorized to claim durable
/// sessions, descendant cleanup, private-volume exclusivity, or output
/// correlation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct ProcessExecutionCapabilitySet {
    #[serde(default)]
    pub persistent_session: bool,
    #[serde(default)]
    pub descendant_lifecycle: bool,
    #[serde(default)]
    pub exclusive_private_volume_lease: bool,
    #[serde(default)]
    pub correlated_output: bool,
    #[serde(default)]
    pub cleanup: bool,
    #[serde(default)]
    pub zero_unowned_descendants: bool,
}

impl ProcessExecutionCapabilitySet {
    fn contains(&self, required: &Self) -> bool {
        (!required.persistent_session || self.persistent_session)
            && (!required.descendant_lifecycle || self.descendant_lifecycle)
            && (!required.exclusive_private_volume_lease || self.exclusive_private_volume_lease)
            && (!required.correlated_output || self.correlated_output)
            && (!required.cleanup || self.cleanup)
            && (!required.zero_unowned_descendants || self.zero_unowned_descendants)
    }
}

/// Immutable capability statement issued by the selected protocol decoder
/// after it verifies live provider evidence. Package/app-open DATA may request
/// capabilities, but it cannot author this evidence or its statement hash.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessExternalProviderAttestation {
    pub attestation_id: String,
    pub issuer: String,
    pub provider_evidence_content_hash: String,
    pub statement_content_hash: String,
    pub capabilities: ProcessExecutionCapabilitySet,
}

/// The exact provider connection selected by host-private admission.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessExternalProviderAdmission {
    pub provider_id: String,
    pub provider_protocol_revision: String,
    pub provider_connection_revision: String,
    pub attestation: ProcessExternalProviderAttestation,
}

/// Host-private provider execution identity. These values bind a caller's
/// portable request to one provider operation and correlation domain without
/// exposing native executable, path, PID, or filesystem facts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessExternalProviderExecutionIdentity {
    pub provider_execution_id: String,
    pub correlation_id: String,
    pub requested_capabilities: ProcessExecutionCapabilitySet,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persistent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_volume_lease_id: Option<String>,
}

/// Host-private external-provider admission. It intentionally has no native
/// executable, pathname, PID, sandbox, or vnode member.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AdmittedExternalProcessDescriptor {
    pub request_content_hash: String,
    pub provider: ProcessExternalProviderAdmission,
    pub execution: ProcessExternalProviderExecutionIdentity,
    pub timeout_ms: u64,
    pub termination_grace_ms: u64,
    pub expected_termination: Option<ProcessTermination>,
    #[serde(default)]
    pub outputs: Vec<ProcessOutputMount>,
    pub capture_fds: Vec<u16>,
}

/// One regular file to read through a held no-follow descriptor after all
/// process-owned capture pipes have reached EOF.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessCollectedFileSpec {
    pub name: String,
    pub relative_path: String,
    pub max_bytes: u64,
}

/// One stable staging file to publish create-only outside descendant write
/// authority after a contained process tree has stopped producing effects.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessImmutablePublicationSpec {
    pub name: String,
    pub source_relative_path: String,
    pub destination_path: String,
    #[serde(default)]
    pub expected_content_hash: Option<String>,
}

/// Kernel-enforced process containment mode.
///
/// `Leaf` denies child creation. `DescendantEffectContained` permits an
/// unenumerated descendant tree while structurally confining every writable
/// effect to one staging root. Both modes deny network access and install the
/// policy before `execve`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessContainmentPolicy {
    Leaf {
        writable_root: String,
        #[serde(default)]
        readable_roots: Vec<String>,
    },
    DescendantEffectContained {
        staging_root: String,
        pipe_eof_timeout_ms: u64,
        #[serde(default)]
        readable_roots: Vec<String>,
        publications: Vec<ProcessImmutablePublicationSpec>,
    },
}

/// Exact native process termination. Signals never collapse into sentinel
/// exit codes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessTermination {
    Exited { code: u8 },
    Signaled { signal: u8 },
}

impl ProcessTermination {
    /// Return the exact native exit code without collapsing signal termination
    /// into a sentinel integer.
    pub const fn exited_code(&self) -> Option<u8> {
        match self {
            Self::Exited { code } => Some(*code),
            Self::Signaled { .. } => None,
        }
    }

    /// Return the exact native signal without collapsing ordinary exit into a
    /// synthetic signal value.
    pub const fn signal(&self) -> Option<u8> {
        match self {
            Self::Exited { .. } => None,
            Self::Signaled { signal } => Some(*signal),
        }
    }
}

/// Darwin file generation evidence. `Observed` is always nonzero. APFS may
/// report raw `st_gen == 0`; that is represented explicitly rather than
/// collapsing into null or pretending zero is an observed generation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessFileGeneration {
    Observed { value: String },
    Unavailable { platform: String, reason: String },
}

/// Native code-identity evidence for a held regular file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessCodeIdentity {
    /// The held bytes were admitted as static code. The identity of those bytes
    /// is [`ProcessFileIdentity::content_hash`]; repeating it here would be a
    /// second copy of one fact, free to diverge from the first.
    Validated {
        authority: String,
    },
    NotApplicable {
        reason: String,
    },
}

/// Stable identity of a regular executable or published file. Potentially
/// wide native integers use decimal strings so JSON consumers retain exact
/// values.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessFileIdentity {
    pub absolute_path: String,
    pub canonical_parent_path: String,
    pub device_id: String,
    pub inode: String,
    pub generation: ProcessFileGeneration,
    pub link_count: String,
    pub byte_length: String,
    pub unix_mode: u32,
    pub birthtime_ns: String,
    pub ctime_ns: String,
    pub opened_no_follow: bool,
    pub stable_readback: bool,
    /// Multihash code-hex content identity, minted by `content-crypto`.
    ///
    /// The value declares its own algorithm (`1f:` is Blake3-256), so this
    /// field is never named after one. A rotation changes the values and no
    /// field name, consumer, or doc comment goes stale.
    pub content_hash: String,
    pub code_identity: ProcessCodeIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessImageObservation {
    pub exec_ordinal: u32,
    pub identity: ProcessFileIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessCapturedFd {
    pub fd: u16,
    #[serde(with = "slot_protocol::json_bytes")]
    pub bytes: Vec<u8>,
    pub content_hash: String,
    pub eof_observed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessCapturedFdIdentity {
    pub fd: u16,
    pub byte_length: String,
    pub content_hash: String,
    pub eof_observed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessCollectedFile {
    pub name: String,
    #[serde(with = "slot_protocol::json_bytes")]
    pub bytes: Vec<u8>,
    pub identity: ProcessFileIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessImmutablePublicationReceipt {
    pub name: String,
    pub source_identity: ProcessFileIdentity,
    pub destination_path: String,
    pub destination_identity: ProcessFileIdentity,
}

/// Exact evidence emitted after native kernel admission, termination, EOF, and
/// publication. This type is unreachable from an external-provider receipt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NativeProcessContainmentReceipt {
    pub schema: String,
    /// Content identity of canonical portable [`ProcessDescriptor`] bytes.
    pub request_content_hash: String,
    /// Content identity of canonical host-private [`AdmittedProcessDescriptor`] bytes.
    pub admitted_descriptor_content_hash: String,
    pub platform: String,
    pub enforcement_mechanism: String,
    pub sandbox_policy_content_hash: String,
    pub sandbox_applied_before_exec: bool,
    /// True when the host granted ordinary access to the whole computer. In
    /// this mode an empty writable-roots list means "not path-restricted", not
    /// "no writes".
    ///
    /// ⛔ NEVER SERIALIZED WHEN FALSE, AND THE REASON IS A LIVE OUTAGE. This
    /// field arrived after the readers that consume this receipt were compiled,
    /// and a reader refuses a field it has never heard of. So the moment one
    /// machine ran a newer producer against an older reader, every process on it
    /// died on `unknown field \`full_computer_access\`` while the process itself
    /// had run perfectly. The work was done and the answer was thrown away in
    /// transit.
    ///
    /// Omitting it when false costs nothing, because false is what every reader
    /// that predates it already assumes, and it means the ordinary contained
    /// case survives any pairing of versions. A reader that does know the field
    /// still gets it whenever it is true, which is the only case where it
    /// changes how the receipt reads.
    #[serde(default, skip_serializing_if = "bool_is_false")]
    pub full_computer_access: bool,
    /// IP/packet network access is denied. A contained Linux process may still
    /// have the separately admitted Unix-socket-only transport.
    pub network_denied: bool,
    pub child_process_creation_denied: bool,
    pub inherited_by_descendants: bool,
    pub writable_roots: Vec<String>,
    pub direct_child_pid: u32,
    pub direct_child_start_seconds: String,
    pub direct_child_start_microseconds: String,
    pub boot_session_uuid: String,
    pub boot_session_identity_content_hash: String,
    pub admitted_executable: ProcessFileIdentity,
    pub image_observations: Vec<ProcessImageObservation>,
    pub termination: ProcessTermination,
    pub parent_reaped: bool,
    pub captured_pipes_eof: bool,
    pub captured_fds: Vec<ProcessCapturedFdIdentity>,
    pub collected_file_identities: BTreeMap<String, ProcessFileIdentity>,
    pub declared_output_integrity: BTreeMap<String, String>,
    pub immutable_publications: Vec<ProcessImmutablePublicationReceipt>,
    pub checksum_canonicalization: String,
    pub checksum: String,
}

/// Provider-written lifecycle proof. It is checksum-bound by the enclosing
/// receipt and cannot borrow a native PID, vnode, sandbox, or file identity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessExternalProviderLifecycleEvidence {
    pub provider_execution_id: String,
    pub correlation_id: String,
    pub provider_receipt_content_hash: String,
    pub cleanup_attestation_content_hash: String,
    pub zero_unowned_descendants_attestation_content_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persistent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_volume_lease_id: Option<String>,
}

/// Checksummed external-provider evidence. It deliberately has no native
/// execution members, so a provider cannot synthesize kernel proof.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExternalProviderProcessContainmentReceipt {
    pub schema: String,
    pub request_content_hash: String,
    pub admitted_descriptor_content_hash: String,
    pub provider: ProcessExternalProviderAdmission,
    pub lifecycle: ProcessExternalProviderLifecycleEvidence,
    pub termination: ProcessTermination,
    pub captured_pipes_eof: bool,
    pub captured_fds: Vec<ProcessCapturedFdIdentity>,
    pub declared_output_integrity: BTreeMap<String, String>,
    pub checksum_canonicalization: String,
    pub checksum: String,
}

/// Checksummed execution evidence. Native and external providers are a closed
/// tagged union; consumers must select the authority they can actually prove.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessContainmentReceipt {
    Native(Box<NativeProcessContainmentReceipt>),
    ExternalProvider(Box<ExternalProviderProcessContainmentReceipt>),
}

impl ProcessContainmentReceipt {
    pub fn request_content_hash(&self) -> &str {
        match self {
            Self::Native(receipt) => &receipt.request_content_hash,
            Self::ExternalProvider(receipt) => &receipt.request_content_hash,
        }
    }

    pub fn admitted_descriptor_content_hash(&self) -> &str {
        match self {
            Self::Native(receipt) => &receipt.admitted_descriptor_content_hash,
            Self::ExternalProvider(receipt) => &receipt.admitted_descriptor_content_hash,
        }
    }

    pub fn termination(&self) -> &ProcessTermination {
        match self {
            Self::Native(receipt) => &receipt.termination,
            Self::ExternalProvider(receipt) => &receipt.termination,
        }
    }

    fn checksum(&self) -> &str {
        match self {
            Self::Native(receipt) => &receipt.checksum,
            Self::ExternalProvider(receipt) => &receipt.checksum,
        }
    }

    fn schema(&self) -> &str {
        match self {
            Self::Native(receipt) => &receipt.schema,
            Self::ExternalProvider(receipt) => &receipt.schema,
        }
    }

    fn checksum_canonicalization(&self) -> &str {
        match self {
            Self::Native(receipt) => &receipt.checksum_canonicalization,
            Self::ExternalProvider(receipt) => &receipt.checksum_canonicalization,
        }
    }

    fn set_checksum(&mut self, checksum: String) {
        match self {
            Self::Native(receipt) => receipt.checksum = checksum,
            Self::ExternalProvider(receipt) => receipt.checksum = checksum,
        }
    }
}

impl ProcessExternalProviderLifecycleEvidence {
    fn validate(&self, field: &str) -> Result<(), ExecutionError> {
        validate_opaque_identity(
            &format!("{field}.provider_execution_id"),
            &self.provider_execution_id,
        )?;
        validate_opaque_identity(&format!("{field}.correlation_id"), &self.correlation_id)?;
        validate_content_hash(
            &format!("{field}.provider_receipt_content_hash"),
            &self.provider_receipt_content_hash,
        )?;
        validate_content_hash(
            &format!("{field}.cleanup_attestation_content_hash"),
            &self.cleanup_attestation_content_hash,
        )?;
        validate_content_hash(
            &format!("{field}.zero_unowned_descendants_attestation_content_hash"),
            &self.zero_unowned_descendants_attestation_content_hash,
        )?;
        for (member, value) in [
            ("persistent_session_id", &self.persistent_session_id),
            ("private_volume_lease_id", &self.private_volume_lease_id),
        ] {
            if let Some(value) = value {
                validate_opaque_identity(&format!("{field}.{member}"), value)?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessResult {
    pub termination: ProcessTermination,
    pub captured_fds: Vec<ProcessCapturedFd>,
    /// Materialized declared outputs requested by the existing generic output
    /// transport modes.
    #[serde(default)]
    pub outputs: Vec<ProcessOutputArtifact>,
    pub collected_files: Vec<ProcessCollectedFile>,
    pub immutable_publications: Vec<ProcessImmutablePublicationReceipt>,
    pub duration_ms: u64,
    pub containment_receipt: ProcessContainmentReceipt,
}

impl ProcessResult {
    /// Return the capture for one exact file descriptor.
    ///
    /// `ProcessDescriptor::validate` requires requested descriptors to be
    /// unique, and the process owner emits one result entry per admitted
    /// descriptor, so this lookup is unambiguous.
    pub fn captured_fd(&self, fd: u16) -> Option<&ProcessCapturedFd> {
        self.captured_fds.iter().find(|capture| capture.fd == fd)
    }

    /// Validate canonical result ordering and its two-hash containment bridge.
    pub fn validate(&self, word_ids: &ProductWordIds) -> Result<(), ExecutionError> {
        verify_process_containment_receipt(word_ids, &self.containment_receipt)?;
        validate_capture_fds(
            &self
                .captured_fds
                .iter()
                .map(|capture| capture.fd)
                .collect::<Vec<_>>(),
        )?;
        if self.termination != *self.containment_receipt.termination() {
            return Err(ExecutionError::InvalidDescriptor {
                field: "containment_receipt.termination".into(),
                reason: "must equal result termination".into(),
            });
        }
        validate_content_hash(
            "containment_receipt.request_content_hash",
            self.containment_receipt.request_content_hash(),
        )?;
        validate_content_hash(
            "containment_receipt.admitted_descriptor_content_hash",
            self.containment_receipt.admitted_descriptor_content_hash(),
        )?;
        let receipt_fds = receipt_captured_fds(&self.containment_receipt)
            .iter()
            .map(|capture| capture.fd)
            .collect::<Vec<_>>();
        validate_capture_fds(&receipt_fds)?;
        if receipt_fds
            != self
                .captured_fds
                .iter()
                .map(|capture| capture.fd)
                .collect::<Vec<_>>()
        {
            return Err(ExecutionError::InvalidDescriptor {
                field: "containment_receipt.captured_fds".into(),
                reason: "must identify the same ordered captures as ProcessResult".into(),
            });
        }
        for (capture, identity) in self
            .captured_fds
            .iter()
            .zip(receipt_captured_fds(&self.containment_receipt))
        {
            validate_content_hash("captured_fds[].content_hash", &capture.content_hash)?;
            if capture.content_hash != identity.content_hash
                || capture.content_hash != content_hash_hex(&capture.bytes)
                || capture.bytes.len().to_string() != identity.byte_length
                || capture.eof_observed != identity.eof_observed
                || !capture.eof_observed
            {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "captured_fds".into(),
                    reason: "capture bytes, identity, and EOF evidence must agree".into(),
                });
            }
        }
        let mut declared_output_integrity = BTreeMap::new();
        for output in &self.outputs {
            if declared_output_integrity
                .insert(output.mount_path.clone(), output.integrity_hash.clone())
                .is_some()
            {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "outputs[].mount_path".into(),
                    reason: "result output mount paths must be unique".into(),
                });
            }
            if content_crypto::Multihash::from_code_hex(&output.integrity_hash).is_err() {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "outputs[].integrity_hash".into(),
                    reason: "must be a canonical multihash".into(),
                });
            }
            if matches!(output.storage, ProcessOutputStorage::Inline)
                && output.byte_len != output.bytes.len() as u64
            {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "outputs[].byte_len".into(),
                    reason: "must equal inline output byte length".into(),
                });
            }
            if matches!(output.storage, ProcessOutputStorage::Inline)
                && content_crypto::Multihash::hash(&output.bytes).to_code_hex()
                    != output.integrity_hash
            {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "outputs[].integrity_hash".into(),
                    reason: "must equal the canonical multihash of inline bytes".into(),
                });
            }
        }
        if declared_output_integrity
            != *receipt_declared_output_integrity(&self.containment_receipt)
        {
            return Err(ExecutionError::InvalidDescriptor {
                field: "containment_receipt.declared_output_integrity".into(),
                reason: "must exactly bind every returned output mount and integrity hash".into(),
            });
        }

        let mut collected_file_identities = BTreeMap::new();
        for file in &self.collected_files {
            if file.identity.content_hash != content_hash_hex(&file.bytes) {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "collected_files[].identity.content_hash".into(),
                    reason: "must equal collected file bytes".into(),
                });
            }
            if collected_file_identities
                .insert(file.name.clone(), file.identity.clone())
                .is_some()
            {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "collected_files[].name".into(),
                    reason: "result collected-file names must be unique".into(),
                });
            }
        }
        match &self.containment_receipt {
            ProcessContainmentReceipt::Native(receipt) => {
                if collected_file_identities != receipt.collected_file_identities {
                    return Err(ExecutionError::InvalidDescriptor {
                        field: "containment_receipt.collected_file_identities".into(),
                        reason: "must exactly bind every returned collected-file identity".into(),
                    });
                }
                if self.immutable_publications != receipt.immutable_publications {
                    return Err(ExecutionError::InvalidDescriptor {
                        field: "containment_receipt.immutable_publications".into(),
                        reason: "must equal returned immutable-publication receipts".into(),
                    });
                }
            }
            ProcessContainmentReceipt::ExternalProvider(_)
                if !collected_file_identities.is_empty()
                    || !self.immutable_publications.is_empty() =>
            {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "process_result".into(),
                    reason: "external-provider results cannot claim native file or publication identities".into(),
                });
            }
            ProcessContainmentReceipt::ExternalProvider(_) => {}
        }
        Ok(())
    }
}

fn receipt_captured_fds(receipt: &ProcessContainmentReceipt) -> &[ProcessCapturedFdIdentity] {
    match receipt {
        ProcessContainmentReceipt::Native(receipt) => &receipt.captured_fds,
        ProcessContainmentReceipt::ExternalProvider(receipt) => &receipt.captured_fds,
    }
}

fn receipt_declared_output_integrity(
    receipt: &ProcessContainmentReceipt,
) -> &BTreeMap<String, String> {
    match receipt {
        ProcessContainmentReceipt::Native(receipt) => &receipt.declared_output_integrity,
        ProcessContainmentReceipt::ExternalProvider(receipt) => &receipt.declared_output_integrity,
    }
}

fn process_containment_receipt_checksum(
    receipt: &ProcessContainmentReceipt,
) -> Result<String, ExecutionError> {
    let mut value =
        serde_json::to_value(receipt).map_err(|error| ExecutionError::InvalidDescriptor {
            field: "containment_receipt".into(),
            reason: format!("JSON value encoding failed: {error}"),
        })?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| ExecutionError::InvalidDescriptor {
            field: "containment_receipt".into(),
            reason: "must encode as a JSON object".into(),
        })?;
    object
        .remove("checksum")
        .ok_or_else(|| ExecutionError::InvalidDescriptor {
            field: "containment_receipt.checksum".into(),
            reason: "checksum member is absent".into(),
        })?;
    Ok(content_hash_hex(
        &json_canonicalization::canonicalize_bytes(&value),
    ))
}

/// Seal one receipt with the execution-types-owned canonical checksum.
pub fn seal_process_containment_receipt(
    word_ids: &ProductWordIds,
    receipt: &mut ProcessContainmentReceipt,
) -> Result<(), ExecutionError> {
    validate_process_containment_receipt_shape(word_ids, receipt)?;
    let checksum = process_containment_receipt_checksum(receipt)?;
    receipt.set_checksum(checksum);
    Ok(())
}

fn validate_process_containment_receipt_shape(
    word_ids: &ProductWordIds,
    receipt: &ProcessContainmentReceipt,
) -> Result<(), ExecutionError> {
    let schema = word_ids.containment_receipt_schema();
    if receipt.schema() != schema {
        return Err(ExecutionError::InvalidDescriptor {
            field: "containment_receipt.schema".into(),
            reason: format!("must equal {schema}"),
        });
    }
    if receipt.checksum_canonicalization() != PROCESS_CONTAINMENT_RECEIPT_CHECKSUM_CANONICALIZATION
    {
        return Err(ExecutionError::InvalidDescriptor {
            field: "containment_receipt.checksum_canonicalization".into(),
            reason: format!("must equal {PROCESS_CONTAINMENT_RECEIPT_CHECKSUM_CANONICALIZATION}"),
        });
    }
    match receipt {
        ProcessContainmentReceipt::Native(_) => Ok(()),
        ProcessContainmentReceipt::ExternalProvider(receipt) => {
            receipt
                .provider
                .validate(word_ids, "containment_receipt.provider")?;
            receipt
                .lifecycle
                .validate("containment_receipt.lifecycle")?;
            Ok(())
        }
    }
}

/// Recompute and verify one received receipt. A structurally valid JSON object
/// is not accepted as evidence unless its exact checksum contract also holds.
pub fn verify_process_containment_receipt(
    word_ids: &ProductWordIds,
    receipt: &ProcessContainmentReceipt,
) -> Result<(), ExecutionError> {
    validate_process_containment_receipt_shape(word_ids, receipt)?;
    validate_content_hash("containment_receipt.checksum", receipt.checksum())?;
    let expected = process_containment_receipt_checksum(receipt)?;
    if receipt.checksum() != expected {
        return Err(ExecutionError::InvalidDescriptor {
            field: "containment_receipt.checksum".into(),
            reason: "does not match canonical receipt bytes".into(),
        });
    }
    Ok(())
}

fn canonical_process_json<T: Serialize>(value: &T) -> Result<Vec<u8>, ExecutionError> {
    let value = serde_json::to_value(value).map_err(|error| ExecutionError::InvalidDescriptor {
        field: "process_wire".into(),
        reason: format!("JSON value encoding failed: {error}"),
    })?;
    Ok(json_canonicalization::canonicalize_bytes(&value))
}

/// Encode one deterministic source archive using the owner canonical JSON
/// byte contract. CAS producers and consumers must use this codec rather than
/// independently choosing a JSON representation.
pub fn encode_process_source_archive(
    word_ids: &ProductWordIds,
    archive: &ProcessSourceArchive,
) -> Result<Vec<u8>, ExecutionError> {
    archive.validate(word_ids)?;
    // This archive can contain tens of megabytes of source bytes. Routing it
    // through `serde_json::Value` makes the canonicalizer repeatedly clone the
    // base64 strings and can amplify memory by orders of magnitude. These wire
    // structs declare keys in lexical order, contain no maps or JSON numbers,
    // and therefore stream bytes identical to RFC-8785 canonicalization.
    #[derive(Serialize)]
    struct CanonicalSourceFile<'a> {
        #[serde(with = "slot_protocol::json_bytes")]
        bytes: &'a [u8],
        executable: bool,
        integrity_hash: &'a str,
        path: &'a [String],
    }
    #[derive(Serialize)]
    struct CanonicalSourceArchive<'a> {
        files: Vec<CanonicalSourceFile<'a>>,
        format: &'a str,
    }
    let wire = CanonicalSourceArchive {
        files: archive
            .files
            .iter()
            .map(|file| CanonicalSourceFile {
                bytes: &file.bytes,
                executable: file.executable,
                integrity_hash: &file.integrity_hash,
                path: &file.path,
            })
            .collect(),
        format: &archive.format,
    };
    serde_json::to_vec(&wire).map_err(|error| ExecutionError::InvalidDescriptor {
        field: "process_source_archive".into(),
        reason: format!("canonical streaming JSON encoding failed: {error}"),
    })
}

/// Strictly decode and validate one source archive retrieved from CAS.
pub fn decode_process_source_archive(
    word_ids: &ProductWordIds,
    bytes: &[u8],
) -> Result<ProcessSourceArchive, ExecutionError> {
    let archive: ProcessSourceArchive =
        serde_json::from_slice(bytes).map_err(|error| ExecutionError::InvalidDescriptor {
            field: "process_source_archive".into(),
            reason: format!("strict JSON decode failed: {error}"),
        })?;
    archive.validate(word_ids)?;
    Ok(archive)
}

/// Encode one portable request using the owner canonical JSON byte contract.
pub fn encode_process_descriptor(
    word_ids: &ProductWordIds,
    descriptor: &ProcessDescriptor,
) -> Result<Vec<u8>, ExecutionError> {
    descriptor.validate(word_ids)?;
    canonical_process_json(descriptor)
}

/// Strictly decode and validate one portable request.
pub fn decode_process_descriptor(
    word_ids: &ProductWordIds,
    bytes: &[u8],
) -> Result<ProcessDescriptor, ExecutionError> {
    let descriptor: ProcessDescriptor =
        serde_json::from_slice(bytes).map_err(|error| ExecutionError::InvalidDescriptor {
            field: "process_descriptor".into(),
            reason: format!("strict JSON decode failed: {error}"),
        })?;
    descriptor.validate(word_ids)?;
    Ok(descriptor)
}

/// Encode one host-private admission using the owner canonical JSON contract.
pub fn encode_admitted_process_descriptor(
    word_ids: &ProductWordIds,
    descriptor: &AdmittedProcessDescriptor,
) -> Result<Vec<u8>, ExecutionError> {
    descriptor.validate(word_ids)?;
    canonical_process_json(descriptor)
}

/// Strictly decode and validate one host-private admission.
pub fn decode_admitted_process_descriptor(
    word_ids: &ProductWordIds,
    bytes: &[u8],
) -> Result<AdmittedProcessDescriptor, ExecutionError> {
    let descriptor: AdmittedProcessDescriptor =
        serde_json::from_slice(bytes).map_err(|error| ExecutionError::InvalidDescriptor {
            field: "admitted_process_descriptor".into(),
            reason: format!("strict JSON decode failed: {error}"),
        })?;
    descriptor.validate(word_ids)?;
    Ok(descriptor)
}

/// Encode one canonical process result.
pub fn encode_process_result(
    word_ids: &ProductWordIds,
    result: &ProcessResult,
) -> Result<Vec<u8>, ExecutionError> {
    result.validate(word_ids)?;
    canonical_process_json(result)
}

/// Strictly decode and validate one canonical process result.
pub fn decode_process_result(
    word_ids: &ProductWordIds,
    bytes: &[u8],
) -> Result<ProcessResult, ExecutionError> {
    let result: ProcessResult =
        serde_json::from_slice(bytes).map_err(|error| ExecutionError::InvalidDescriptor {
            field: "process_result".into(),
            reason: format!("strict JSON decode failed: {error}"),
        })?;
    result.validate(word_ids)?;
    Ok(result)
}

pub(crate) fn validate_relative_mount_path(
    field: &str,
    mount_path: &str,
) -> Result<(), ExecutionError> {
    normalize_process_relative_path(field, mount_path).map(|_| ())
}

/// Normalize one portable relative process path to slash-separated components.
///
/// This is the owner SSOT used for input mounts and mounted-executable
/// selectors. It rejects absolute paths, empty paths, parent traversal, NUL,
/// roots, and platform prefixes; `.` components are removed.
pub fn normalize_process_relative_path(field: &str, value: &str) -> Result<String, ExecutionError> {
    if value.trim().is_empty() || value.as_bytes().contains(&0) {
        return Err(ExecutionError::InvalidDescriptor {
            field: field.into(),
            reason: "must be a nonempty relative path without NUL".into(),
        });
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err(ExecutionError::InvalidDescriptor {
            field: field.into(),
            reason: "must be relative".into(),
        });
    }
    let mut normalized = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(component) => {
                normalized.push(component.to_string_lossy().into_owned())
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ExecutionError::InvalidDescriptor {
                    field: field.into(),
                    reason: format!("contains forbidden component: {value}"),
                });
            }
        }
    }
    if normalized.is_empty() {
        return Err(ExecutionError::InvalidDescriptor {
            field: field.into(),
            reason: "must identify at least one path component".into(),
        });
    }
    Ok(normalized.join("/"))
}

fn validate_content_hash(field: &str, value: &str) -> Result<(), ExecutionError> {
    let parsed = Multihash::from_code_hex(value);
    if parsed.is_err() || value != value.to_lowercase() {
        return Err(ExecutionError::InvalidDescriptor {
            field: field.into(),
            reason: "must be a lowercase multihash code-hex identity".into(),
        });
    }
    Ok(())
}

/// The one content-identity mint for process wire values: multihash
/// code-hex through content-crypto (Blake3 today, `1f:<hex>`).
pub(crate) fn content_hash_hex(bytes: &[u8]) -> String {
    Multihash::hash(bytes).to_code_hex()
}

fn validate_opaque_identity(field: &str, value: &str) -> Result<(), ExecutionError> {
    if value.trim().is_empty() || value.as_bytes().contains(&0) {
        return Err(ExecutionError::InvalidDescriptor {
            field: field.into(),
            reason: "must be a nonempty NUL-free opaque identity".into(),
        });
    }
    Ok(())
}

fn validate_absolute_native_path(field: &str, value: &str) -> Result<(), ExecutionError> {
    if value.trim().is_empty() || !Path::new(value).is_absolute() {
        return Err(ExecutionError::InvalidDescriptor {
            field: field.into(),
            reason: "must be a nonempty absolute path".into(),
        });
    }
    if value.as_bytes().contains(&0) {
        return Err(ExecutionError::InvalidDescriptor {
            field: field.into(),
            reason: "must not contain NUL".into(),
        });
    }
    if Path::new(value)
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(ExecutionError::InvalidDescriptor {
            field: field.into(),
            reason: "must not contain a parent-directory component".into(),
        });
    }
    Ok(())
}

fn validate_argv(argv: &[String]) -> Result<(), ExecutionError> {
    if argv.is_empty() || argv[0].trim().is_empty() {
        return Err(ExecutionError::InvalidDescriptor {
            field: "argv[0]".into(),
            reason: "must select a registered runtime alias or executable input mount".into(),
        });
    }
    if argv.iter().any(|argument| argument.as_bytes().contains(&0)) {
        return Err(ExecutionError::InvalidDescriptor {
            field: "argv".into(),
            reason: "arguments must not contain NUL".into(),
        });
    }
    Ok(())
}

fn validate_timeouts(timeout_ms: u64, termination_grace_ms: u64) -> Result<(), ExecutionError> {
    if timeout_ms == 0 || termination_grace_ms == 0 {
        return Err(ExecutionError::InvalidDescriptor {
            field: "timeout_ms/termination_grace_ms".into(),
            reason: "both values must be greater than zero".into(),
        });
    }
    Ok(())
}

fn validate_capture_fds(capture_fds: &[u16]) -> Result<(), ExecutionError> {
    if capture_fds.len() > 32
        || capture_fds.iter().any(|fd| *fd == 0 || *fd > 255)
        || capture_fds.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(ExecutionError::InvalidDescriptor {
            field: "capture_fds".into(),
            reason: "must be a strictly ascending list of at most 32 descriptors in 1..=255".into(),
        });
    }
    Ok(())
}

fn validate_environment(env: &BTreeMap<String, String>) -> Result<(), ExecutionError> {
    for (key, value) in env {
        if key.is_empty()
            || key.contains('=')
            || key.as_bytes().contains(&0)
            || value.as_bytes().contains(&0)
        {
            return Err(ExecutionError::InvalidDescriptor {
                field: "env".into(),
                reason: "keys must be nonempty without '=' or NUL; values must not contain NUL"
                    .into(),
            });
        }
    }
    Ok(())
}

fn normalize_path_segments(
    field: &str,
    segments: &[String],
    allow_empty: bool,
) -> Result<String, ExecutionError> {
    if segments.is_empty() {
        return if allow_empty {
            Ok(String::new())
        } else {
            Err(ExecutionError::InvalidDescriptor {
                field: field.into(),
                reason: "must contain at least one path segment".into(),
            })
        };
    }
    for segment in segments {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.contains('/')
            || segment.contains('\\')
            || segment.as_bytes().contains(&0)
        {
            return Err(ExecutionError::InvalidDescriptor {
                field: field.into(),
                reason: "segments must be nonempty names without separators, dot traversal, or NUL"
                    .into(),
            });
        }
    }
    Ok(segments.join("/"))
}

/// Normalize machine-readable source-tree path segments.
pub fn normalize_process_path_segments(
    field: &str,
    segments: &[String],
) -> Result<String, ExecutionError> {
    normalize_path_segments(field, segments, false)
}

impl ProcessSourceArchive {
    /// Validate archive format, integrity labels, and deterministic path order.
    pub fn validate(&self, word_ids: &ProductWordIds) -> Result<(), ExecutionError> {
        let format = word_ids.source_archive_format();
        if self.format != format {
            return Err(ExecutionError::InvalidDescriptor {
                field: "input_trees[].source.archive.format".into(),
                reason: format!("must equal {format}"),
            });
        }
        let mut previous_path: Option<Vec<String>> = None;
        for file in &self.files {
            normalize_process_path_segments(
                "input_trees[].source.archive.files[].path",
                &file.path,
            )?;
            let observed = content_crypto::Multihash::hash(&file.bytes).to_code_hex();
            if file.integrity_hash != observed {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "input_trees[].source.archive.files[].integrity_hash".into(),
                    reason: "must equal the canonical multihash of file bytes".into(),
                });
            }
            if previous_path
                .as_ref()
                .is_some_and(|previous| previous >= &file.path)
            {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "input_trees[].source.archive.files[].path".into(),
                    reason: "files must be strictly ascending by path".into(),
                });
            }
            previous_path = Some(file.path.clone());
        }
        Ok(())
    }
}

fn validate_io_mounts(
    word_ids: &ProductWordIds,
    inputs: &[ProcessInputMount],
    input_trees: &[ProcessInputTreeMount],
    outputs: &[ProcessOutputMount],
) -> Result<(), ExecutionError> {
    let mut input_paths = std::collections::BTreeSet::new();
    for input in inputs {
        let normalized = normalize_process_relative_path("inputs[].mount_path", &input.mount_path)?;
        if !input_paths.insert(normalized) {
            return Err(ExecutionError::InvalidDescriptor {
                field: "inputs[].mount_path".into(),
                reason: "normalized input mount paths must be unique".into(),
            });
        }
        match &input.source {
            ProcessInputSource::BlobRef { hash } if hash.trim().is_empty() => {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "inputs[].source.hash".into(),
                    reason: "must not be empty".into(),
                });
            }
            ProcessInputSource::AddressedChunks {
                chunk_manifest_hash,
                byte_len,
                integrity_hash,
            } => {
                for (field, value) in [
                    ("inputs[].source.chunk_manifest_hash", chunk_manifest_hash),
                    ("inputs[].source.integrity_hash", integrity_hash),
                ] {
                    if value.trim().is_empty() {
                        return Err(ExecutionError::InvalidDescriptor {
                            field: field.into(),
                            reason: "must not be empty".into(),
                        });
                    }
                }
                if *byte_len == 0 {
                    return Err(ExecutionError::InvalidDescriptor {
                        field: "inputs[].source.byte_len".into(),
                        reason: "must be greater than zero".into(),
                    });
                }
            }
            _ => {}
        }
    }
    let mut tree_mounts = std::collections::BTreeSet::new();
    for tree in input_trees {
        let normalized =
            normalize_path_segments("input_trees[].mount_path", &tree.mount_path, true)?;
        if !tree_mounts.insert(normalized) {
            return Err(ExecutionError::InvalidDescriptor {
                field: "input_trees[].mount_path".into(),
                reason: "source-tree mount paths must be unique".into(),
            });
        }
        match &tree.source {
            ProcessInputTreeSource::Inline { archive } => archive.validate(word_ids)?,
            ProcessInputTreeSource::BlobRef { hash } if hash.trim().is_empty() => {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "input_trees[].source.hash".into(),
                    reason: "must not be empty".into(),
                });
            }
            ProcessInputTreeSource::BlobRef { .. } => {}
            ProcessInputTreeSource::AddressedChunks {
                chunk_manifest_hash,
                byte_len,
                integrity_hash,
            } => {
                if *byte_len == 0 {
                    return Err(ExecutionError::InvalidDescriptor {
                        field: "input_trees[].source.byte_len".into(),
                        reason: "must be positive".into(),
                    });
                }
                for (field, hash) in [
                    (
                        "input_trees[].source.chunk_manifest_hash",
                        chunk_manifest_hash,
                    ),
                    ("input_trees[].source.integrity_hash", integrity_hash),
                ] {
                    content_crypto::Multihash::from_code_hex(hash).map_err(|_| {
                        ExecutionError::InvalidDescriptor {
                            field: field.into(),
                            reason: "must be a canonical multihash".into(),
                        }
                    })?;
                }
            }
        }
    }

    let mut output_paths = std::collections::BTreeSet::new();
    for output in outputs {
        let normalized =
            normalize_process_relative_path("outputs[].mount_path", &output.mount_path)?;
        if !output_paths.insert(normalized) {
            return Err(ExecutionError::InvalidDescriptor {
                field: "outputs[].mount_path".into(),
                reason: "normalized output mount paths must be unique".into(),
            });
        }
        match output.storage {
            ProcessOutputStorage::Inline
            | ProcessOutputStorage::ImmutableContent
            | ProcessOutputStorage::AddressedChunks => {
                if output.envelope_address.is_some() || !output.envelope_path.is_empty() {
                    return Err(ExecutionError::InvalidDescriptor {
                        field: "outputs[].envelope_address".into(),
                        reason: "Envelope rewrite fields require envelope_rewrite storage".into(),
                    });
                }
            }
            ProcessOutputStorage::EnvelopeRewrite => {
                if output.envelope_address.is_none() {
                    return Err(ExecutionError::InvalidDescriptor {
                        field: "outputs[].envelope_address".into(),
                        reason: "is required for envelope_rewrite storage".into(),
                    });
                }
                if output.chunk_size_bytes.is_some() {
                    return Err(ExecutionError::InvalidDescriptor {
                        field: "outputs[].chunk_size_bytes".into(),
                        reason: "is only valid for addressed_chunks storage".into(),
                    });
                }
            }
            ProcessOutputStorage::EnvelopeWriteSet => {
                if output.envelope_address.is_some()
                    || !output.envelope_path.is_empty()
                    || output.chunk_size_bytes.is_some()
                {
                    return Err(ExecutionError::InvalidDescriptor {
                        field: "outputs[]".into(),
                        reason: "envelope_write_set does not admit rewrite or chunk fields".into(),
                    });
                }
            }
        }
        if matches!(output.storage, ProcessOutputStorage::AddressedChunks)
            && output.chunk_size_bytes == Some(0)
        {
            return Err(ExecutionError::InvalidDescriptor {
                field: "outputs[].chunk_size_bytes".into(),
                reason: "must be greater than zero when present".into(),
            });
        }
    }
    Ok(())
}

fn validate_collected_files(files: &[ProcessCollectedFileSpec]) -> Result<(), ExecutionError> {
    let mut names = std::collections::BTreeSet::new();
    for file in files {
        if file.name.is_empty() || !names.insert(&file.name) {
            return Err(ExecutionError::InvalidDescriptor {
                field: "collected_files[].name".into(),
                reason: "names must be nonempty and unique".into(),
            });
        }
        validate_relative_mount_path("collected_files[].relative_path", &file.relative_path)?;
        if file.max_bytes == 0 {
            return Err(ExecutionError::InvalidDescriptor {
                field: "collected_files[].max_bytes".into(),
                reason: "must be greater than zero".into(),
            });
        }
    }
    Ok(())
}

struct CommonProcessDescriptor<'a> {
    argv: &'a [String],
    timeout_ms: u64,
    termination_grace_ms: u64,
    env: &'a BTreeMap<String, String>,
    inputs: &'a [ProcessInputMount],
    input_trees: &'a [ProcessInputTreeMount],
    outputs: &'a [ProcessOutputMount],
    capture_fds: &'a [u16],
    collected_files: &'a [ProcessCollectedFileSpec],
}

fn validate_common_descriptor(
    word_ids: &ProductWordIds,
    common: CommonProcessDescriptor<'_>,
) -> Result<(), ExecutionError> {
    validate_argv(common.argv)?;
    validate_timeouts(common.timeout_ms, common.termination_grace_ms)?;
    validate_environment(common.env)?;
    validate_io_mounts(word_ids, common.inputs, common.input_trees, common.outputs)?;
    validate_capture_fds(common.capture_fds)?;
    validate_collected_files(common.collected_files)
}

impl ProcessExecutableBinding {
    /// Validate binding grammar without touching the filesystem.
    pub fn validate(&self, field: &str) -> Result<(), ExecutionError> {
        validate_absolute_native_path(&format!("{field}.absolute_path"), &self.absolute_path)?;
        validate_content_hash(&format!("{field}.content_hash"), &self.content_hash)
    }
}

impl ProcessDescriptor {
    /// Validate portable request grammar without resolving any host identity.
    pub fn validate(&self, word_ids: &ProductWordIds) -> Result<(), ExecutionError> {
        validate_common_descriptor(
            word_ids,
            CommonProcessDescriptor {
                argv: &self.argv,
                timeout_ms: self.timeout_ms,
                termination_grace_ms: self.termination_grace_ms,
                env: &self.env,
                inputs: &self.inputs,
                input_trees: &self.input_trees,
                outputs: &self.outputs,
                capture_fds: &self.capture_fds,
                collected_files: &self.collected_files,
            },
        )?;
        let selector = normalize_process_relative_path("argv[0]", &self.argv[0])?;
        if self.argv[0].contains('\\') {
            return Err(ExecutionError::InvalidDescriptor {
                field: "argv[0]".into(),
                reason: "backslash path syntax is not portable".into(),
            });
        }
        if let Some(cwd) = &self.cwd {
            if cwd != "." {
                normalize_process_relative_path("cwd", cwd)?;
            }
        }
        if let Some(volume) = &self.private_volume {
            if volume.name.trim().is_empty()
                || volume.name.starts_with('.')
                || volume.name.contains('/')
                || volume.name.contains('\\')
                || volume.name.as_bytes().contains(&0)
            {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "private_volume.name".into(),
                    reason: "must be a direct portable owner-registered name".into(),
                });
            }
        }
        let selector_is_path = self.argv[0].contains('/') || self.argv[0].starts_with('.');
        if selector_is_path {
            let declared_executable = self.inputs.iter().any(|input| {
                input.executable
                    && normalize_process_relative_path("inputs[].mount_path", &input.mount_path)
                        .is_ok_and(|mount| mount == selector)
            });
            if !declared_executable && self.input_trees.is_empty() {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "argv[0]".into(),
                    reason:
                        "relative executable selectors must resolve to an executable input mount"
                            .into(),
                });
            }
        }
        if let ProcessContainmentRequest::DescendantEffectContained {
            pipe_eof_timeout_ms,
            publications,
        } = &self.containment
        {
            if *pipe_eof_timeout_ms == 0 {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "containment.pipe_eof_timeout_ms".into(),
                    reason: "must be greater than zero".into(),
                });
            }
            let mut names = std::collections::BTreeSet::new();
            let mut destinations = std::collections::BTreeSet::new();
            for publication in publications {
                if publication.name.is_empty() || !names.insert(&publication.name) {
                    return Err(ExecutionError::InvalidDescriptor {
                        field: "containment.publications[].name".into(),
                        reason: "names must be nonempty and unique".into(),
                    });
                }
                validate_relative_mount_path(
                    "containment.publications[].source_relative_path",
                    &publication.source_relative_path,
                )?;
                if publication.destination_ref.trim().is_empty()
                    || publication.destination_ref.as_bytes().contains(&0)
                    || !destinations.insert(&publication.destination_ref)
                {
                    return Err(ExecutionError::InvalidDescriptor {
                        field: "containment.publications[].destination_ref".into(),
                        reason: "references must be nonempty, NUL-free, and unique".into(),
                    });
                }
                if let Some(hash) = &publication.expected_content_hash {
                    validate_content_hash(
                        "containment.publications[].expected_content_hash",
                        hash,
                    )?;
                }
            }
        }
        Ok(())
    }
}

impl AdmittedNativeProcessDescriptor {
    /// Validate the host-private native admission grammar.
    pub fn validate(&self, word_ids: &ProductWordIds) -> Result<(), ExecutionError> {
        if self.linux_mount_namespace
            && (!cfg!(target_os = "linux")
                || self.computer_access.is_full()
                || !self.host_enforced_isolation.is_empty())
        {
            return Err(ExecutionError::InvalidDescriptor {
                field: "linux_mount_namespace".into(),
                reason: "requires contained native Linux execution without a host filesystem grant"
                    .into(),
            });
        }
        validate_content_hash("request_content_hash", &self.request_content_hash)?;
        self.executable.validate("executable")?;
        validate_absolute_native_path("cwd", &self.cwd)?;
        validate_common_descriptor(
            word_ids,
            CommonProcessDescriptor {
                argv: &self.argv,
                timeout_ms: self.timeout_ms,
                termination_grace_ms: self.termination_grace_ms,
                env: &self.env,
                inputs: &self.inputs,
                input_trees: &self.input_trees,
                outputs: &self.outputs,
                capture_fds: &self.capture_fds,
                collected_files: &self.collected_files,
            },
        )?;
        if self.argv[0] != self.executable.absolute_path {
            return Err(ExecutionError::InvalidDescriptor {
                field: "argv[0]".into(),
                reason: "must equal executable.absolute_path after admission".into(),
            });
        }
        let (effect_root, readable_roots) = match &self.containment {
            ProcessContainmentPolicy::Leaf {
                writable_root,
                readable_roots,
            } => {
                validate_absolute_native_path("containment.writable_root", writable_root)?;
                (writable_root.as_str(), readable_roots.as_slice())
            }
            ProcessContainmentPolicy::DescendantEffectContained {
                staging_root,
                pipe_eof_timeout_ms,
                readable_roots,
                publications,
            } => {
                validate_absolute_native_path("containment.staging_root", staging_root)?;
                if *pipe_eof_timeout_ms == 0 {
                    return Err(ExecutionError::InvalidDescriptor {
                        field: "containment.pipe_eof_timeout_ms".into(),
                        reason: "must be greater than zero".into(),
                    });
                }
                let mut names = std::collections::BTreeSet::new();
                for publication in publications {
                    if publication.name.is_empty() || !names.insert(&publication.name) {
                        return Err(ExecutionError::InvalidDescriptor {
                            field: "containment.publications[].name".into(),
                            reason: "names must be nonempty and unique".into(),
                        });
                    }
                    validate_relative_mount_path(
                        "containment.publications[].source_relative_path",
                        &publication.source_relative_path,
                    )?;
                    validate_absolute_native_path(
                        "containment.publications[].destination_path",
                        &publication.destination_path,
                    )?;
                    if Path::new(&publication.destination_path).starts_with(staging_root) {
                        return Err(ExecutionError::InvalidDescriptor {
                            field: "containment.publications[].destination_path".into(),
                            reason:
                                "immutable destination must be outside descendant write authority"
                                    .into(),
                        });
                    }
                    if let Some(hash) = &publication.expected_content_hash {
                        validate_content_hash(
                            "containment.publications[].expected_content_hash",
                            hash,
                        )?;
                    }
                }
                (staging_root.as_str(), readable_roots.as_slice())
            }
        };
        if !Path::new(&self.cwd).starts_with(effect_root) {
            return Err(ExecutionError::InvalidDescriptor {
                field: "cwd".into(),
                reason: "must remain beneath the admitted private effect root".into(),
            });
        }
        for root in readable_roots {
            validate_absolute_native_path("containment.readable_roots[]", root)?;
            if self.linux_mount_namespace
                && Path::new(effect_root).starts_with(root)
                && root != effect_root
            {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "containment.readable_roots[]".into(),
                    reason: "a readable parent would expose other private workspaces".into(),
                });
            }
        }
        Ok(())
    }
}

impl ProcessExternalProviderAttestation {
    fn validate(&self, field: &str) -> Result<(), ExecutionError> {
        validate_opaque_identity(&format!("{field}.attestation_id"), &self.attestation_id)?;
        validate_opaque_identity(&format!("{field}.issuer"), &self.issuer)?;
        validate_content_hash(
            &format!("{field}.provider_evidence_content_hash"),
            &self.provider_evidence_content_hash,
        )?;
        validate_content_hash(
            &format!("{field}.statement_content_hash"),
            &self.statement_content_hash,
        )?;
        Ok(())
    }
}

#[derive(Serialize)]
struct ProcessExternalProviderCapabilityStatement<'a> {
    schema: &'a str,
    provider_id: &'a str,
    provider_protocol_revision: &'a str,
    provider_connection_revision: &'a str,
    attestation_id: &'a str,
    issuer: &'a str,
    provider_evidence_content_hash: &'a str,
    capabilities: &'a ProcessExecutionCapabilitySet,
}

fn external_provider_statement_content_hash(
    word_ids: &ProductWordIds,
    admission: &ProcessExternalProviderAdmission,
) -> Result<String, ExecutionError> {
    let attestation = &admission.attestation;
    let value = serde_json::to_value(ProcessExternalProviderCapabilityStatement {
        schema: word_ids.external_provider_capability_statement_schema(),
        provider_id: &admission.provider_id,
        provider_protocol_revision: &admission.provider_protocol_revision,
        provider_connection_revision: &admission.provider_connection_revision,
        attestation_id: &attestation.attestation_id,
        issuer: &attestation.issuer,
        provider_evidence_content_hash: &attestation.provider_evidence_content_hash,
        capabilities: &attestation.capabilities,
    })
    .map_err(|error| ExecutionError::InvalidDescriptor {
        field: "provider.attestation".into(),
        reason: format!("cannot encode capability statement: {error}"),
    })?;
    Ok(content_hash_hex(
        &json_canonicalization::canonicalize_bytes(&value),
    ))
}

/// Issue one decoder-owned capability statement from verified provider
/// evidence: whatever `statement_content_hash` the admission carries is replaced
/// by the canonical statement hash. This is the only producer of that hash.
pub fn issue_external_provider_admission(
    word_ids: &ProductWordIds,
    mut admission: ProcessExternalProviderAdmission,
) -> Result<ProcessExternalProviderAdmission, ExecutionError> {
    admission.attestation.statement_content_hash =
        external_provider_statement_content_hash(word_ids, &admission)?;
    admission.validate(word_ids, "provider")?;
    Ok(admission)
}

impl ProcessExternalProviderAdmission {
    fn validate(&self, word_ids: &ProductWordIds, field: &str) -> Result<(), ExecutionError> {
        validate_opaque_identity(&format!("{field}.provider_id"), &self.provider_id)?;
        validate_opaque_identity(
            &format!("{field}.provider_protocol_revision"),
            &self.provider_protocol_revision,
        )?;
        validate_opaque_identity(
            &format!("{field}.provider_connection_revision"),
            &self.provider_connection_revision,
        )?;
        self.attestation.validate(&format!("{field}.attestation"))?;
        let expected = external_provider_statement_content_hash(word_ids, self)?;
        if self.attestation.statement_content_hash != expected {
            return Err(ExecutionError::InvalidDescriptor {
                field: format!("{field}.attestation.statement_content_hash"),
                reason: "must equal the canonical decoder-issued capability statement hash".into(),
            });
        }
        Ok(())
    }
}

impl ProcessExternalProviderExecutionIdentity {
    fn validate(&self, provider: &ProcessExternalProviderAdmission) -> Result<(), ExecutionError> {
        validate_opaque_identity(
            "execution.provider_execution_id",
            &self.provider_execution_id,
        )?;
        validate_opaque_identity("execution.correlation_id", &self.correlation_id)?;
        if !provider
            .attestation
            .capabilities
            .contains(&self.requested_capabilities)
        {
            return Err(ExecutionError::InvalidDescriptor {
                field: "execution.requested_capabilities".into(),
                reason: "must be a subset of the provider-written attested capabilities".into(),
            });
        }
        if self.requested_capabilities.persistent_session != self.persistent_session_id.is_some() {
            return Err(ExecutionError::InvalidDescriptor {
                field: "execution.persistent_session_id".into(),
                reason: "must be present exactly when persistent_session is requested".into(),
            });
        }
        if self.requested_capabilities.exclusive_private_volume_lease
            != self.private_volume_lease_id.is_some()
        {
            return Err(ExecutionError::InvalidDescriptor {
                field: "execution.private_volume_lease_id".into(),
                reason: "must be present exactly when exclusive_private_volume_lease is requested"
                    .into(),
            });
        }
        for (field, value) in [
            (
                "execution.persistent_session_id",
                &self.persistent_session_id,
            ),
            (
                "execution.private_volume_lease_id",
                &self.private_volume_lease_id,
            ),
        ] {
            if let Some(value) = value {
                validate_opaque_identity(field, value)?;
            }
        }
        Ok(())
    }
}

impl AdmittedExternalProcessDescriptor {
    fn validate(&self, word_ids: &ProductWordIds) -> Result<(), ExecutionError> {
        validate_content_hash("request_content_hash", &self.request_content_hash)?;
        self.provider.validate(word_ids, "provider")?;
        self.execution.validate(&self.provider)?;
        validate_timeouts(self.timeout_ms, self.termination_grace_ms)?;
        validate_io_mounts(word_ids, &[], &[], &self.outputs)?;
        validate_capture_fds(&self.capture_fds)
    }
}

impl AdmittedProcessDescriptor {
    /// Validate the exact host-private admission variant.
    pub fn validate(&self, word_ids: &ProductWordIds) -> Result<(), ExecutionError> {
        match self {
            Self::Native(descriptor) => descriptor.validate(word_ids),
            Self::ExternalProvider(descriptor) => descriptor.validate(word_ids),
        }
    }

    pub fn request_content_hash(&self) -> &str {
        match self {
            Self::Native(descriptor) => &descriptor.request_content_hash,
            Self::ExternalProvider(descriptor) => &descriptor.request_content_hash,
        }
    }
}

/// Resource limits for process execution.
/// Consolidated from bridge's RunnerLimits.
#[derive(Debug, Clone)]
pub struct ProcessLimits {
    /// Global ceiling for bytes returned inline in `ProcessResult`.
    ///
    /// This covers stdout, stderr, and declared outputs whose storage is
    /// `inline`. Declared outputs using `addressed_chunks` are streamed through
    /// bounded chunks and only return a small manifest reference inline.
    pub max_output_bytes: u64,
    /// Maximum per-chunk allocation for declared outputs using
    /// `addressed_chunks`. This does not cap total streamed output length; it
    /// caps one in-memory chunk buffer.
    pub max_addressed_chunk_bytes: u64,
    /// Grace period between SIGTERM and SIGKILL.
    pub kill_grace: Duration,
}

impl Default for ProcessLimits {
    fn default() -> Self {
        Self {
            max_output_bytes: 100 * 1024 * 1024,         // 100 MB
            max_addressed_chunk_bytes: 16 * 1024 * 1024, // 16 MB
            kill_grace: Duration::from_millis(1000),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::product_word_ids::example_product_word_ids;
    use serde_json::json;

    // Content identities of the neutral `contracts/*.golden.json` files after
    // their one repository newline is removed.
    const PROCESS_DESCRIPTOR_GOLDEN_CONTENT_HASH: &str =
        "1f:3596ea188a31b3021288d264797eac0540ddccba81464373f69d1f457255fa33";
    const ADMITTED_PROCESS_DESCRIPTOR_GOLDEN_CONTENT_HASH: &str =
        "1f:99c32b346892b05e4edf92428cedeef71956bdd37bbc4b93045e956cc1b2cbc4";
    const PROCESS_RESULT_GOLDEN_CONTENT_HASH: &str =
        "1f:d4900248daf4be4065c8c04c9d7f65e4ea7e036d1c67b2ec8a7367507cb4c52c";

    fn contract_file_bytes(bytes: &'static [u8]) -> &'static [u8] {
        bytes.strip_suffix(b"\n").unwrap_or(bytes)
    }

    fn process_descriptor_golden_bytes() -> &'static [u8] {
        contract_file_bytes(include_bytes!(
            "../contracts/process-descriptor.golden.json"
        ))
    }

    fn admitted_process_descriptor_golden_bytes() -> &'static [u8] {
        contract_file_bytes(include_bytes!(
            "../contracts/admitted-process-descriptor.golden.json"
        ))
    }

    fn process_result_golden_bytes() -> &'static [u8] {
        contract_file_bytes(include_bytes!("../contracts/process-result.golden.json"))
    }

    fn descriptor(argv: Vec<String>, cwd: Option<String>) -> ProcessDescriptor {
        ProcessDescriptor {
            argv,
            cwd,
            timeout_ms: 1000,
            termination_grace_ms: 100,
            expected_termination: Some(ProcessTermination::Exited { code: 0 }),
            env: BTreeMap::new(),
            inputs: Vec::new(),
            input_trees: Vec::new(),
            outputs: Vec::new(),
            private_volume: None,
            readable_private_volumes: Vec::new(),
            network_access: ProcessNetworkAccess::Denied,
            containment: ProcessContainmentRequest::Leaf,
            capture_fds: vec![1, 2, 3],
            collected_files: Vec::new(),
        }
    }

    fn content_hash(bytes: &[u8]) -> String {
        content_hash_hex(bytes)
    }

    pub(crate) fn golden_request() -> ProcessDescriptor {
        let tool_bytes = b"portable-tool".to_vec();
        ProcessDescriptor {
            argv: vec!["golden-runtime".into(), "--mode".into(), "verify".into()],
            cwd: Some("workspace".into()),
            timeout_ms: 2_500,
            termination_grace_ms: DEFAULT_PROCESS_TERMINATION_GRACE_MS,
            expected_termination: None,
            env: BTreeMap::from([
                ("LANG".into(), "C.UTF-8".into()),
                ("MODE".into(), "golden".into()),
            ]),
            inputs: vec![ProcessInputMount {
                mount_path: "workspace/config.json".into(),
                source: ProcessInputSource::Inline {
                    bytes: br#"{"ok":true}"#.to_vec(),
                },
                content_type: Some("application/json".into()),
                executable: false,
            }],
            input_trees: vec![
                ProcessInputTreeMount {
                    mount_path: vec!["workspace".into(), "src".into()],
                    source: ProcessInputTreeSource::Inline {
                        archive: ProcessSourceArchive {
                            format: example_product_word_ids().source_archive_format().into(),
                            files: vec![ProcessSourceArchiveFile {
                                path: vec!["bin".into(), "tool".into()],
                                integrity_hash: content_crypto::Multihash::hash(&tool_bytes)
                                    .to_code_hex(),
                                bytes: tool_bytes,
                                executable: true,
                            }],
                        },
                    },
                },
                ProcessInputTreeMount {
                    mount_path: vec!["workspace".into(), "vendor".into()],
                    source: ProcessInputTreeSource::BlobRef {
                        hash: content_crypto::Multihash::hash(b"source archive").to_code_hex(),
                    },
                },
            ],
            outputs: vec![ProcessOutputMount {
                mount_path: "workspace/result.json".into(),
                content_type: Some("application/json".into()),
                storage: ProcessOutputStorage::Inline,
                envelope_address: None,
                envelope_path: Vec::new(),
                chunk_size_bytes: None,
            }],
            private_volume: None,
            readable_private_volumes: Vec::new(),
            network_access: ProcessNetworkAccess::Denied,
            containment: ProcessContainmentRequest::Leaf,
            capture_fds: vec![1, 2, 3],
            collected_files: vec![ProcessCollectedFileSpec {
                name: "summary".into(),
                relative_path: "workspace/summary.txt".into(),
                max_bytes: 4_096,
            }],
        }
    }

    pub(crate) fn golden_admission(request: &ProcessDescriptor) -> AdmittedProcessDescriptor {
        let root = "/private/var/tmp/example-process-job-golden";
        AdmittedProcessDescriptor::Native(AdmittedNativeProcessDescriptor {
            request_content_hash: content_hash(
                &encode_process_descriptor(&example_product_word_ids(), request)
                    .expect("canonical golden request"),
            ),
            executable: ProcessExecutableBinding {
                absolute_path: "/opt/example/bin/golden-runtime".into(),
                content_hash: format!("1f:{}", "11".repeat(32)),
                expected_unix_mode: Some(0o755),
            },
            argv: vec![
                "/opt/example/bin/golden-runtime".into(),
                "--mode".into(),
                "verify".into(),
            ],
            cwd: format!("{root}/workspace"),
            timeout_ms: request.timeout_ms,
            termination_grace_ms: request.termination_grace_ms,
            expected_termination: request.expected_termination.clone(),
            env: request.env.clone(),
            inputs: request.inputs.clone(),
            input_trees: request.input_trees.clone(),
            outputs: request.outputs.clone(),
            network_access: request.network_access,
            computer_access: Default::default(),
            host_enforced_isolation: Default::default(),
            linux_mount_namespace: false,
            containment: ProcessContainmentPolicy::Leaf {
                writable_root: root.into(),
                readable_roots: vec!["/opt/example/lib".into(), root.into()],
            },
            capture_fds: request.capture_fds.clone(),
            collected_files: request.collected_files.clone(),
        })
    }

    fn golden_file_identity() -> ProcessFileIdentity {
        ProcessFileIdentity {
            absolute_path: "/opt/example/bin/golden-runtime".into(),
            canonical_parent_path: "/opt/example/bin".into(),
            device_id: "16777234".into(),
            inode: "424242".into(),
            generation: ProcessFileGeneration::Observed { value: "7".into() },
            link_count: "1".into(),
            byte_length: "8192".into(),
            unix_mode: 0o755,
            birthtime_ns: "1700000000000000000".into(),
            ctime_ns: "1700000001000000000".into(),
            opened_no_follow: true,
            stable_readback: true,
            content_hash: format!("1f:{}", "22".repeat(32)),
            code_identity: ProcessCodeIdentity::Validated {
                authority: "golden-signing-authority".into(),
            },
        }
    }

    pub(crate) fn golden_result(
        request: &ProcessDescriptor,
        admission: &AdmittedProcessDescriptor,
    ) -> ProcessResult {
        let captures = [(1_u16, b"stdout".as_slice()), (2, b"stderr"), (3, b"meta")]
            .into_iter()
            .map(|(fd, bytes)| ProcessCapturedFd {
                fd,
                bytes: bytes.to_vec(),
                content_hash: content_hash(bytes),
                eof_observed: true,
            })
            .collect::<Vec<_>>();
        let identity = golden_file_identity();
        let termination = ProcessTermination::Exited { code: 7 };
        let request_content_hash = content_hash(
            &encode_process_descriptor(&example_product_word_ids(), request)
                .expect("canonical golden request"),
        );
        let admitted_descriptor_content_hash = content_hash(
            &encode_admitted_process_descriptor(&example_product_word_ids(), admission)
                .expect("canonical golden admitted descriptor"),
        );
        let receipt = NativeProcessContainmentReceipt {
            schema: example_product_word_ids().containment_receipt_schema().into(),
            request_content_hash,
            admitted_descriptor_content_hash,
            platform: "darwin".into(),
            enforcement_mechanism: "golden-held-vnode".into(),
            sandbox_policy_content_hash: content_hash(b"golden sandbox policy"),
            sandbox_applied_before_exec: true,
            full_computer_access: false,
            network_denied: true,
            child_process_creation_denied: true,
            inherited_by_descendants: true,
            writable_roots: vec!["/private/var/tmp/example-process-job-golden".into()],
            direct_child_pid: 4_242,
            direct_child_start_seconds: "1700000000".into(),
            direct_child_start_microseconds: "123456".into(),
            boot_session_uuid: "00000000-0000-4000-8000-000000000001".into(),
            boot_session_identity_content_hash: content_hash(
                b"00000000-0000-4000-8000-000000000001",
            ),
            admitted_executable: identity.clone(),
            image_observations: vec![ProcessImageObservation {
                exec_ordinal: 1,
                identity,
            }],
            termination: termination.clone(),
            parent_reaped: true,
            captured_pipes_eof: true,
            captured_fds: captures
                .iter()
                .map(|capture| ProcessCapturedFdIdentity {
                    fd: capture.fd,
                    byte_length: capture.bytes.len().to_string(),
                    content_hash: capture.content_hash.clone(),
                    eof_observed: capture.eof_observed,
                })
                .collect(),
            collected_file_identities: BTreeMap::new(),
            declared_output_integrity: BTreeMap::new(),
            immutable_publications: Vec::new(),
            checksum_canonicalization: PROCESS_CONTAINMENT_RECEIPT_CHECKSUM_CANONICALIZATION.into(),
            checksum: String::new(),
        };
        let mut receipt = ProcessContainmentReceipt::Native(Box::new(receipt));
        seal_process_containment_receipt(&example_product_word_ids(), &mut receipt)
            .expect("seal golden receipt");
        ProcessResult {
            termination,
            captured_fds: captures,
            outputs: Vec::new(),
            collected_files: Vec::new(),
            immutable_publications: Vec::new(),
            duration_ms: 12,
            containment_receipt: receipt,
        }
    }

    #[cfg(feature = "regenerate-goldens")]
    #[test]
    fn regenerate_process_contract_goldens() {
        let request = golden_request();
        let admission = golden_admission(&request);
        let result = golden_result(&request, &admission);
        let request_bytes =
            encode_process_descriptor(&example_product_word_ids(), &request).expect("encode request");
        let admission_bytes = encode_admitted_process_descriptor(&example_product_word_ids(), &admission)
            .expect("encode admission");
        let result_bytes =
            encode_process_result(&example_product_word_ids(), &result).expect("encode result");
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("contracts");
        for (name, bytes) in [
            ("process-descriptor.golden.json", &request_bytes),
            ("admitted-process-descriptor.golden.json", &admission_bytes),
            ("process-result.golden.json", &result_bytes),
        ] {
            let mut file_bytes = bytes.clone();
            file_bytes.push(b'\n');
            std::fs::write(root.join(name), file_bytes).expect("write golden contract");
        }
        println!(
            "PROCESS_DESCRIPTOR_GOLDEN_CONTENT_HASH = {}",
            content_hash(&request_bytes)
        );
        println!(
            "ADMITTED_PROCESS_DESCRIPTOR_GOLDEN_CONTENT_HASH = {}",
            content_hash(&admission_bytes)
        );
        println!(
            "PROCESS_RESULT_GOLDEN_CONTENT_HASH = {}",
            content_hash(&result_bytes)
        );
    }

    #[test]
    fn process_contract_goldens_are_literal_canonical_bytes_with_stable_hashes() {
        let request = golden_request();
        let admission = golden_admission(&request);
        let result = golden_result(&request, &admission);
        let request_bytes =
            encode_process_descriptor(&example_product_word_ids(), &request).expect("encode request");
        let admission_bytes = encode_admitted_process_descriptor(&example_product_word_ids(), &admission)
            .expect("encode admission");
        let result_bytes =
            encode_process_result(&example_product_word_ids(), &result).expect("encode result");

        assert_eq!(request_bytes, process_descriptor_golden_bytes());
        assert_eq!(admission_bytes, admitted_process_descriptor_golden_bytes());
        assert_eq!(result_bytes, process_result_golden_bytes());
        assert_eq!(
            content_hash(&request_bytes),
            PROCESS_DESCRIPTOR_GOLDEN_CONTENT_HASH
        );
        assert_eq!(
            content_hash(&admission_bytes),
            ADMITTED_PROCESS_DESCRIPTOR_GOLDEN_CONTENT_HASH
        );
        assert_eq!(
            content_hash(&result_bytes),
            PROCESS_RESULT_GOLDEN_CONTENT_HASH
        );
    }

    #[test]
    fn process_contract_goldens_round_trip_and_bind_both_descriptor_hashes() {
        let request =
            decode_process_descriptor(&example_product_word_ids(), process_descriptor_golden_bytes())
                .expect("decode request golden");
        let admission = decode_admitted_process_descriptor(
            &example_product_word_ids(),
            admitted_process_descriptor_golden_bytes(),
        )
        .expect("decode admission golden");
        let result = decode_process_result(&example_product_word_ids(), process_result_golden_bytes())
            .expect("decode result golden");

        assert_eq!(request, golden_request());
        assert_eq!(admission, golden_admission(&request));
        assert_eq!(result, golden_result(&request, &admission));
        assert_eq!(
            admission.request_content_hash(),
            PROCESS_DESCRIPTOR_GOLDEN_CONTENT_HASH
        );
        assert_eq!(
            result.containment_receipt.request_content_hash(),
            PROCESS_DESCRIPTOR_GOLDEN_CONTENT_HASH
        );
        assert_eq!(
            result
                .containment_receipt
                .admitted_descriptor_content_hash(),
            ADMITTED_PROCESS_DESCRIPTOR_GOLDEN_CONTENT_HASH
        );
        assert_eq!(request.expected_termination, None);
        assert_eq!(result.termination, ProcessTermination::Exited { code: 7 });
    }

    fn insert_unknown(value: &mut serde_json::Value, pointer: &str) {
        value
            .pointer_mut(pointer)
            .and_then(serde_json::Value::as_object_mut)
            .expect("fixture pointer must select an object")
            .insert("unknown_contract_member".into(), json!(true));
    }

    #[test]
    fn strict_request_decoder_rejects_top_level_and_nested_unknown_fields() {
        for pointer in ["", "/inputs/0", "/input_trees/0/source/archive/files/0"] {
            let mut value: serde_json::Value =
                serde_json::from_slice(process_descriptor_golden_bytes()).unwrap();
            insert_unknown(&mut value, pointer);
            assert!(decode_process_descriptor(
                &example_product_word_ids(),
                &serde_json::to_vec(&value).unwrap()
            )
            .is_err());
        }
    }

    #[test]
    fn strict_admission_decoder_rejects_top_level_and_nested_unknown_fields() {
        for pointer in ["", "/executable", "/containment"] {
            let mut value: serde_json::Value =
                serde_json::from_slice(admitted_process_descriptor_golden_bytes()).unwrap();
            insert_unknown(&mut value, pointer);
            assert!(decode_admitted_process_descriptor(
                &example_product_word_ids(),
                &serde_json::to_vec(&value).unwrap()
            )
            .is_err());
        }
    }

    #[test]
    fn strict_result_decoder_rejects_top_level_and_nested_unknown_fields() {
        for pointer in [
            "",
            "/captured_fds/0",
            "/containment_receipt",
            "/containment_receipt/admitted_executable",
        ] {
            let mut value: serde_json::Value =
                serde_json::from_slice(process_result_golden_bytes()).unwrap();
            insert_unknown(&mut value, pointer);
            assert!(decode_process_result(
                &example_product_word_ids(),
                &serde_json::to_vec(&value).unwrap()
            )
            .is_err());
        }
    }

    #[test]
    fn result_rejects_capture_order_mismatch() {
        let request = golden_request();
        let admission = golden_admission(&request);
        let mut result = golden_result(&request, &admission);
        result.captured_fds.swap(1, 2);
        assert!(matches!(
            result.validate(&example_product_word_ids()),
            Err(ExecutionError::InvalidDescriptor { ref field, .. }) if field == "capture_fds"
        ));
    }

    #[test]
    fn result_rejects_receipt_checksum_tampering_and_unknown_canonicalization() {
        let request = golden_request();
        let admission = golden_admission(&request);
        let mut tampered = golden_result(&request, &admission);
        let ProcessContainmentReceipt::Native(receipt) = &mut tampered.containment_receipt else {
            panic!("golden receipt is native")
        };
        receipt.platform = "tampered".into();
        assert!(matches!(
            tampered.validate(&example_product_word_ids()),
            Err(ExecutionError::InvalidDescriptor { ref field, .. })
                if field == "containment_receipt.checksum"
        ));

        let mut unknown = golden_result(&request, &admission);
        let ProcessContainmentReceipt::Native(receipt) = &mut unknown.containment_receipt else {
            panic!("golden receipt is native")
        };
        receipt.checksum_canonicalization = "unknown".into();
        assert!(matches!(
            unknown.validate(&example_product_word_ids()),
            Err(ExecutionError::InvalidDescriptor { ref field, .. })
                if field == "containment_receipt.checksum_canonicalization"
        ));
    }

    #[test]
    fn source_tree_inline_blob_ordering_and_integrity_are_validated() {
        let request = golden_request();
        request
            .validate(&example_product_word_ids())
            .expect("inline and blob trees are valid");
        assert!(matches!(
            request.input_trees[1].source,
            ProcessInputTreeSource::BlobRef { .. }
        ));

        let mut unsorted = request.clone();
        let ProcessInputTreeSource::Inline { archive } = &mut unsorted.input_trees[0].source else {
            panic!("golden tree is inline")
        };
        let second_bytes = b"sorts-before".to_vec();
        archive.files.push(ProcessSourceArchiveFile {
            path: vec!["a".into()],
            integrity_hash: content_crypto::Multihash::hash(&second_bytes).to_code_hex(),
            bytes: second_bytes,
            executable: false,
        });
        assert!(unsorted.validate(&example_product_word_ids()).is_err());

        let mut wrong_hash = request.clone();
        let ProcessInputTreeSource::Inline { archive } = &mut wrong_hash.input_trees[0].source
        else {
            panic!("golden tree is inline")
        };
        archive.files[0].integrity_hash = content_crypto::Multihash::hash(b"other").to_code_hex();
        assert!(wrong_hash.validate(&example_product_word_ids()).is_err());

        let mut empty_blob = request;
        let ProcessInputTreeSource::BlobRef { hash } = &mut empty_blob.input_trees[1].source else {
            panic!("golden tree is blob-ref")
        };
        hash.clear();
        assert!(empty_blob.validate(&example_product_word_ids()).is_err());
    }

    #[test]
    fn source_archive_owner_codec_is_canonical_strict_and_round_trips() {
        let request = golden_request();
        let ProcessInputTreeSource::Inline { archive } = &request.input_trees[0].source else {
            panic!("golden tree is inline")
        };
        let bytes = encode_process_source_archive(&example_product_word_ids(), archive)
            .expect("canonical archive bytes");
        assert_eq!(
            bytes,
            json_canonicalization::canonicalize_bytes(
                &serde_json::to_value(archive).expect("archive JSON value")
            )
        );
        assert_eq!(
            decode_process_source_archive(&example_product_word_ids(), &bytes)
                .expect("strict archive decode"),
            *archive
        );

        let mut unknown_top: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        unknown_top
            .as_object_mut()
            .unwrap()
            .insert("unknown".into(), serde_json::json!(true));
        assert!(decode_process_source_archive(
            &example_product_word_ids(),
            &serde_json::to_vec(&unknown_top).unwrap()
        )
        .is_err());

        let mut unknown_file: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        unknown_file["files"][0]["unknown"] = serde_json::json!(true);
        assert!(decode_process_source_archive(
            &example_product_word_ids(),
            &serde_json::to_vec(&unknown_file).unwrap()
        )
        .is_err());
    }

    #[test]
    fn optional_expected_termination_preserves_any_exact_natural_result() {
        let mut request = golden_request();
        request.expected_termination = None;
        request
            .validate(&example_product_word_ids())
            .expect("no expected termination is valid");
        let admission = golden_admission(&request);
        let result = golden_result(&request, &admission);
        assert_eq!(result.termination, ProcessTermination::Exited { code: 7 });
        result
            .validate(&example_product_word_ids())
            .expect("nonzero natural exit remains exact data");
    }

    #[test]
    fn seal_and_verify_use_one_execution_types_owner_primitive() {
        let request = golden_request();
        let admission = golden_admission(&request);
        let mut result = golden_result(&request, &admission);
        let original = result.containment_receipt.checksum().to_owned();
        let ProcessContainmentReceipt::Native(receipt) = &mut result.containment_receipt else {
            panic!("golden receipt is native")
        };
        receipt.checksum.clear();
        seal_process_containment_receipt(&example_product_word_ids(), &mut result.containment_receipt)
            .unwrap();
        assert_eq!(result.containment_receipt.checksum(), original);
        verify_process_containment_receipt(&example_product_word_ids(), &result.containment_receipt)
            .unwrap();
        let golden = decode_process_result(&example_product_word_ids(), process_result_golden_bytes())
            .expect("decode result golden");
        assert_eq!(
            result.containment_receipt.checksum(),
            golden.containment_receipt.checksum()
        );
    }

    #[test]
    fn process_descriptor_inline_input_bytes_use_canonical_json_bytes() {
        let mut descriptor = descriptor(
            vec!["python3".to_string(), "script.py".to_string()],
            Some("scripts".to_string()),
        );
        descriptor.inputs = vec![ProcessInputMount {
            mount_path: "title-overrides.json".to_string(),
            source: ProcessInputSource::Inline {
                bytes: b"[]".to_vec(),
            },
            content_type: Some("application/json".to_string()),
            executable: false,
        }];

        let encoded = serde_json::to_value(&descriptor).expect("serialize descriptor");
        assert_eq!(
            encoded["inputs"][0]["source"],
            json!({"kind": "inline", "bytes": "W10="})
        );

        let decoded: ProcessDescriptor =
            serde_json::from_value(encoded).expect("deserialize descriptor");
        match &decoded.inputs[0].source {
            ProcessInputSource::Inline { bytes } => assert_eq!(bytes, b"[]"),
            ProcessInputSource::BlobRef { .. } | ProcessInputSource::AddressedChunks { .. } => {
                panic!("expected inline source")
            }
        }
    }

    #[test]
    fn process_descriptor_accepts_relative_working_directory() {
        let descriptor = descriptor(vec!["true".to_string()], Some("tools".to_string()));

        descriptor
            .validate(&example_product_word_ids())
            .expect("relative cwd remains beneath the private job root");
    }

    #[test]
    fn process_descriptor_rejects_absolute_and_parent_working_directories() {
        for cwd in ["/tmp/outside", "../outside"] {
            let descriptor = descriptor(vec!["true".to_string()], Some(cwd.to_string()));

            assert!(matches!(
                descriptor.validate(&example_product_word_ids()),
                Err(ExecutionError::InvalidDescriptor { field, .. }) if field == "cwd"
            ));
        }
    }

    #[test]
    fn process_descriptor_rejects_unsorted_or_duplicate_capture_fds() {
        for capture_fds in [vec![2, 1], vec![1, 1]] {
            let mut descriptor = descriptor(vec!["true".to_string()], None);
            descriptor.capture_fds = capture_fds;
            assert!(matches!(
                descriptor.validate(&example_product_word_ids()),
                Err(ExecutionError::InvalidDescriptor { field, .. }) if field == "capture_fds"
            ));
        }
    }

    #[test]
    fn process_descriptor_strict_decoder_rejects_retired_fields() {
        let mut value = serde_json::to_value(descriptor(vec!["true".to_string()], None))
            .expect("serialize request");
        value
            .as_object_mut()
            .expect("request object")
            .insert("sandbox_profile".into(), json!("relaxed"));
        let bytes = serde_json::to_vec(&value).expect("serialize hostile request");
        assert!(decode_process_descriptor(&example_product_word_ids(), &bytes).is_err());
    }

    #[test]
    fn external_provider_receipt_is_tagged_checksum_bound_and_never_carries_native_evidence() {
        let request = golden_request();
        let provider = issue_external_provider_admission(
            &example_product_word_ids(),
            ProcessExternalProviderAdmission {
                provider_id: "provider-connection".into(),
                provider_protocol_revision: "revision-7".into(),
                provider_connection_revision: "connection-11".into(),
                attestation: ProcessExternalProviderAttestation {
                    attestation_id: "attestation-3".into(),
                    issuer: "decoder-9".into(),
                    provider_evidence_content_hash: format!("1f:{}", "44".repeat(32)),
                    statement_content_hash: String::new(),
                    capabilities: ProcessExecutionCapabilitySet {
                        persistent_session: true,
                        descendant_lifecycle: true,
                        exclusive_private_volume_lease: true,
                        correlated_output: true,
                        cleanup: true,
                        zero_unowned_descendants: true,
                    },
                },
            },
        )
        .expect("decoder-issued provider admission");
        let mut evidence_tampered = provider.clone();
        evidence_tampered.attestation.provider_evidence_content_hash =
            format!("1f:{}", "45".repeat(32));
        let mut capabilities_tampered = provider.clone();
        capabilities_tampered.attestation.capabilities.cleanup = false;
        for tampered in [evidence_tampered, capabilities_tampered] {
            assert!(matches!(
                tampered.validate(&example_product_word_ids(), "provider"),
                Err(ExecutionError::InvalidDescriptor { field, .. })
                    if field == "provider.attestation.statement_content_hash"
            ));
        }
        let admission =
            AdmittedProcessDescriptor::ExternalProvider(AdmittedExternalProcessDescriptor {
                request_content_hash: content_hash(
                    &encode_process_descriptor(&example_product_word_ids(), &request).unwrap(),
                ),
                provider: provider.clone(),
                execution: ProcessExternalProviderExecutionIdentity {
                    provider_execution_id: "execution-5".into(),
                    correlation_id: "correlation-6".into(),
                    requested_capabilities: provider.attestation.capabilities.clone(),
                    persistent_session_id: Some("session-8".into()),
                    private_volume_lease_id: Some("lease-4".into()),
                },
                timeout_ms: request.timeout_ms,
                termination_grace_ms: request.termination_grace_ms,
                expected_termination: request.expected_termination.clone(),
                outputs: Vec::new(),
                capture_fds: Vec::new(),
            });
        let mut receipt = ProcessContainmentReceipt::ExternalProvider(Box::new(
            ExternalProviderProcessContainmentReceipt {
                schema: example_product_word_ids().containment_receipt_schema().into(),
                request_content_hash: admission.request_content_hash().into(),
                admitted_descriptor_content_hash: content_hash(
                    &encode_admitted_process_descriptor(&example_product_word_ids(), &admission).unwrap(),
                ),
                provider,
                lifecycle: ProcessExternalProviderLifecycleEvidence {
                    provider_execution_id: "execution-5".into(),
                    correlation_id: "correlation-6".into(),
                    provider_receipt_content_hash: format!("1f:{}", "55".repeat(32)),
                    cleanup_attestation_content_hash: format!("1f:{}", "66".repeat(32)),
                    zero_unowned_descendants_attestation_content_hash: format!(
                        "1f:{}",
                        "77".repeat(32)
                    ),
                    persistent_session_id: Some("session-8".into()),
                    private_volume_lease_id: Some("lease-4".into()),
                },
                termination: ProcessTermination::Exited { code: 0 },
                captured_pipes_eof: true,
                captured_fds: Vec::new(),
                declared_output_integrity: BTreeMap::new(),
                checksum_canonicalization: PROCESS_CONTAINMENT_RECEIPT_CHECKSUM_CANONICALIZATION
                    .into(),
                checksum: String::new(),
            },
        ));
        seal_process_containment_receipt(&example_product_word_ids(), &mut receipt).unwrap();
        let bytes = serde_json::to_value(&receipt).unwrap();
        assert_eq!(bytes["kind"], "external_provider");
        assert!(bytes.get("direct_child_pid").is_none());
        assert!(bytes.get("admitted_executable").is_none());
        verify_process_containment_receipt(&example_product_word_ids(), &receipt).unwrap();

        let ProcessContainmentReceipt::ExternalProvider(external) = &mut receipt else {
            panic!("external receipt must remain externally tagged")
        };
        external.lifecycle.cleanup_attestation_content_hash = format!("1f:{}", "88".repeat(32));
        assert!(verify_process_containment_receipt(&example_product_word_ids(), &receipt).is_err());
    }

    #[test]
    fn process_termination_accessors_preserve_exit_and_signal_domains() {
        let exited = ProcessTermination::Exited { code: 17 };
        assert_eq!(exited.exited_code(), Some(17));
        assert_eq!(exited.signal(), None);

        let signaled = ProcessTermination::Signaled { signal: 9 };
        assert_eq!(signaled.exited_code(), None);
        assert_eq!(signaled.signal(), Some(9));
    }
}
