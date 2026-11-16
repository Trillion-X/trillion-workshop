# execution-types — Canonical Execution Wire Contracts

`execution-types` owns the portable process request, host-private admitted
descriptor, exact result/receipt, canonical JSON codecs, and generic
`JobRunner` trait. It performs no I/O and starts no process.

## One-shot process boundary

| Contract | Role |
|---|---|
| `ProcessDescriptor` | Portable caller intent: runtime alias or materialized executable selector, relative `cwd`, exact timeouts/environment, file and source-tree inputs, outputs, containment intent, ordered capture FDs, and collected files. It contains no absolute executable or caller-selected native root. |
| `ProcessInputTreeMount` | Portable package/workspace tree, supplied inline as `ProcessSourceArchive` or by immutable `BlobRef`. Archive files use path segments, exact bytes, a verified multihash, and an executable bit. |
| `AdmittedProcessDescriptor` | Mandatory tagged host-private admission: `native` carries held executable/root facts; `external_provider` carries only provider protocol/connection revision, attestation, execution correlation, and capability requirements. |
| `ProcessResult` | Exact `ProcessTermination`, strictly ordered captured FDs, declared outputs, collected files, immutable publications, duration, and a checksummed containment receipt. |
| `ProcessContainmentReceipt` | Mandatory tagged evidence. `native` contains kernel facts; `external_provider` contains only checksum-bound provider attestations, lifecycle/correlation, cleanup, and zero-unowned-descendants evidence. |
| `ProcessWorkspaceExecutionBindings` | Strict serialized instructions for composing admitted environment values from literals, the owner-held workspace root, normalized workspace paths, and an exact portable environment value. The execution owner resolves them; callers never receive the root. |

`expected_termination: None` returns any exact natural exit or signal. `Some`
requires an exact match; a mismatch is `ExecutionError::UnexpectedTermination`
and no successful result escapes. Exit and signal domains never collapse into a
sentinel integer.

Captured streams are the ascending `capture_fds` DATA list (maximum 32, values
1–255). Consumers use `ProcessResult::captured_fd(fd)`; there are no `stdout`,
`stderr`, `exit_code`, or truncation fields.

## Canonical codecs and fixtures

The owner codecs are:

- `encode_process_descriptor` / `decode_process_descriptor`
- `encode_process_source_archive` / `decode_process_source_archive`
- `encode_admitted_process_descriptor` / `decode_admitted_process_descriptor`
- `encode_process_result` / `decode_process_result`
- `seal_process_containment_receipt` / `verify_process_containment_receipt`

Each takes the caller's `ProductWordIds` first. They use RFC 8785 JSON
canonicalization and strict unknown-field rejection.
Result decoding recomputes the receipt checksum and verifies captured bytes,
inline output bytes, collected-file identities, declared-output identities, and
publication receipts against the sealed evidence.

The crate's own literal golden bytes use the neutral product word `example`:

- `contracts/process-descriptor.golden.json`
- `contracts/admitted-process-descriptor.golden.json`
- `contracts/process-result.golden.json`
- `contracts/process-sequence-descriptor.golden.json`

The first three are read only by this crate's tests, whose private constants
pin their multihash code-hex identities minted by `content-crypto`. A host
keeps the fixtures for its own product word beside its own tests. Regenerate the
files with the crate's `regenerate-goldens` feature rather than editing them.

## Defaults

- `DEFAULT_PROCESS_TERMINATION_GRACE_MS = 1000`
- `DEFAULT_PROCESS_DESCENDANT_PIPE_EOF_TIMEOUT_MS = 1000`

## Product word

The host builds one `ProductWordIds` from its product word (a lowercase
ASCII letter, then lowercase ASCII letters, digits or `_`) and passes it to
every codec, validator, seal and verify call. It yields the product-word wire
identities; this crate names no product and has no default word:

| Identity | Value |
|---|---|
| Source archive format | `<word>.process-source-archive/v1` |
| Containment receipt schema | `<word>.process_containment_receipt.v1` |
| Provider capability statement schema | `<word>.process_external_provider_capability_statement.v1` |
| Sequence environment names | `<WORD>_PROCESS_SEQUENCE_REQUEST_SHA256`, `<WORD>_PROCESS_SEQUENCE_PREDECESSOR_RESULT_SHA256`, `<WORD>_PROCESS_SEQUENCE_REQUIRED_OUTPUTS_JSON` |

## Persistent sessions

`ProcessSessionDescriptor` wraps one portable `ProcessDescriptor` with
declarative session settings. It has no second cwd, environment, input,
timeout, or sandbox-profile authority. `process-engine` rejects session starts
because this runtime has no admitted interactive native authority; the former
unadmitted `portable-pty` spawn path is deleted.

## Invariants

1. Portable DATA never contains host paths, executable digests, sandbox roots,
   or ambient `PATH` assumptions.
2. Machine-specific facts exist only in `AdmittedProcessDescriptor` and its
   owner-held lifetime.
3. Native kernel evidence and external-provider evidence are disjoint tagged
   shapes. A provider receipt cannot encode native executable, path, PID,
   sandbox, vnode, or file-identity facts.
4. Canonical bytes and their hashes have one owner.
5. Unknown or retired fields fail closed at every nested wire boundary.
6. Output ceilings fail with `OutputLimit`; partial/truncated success is not a
   result state.

This crate remains library-only and has no async runtime, network client, or
process-spawn implementation.
