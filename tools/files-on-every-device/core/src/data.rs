//! The core's DATA (contract.json), read once, and the setup a shell hands in.
//!
//! Nothing here is a number or a name the core chose: contract.json holds the contract's operation and field names,
//! the problem map and the folder's fixed names; `Setup` holds what only the host knows (this device, the account's
//! computers in order, the contract's bounds read from its own settings).

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::errors::Problem;

/// How one contract operation travels.
#[derive(Deserialize, Debug)]
pub struct Call {
    pub method: String,
    pub path: String,
    pub content_type: String,
}

/// One row of the problem map.
#[derive(Deserialize, Debug)]
pub struct ProblemRow {
    pub status: u16,
    #[serde(default)]
    pub failure_code: Option<String>,
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
    pub operations: BTreeMap<String, Option<String>>,
    pub fields: BTreeMap<String, String>,
    pub problems: Vec<ProblemRow>,
    pub answered_status: u16,
    pub identity: Identity,
    pub upload_id_hex_chars: usize,
    pub bounds: BTreeMap<String, String>,
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

/// The contract's own numbers, read by the host from the contract's settings (contract.json `bounds` names where).
#[derive(Deserialize, Debug, Clone, Copy)]
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
    pub bounds: Bounds,
    /// The folder this core shows.
    pub root: Root,
}
