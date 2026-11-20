//! The core's DATA (contract.json), read once, and the setup a shell hands in.
//!
//! Nothing here is a number or a name the core chose: contract.json holds the door's message, the contract's operation
//! and field names, the refusal map and the folder's fixed names; `Setup` holds the one thing only the host knows (where
//! its engine door is); `Bounds` are the contract's own answer to its `bounds` call.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::Problem;

/// How one call travels: the door's message, with each slot filled.
#[derive(Deserialize, Debug)]
pub struct Call {
    pub method: String,
    pub path: String,
    pub content_type: String,
    /// What the shell sends as Accept: every answer the core reads, a raw span's bytes among them.
    pub accept: String,
    pub body: Value,
    pub slots: Slots,
    /// How a call that carries bytes (an upload's piece) travels: the bytes are the request's body, sent as `content_type`,
    /// and the door's message rides beside them in the header `header`, base64url (the engine's src/mcp/upload.rs; the
    /// door spools the body and hands it to the files session as the piece's `content_file`). Absent: the bytes go inside
    /// the message as base64 (`piece_content`), which a session reading one bounded message a line can take only when small.
    #[serde(default)]
    pub raw_upload: Option<RawUpload>,
}

/// The headers of a call whose body is its bytes (`Call::raw_upload`).
#[derive(Deserialize, Debug)]
pub struct RawUpload {
    pub content_type: String,
    pub header: String,
}

/// The values of `Call::body` (and of a target's `input`) the core fills.
#[derive(Deserialize, Debug)]
pub struct Slots {
    pub request: String,
    pub request_key: String,
    pub method: String,
    pub call_input: String,
    pub op: String,
    pub input: String,
}

/// What a call reaches at the door: the method and the input it takes, with `op` and `input` slots, and the envelope of
/// its own reply. A call names its method, never an address: the door finds the method's owner (door plan D1.3).
#[derive(Deserialize, Debug)]
pub struct Target {
    pub method: String,
    pub input: Value,
    /// Where the result inside the door's is, when the target's own reply wraps it.
    #[serde(default)]
    pub answer: Option<AnswerAt>,
}

/// The call that names this computer, and the fields of its answer.
#[derive(Deserialize, Debug)]
pub struct ThisComputerCall {
    #[serde(flatten)]
    pub target: Target,
    pub id: String,
    pub label: String,
}

/// Where in the door's answer each part is (JSON pointers).
#[derive(Deserialize, Debug)]
pub struct AnswerAt {
    pub result: String,
    pub refused: String,
    pub protocol_refusal: String,
}

/// One row of the refusal map: a refusal's code, and its outcome when the row names one.
#[derive(Deserialize, Debug)]
pub struct RefusalRow {
    pub code: String,
    #[serde(default)]
    pub outcome: Option<String>,
    pub problem: Problem,
}

/// One row of the JSON-RPC error map.
#[derive(Deserialize, Debug)]
pub struct ProtocolRefusalRow {
    pub code: i64,
    pub problem: Problem,
}

#[derive(Deserialize, Debug)]
pub struct Identity {
    pub prefix: String,
}

/// The one place a core shows: the whole of the person's files, its id, the name shown and the contract folder.
#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Root {
    pub id: String,
    pub name: String,
    pub folder: String,
}

#[derive(Deserialize, Debug)]
pub struct ItemKinds {
    pub file: String,
    pub folder: String,
}

/// contract.json.
#[derive(Deserialize, Debug)]
pub struct Contract {
    pub call: Call,
    /// The files session every contract operation runs on.
    pub files: Target,
    /// The call that names this computer; null for a door that offers none. With no computer named, pins and
    /// conflict copies, which name one, are not offered.
    pub this_computer: Option<ThisComputerCall>,
    pub answer: AnswerAt,
    pub operations: BTreeMap<String, Option<String>>,
    pub fields: BTreeMap<String, String>,
    pub refusals: Vec<RefusalRow>,
    pub protocol_refusals: Vec<ProtocolRefusalRow>,
    pub identity: Identity,
    pub upload_id_hex_chars: usize,
    pub root: Root,
    pub trash_id: String,
    pub item_kinds: ItemKinds,
    pub conflict_name: String,
    pub conflict_name_again: String,
    pub conflict_first_again: u64,
    pub absent_version: i64,
    /// The sentence a person reads for each problem, by its name.
    pub problem_words: BTreeMap<String, String>,
    pub tail: Tail,
    pub raw: Raw,
}

/// How a raw span answer is told apart and checked (contract.json `raw`): its content type and the header names of the
/// file's size, the span's offset and the content identity it was read from.
#[derive(Deserialize, Debug)]
pub struct Raw {
    pub content_type: String,
    pub total: String,
    pub offset: String,
    pub identity: String,
}

/// The end of a file read with its first bytes (contract.json `tail`).
#[derive(Deserialize, Debug)]
pub struct Tail {
    pub bytes: u64,
}

impl Contract {
    /// The shipped contract.json.
    pub fn shipped() -> &'static Contract {
        static SHIPPED: OnceLock<Contract> = OnceLock::new();
        SHIPPED.get_or_init(|| serde_json::from_str(include_str!("../contract.json")).expect("contract.json is the core's DATA"))
    }

    /// The contract's name of a field the core reads or writes. A name contract.json does not hold is a defect of the
    /// core itself, found by the tests that walk every job.
    pub fn field(&self, job: &str) -> &str {
        self.fields.get(job).map(String::as_str).unwrap_or_else(|| panic!("contract.json has no field for {job}"))
    }

    /// The sentence a person reads for a problem. Every problem has one: tests/contract.rs holds them to the set.
    pub fn words(&self, problem: Problem) -> String {
        let name = serde_json::to_value(problem).ok().and_then(|name| name.as_str().map(str::to_owned)).unwrap_or_default();
        self.problem_words.get(&name).cloned().unwrap_or_else(|| panic!("contract.json has no words for {name}"))
    }

    /// The contract operation that does a job, or None when the contract does not offer it yet.
    pub fn operation(&self, job: &str) -> Option<&str> {
        self.operations.get(job).and_then(|operation| operation.as_deref())
    }
}

/// The contract's own numbers, its answer to the `bounds` call.
#[derive(Debug, Clone, Copy)]
pub struct Bounds {
    /// The most bytes one span read answers.
    pub span_most_bytes: u64,
    /// The most bytes one upload piece carries.
    pub piece_most_bytes: u64,
    /// The longest one request may wait for progress before the contract itself gives up.
    pub idle_ms: u64,
}

/// What a shell hands the core once: where this computer's engine door is. Everything else comes through it.
#[derive(Deserialize, Debug, Clone)]
pub struct Setup {
    /// The door's origin; the core joins contract.json `call.path` to it and the shell sends there (a local socket
    /// included: the origin is the shell's own word for it).
    pub origin: String,
}
