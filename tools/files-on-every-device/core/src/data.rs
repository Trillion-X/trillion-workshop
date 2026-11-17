//! The core's DATA (contract.json), read once, and the setup a shell hands in.
//!
//! Nothing here is a number or a name the core chose: contract.json holds the door's message, the contract's operation
//! and field names, the refusal map and the folder's fixed names; `Setup` holds what only the host knows (this device,
//! the account's computers in order, the folder shown); `Bounds` are the contract's own answer to its `bounds` call.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::Problem;

/// How one contract operation travels: the door's message, with each slot filled.
#[derive(Deserialize, Debug)]
pub struct Call {
    pub method: String,
    pub path: String,
    pub content_type: String,
    pub body: Value,
    pub slots: Slots,
}

/// The values of `Call::body` the core fills.
#[derive(Deserialize, Debug)]
pub struct Slots {
    pub request: String,
    pub request_key: String,
    pub op: String,
    pub input: String,
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

/// The folder one core shows: the OS's root id for it (Apple's domain id), the name shown, and the contract folder.
#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Root {
    pub id: String,
    pub name: String,
    pub folder: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct FactField {
    pub id: String,
    pub kind: String,
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
    pub answer: AnswerAt,
    pub operations: BTreeMap<String, Option<String>>,
    pub fields: BTreeMap<String, String>,
    pub refusals: Vec<RefusalRow>,
    pub protocol_refusals: Vec<ProtocolRefusalRow>,
    pub identity: Identity,
    pub upload_id_hex_chars: usize,
    pub trash_id: String,
    pub item_facts: Vec<FactField>,
    pub item_kinds: ItemKinds,
    pub conflict_name: String,
    pub conflict_name_again: String,
    pub conflict_first_again: u64,
    pub absent_version: i64,
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

    /// The contract operation that does a job, or None when the contract does not offer it yet.
    pub fn operation(&self, job: &str) -> Option<&str> {
        self.operations.get(job).and_then(|operation| operation.as_deref())
    }
}

/// One computer of the account, in the order the account lists them.
#[derive(Deserialize, Debug, Clone)]
pub struct Computer {
    pub origin: String,
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

/// What a shell hands the core once.
#[derive(Deserialize, Debug, Clone)]
pub struct Setup {
    /// This device's id, as pin rule rows name it.
    pub device: String,
    /// This device's name as the person reads it, used in a conflict copy's name.
    pub device_label: String,
    pub computers: Vec<Computer>,
    /// The folder this core shows.
    pub root: Root,
}
