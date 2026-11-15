// Purpose: consume one exact original logical record through the Rust suppliers.
// Invariants: private bounded stdin; independent account/receipt/SQLite pins;
// no broad record scan, new account, raw connection, source write or provider.
// Security: stdout contains existence/counts/value digest only; private source
// identifiers, values, sequences, stamps and erasure keys never enter output.
//! This proves a retained original stored representation only. It does not
//! resolve private/shared fields or prove the running app's current authority.
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read, Write},
    path::PathBuf,
};
use trillion_local::{
    import::{AccountIdentity, FilePin, NativeCatalog, ReadLimits},
    legacy_kept::{LegacyKept, Limits},
    legacy_records::{Bounds, LegacyRecords, StoredRecord},
};
use zeroize::Zeroizing;
const MAX_INPUT: usize = 128 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pin {
    bytes: u64,
    blake3: String,
}
impl From<Pin> for FilePin {
    fn from(p: Pin) -> Self {
        Self {
            bytes: p.bytes,
            blake3: p.blake3,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Account {
    user_id: String,
    owner_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Object {
    binding: String,
    original_id: String,
    sqlite: Pin,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: String,
    state: PathBuf,
    receipt: Pin,
    account: Account,
    object: Object,
    record_id: String,
}
#[derive(Serialize)]
struct Summary {
    present: bool,
    record_count: u8,
    distinct_record_types: u8,
    value_json_blake3: Option<String>,
}
fn summarize(record: Option<&StoredRecord>) -> Summary {
    Summary {
        present: record.is_some(),
        record_count: u8::from(record.is_some()),
        distinct_record_types: u8::from(record.is_some()),
        value_json_blake3: record
            .map(|r| blake3::hash(r.value_json.as_bytes()).to_hex().to_string()),
    }
}
fn read_request(input: impl Read) -> Result<Request, &'static str> {
    let mut bytes = Zeroizing::new(Vec::new());
    input
        .take((MAX_INPUT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "input")?;
    if bytes.is_empty() || bytes.len() > MAX_INPUT {
        return Err("input");
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| "input")?;
    if request.version != "trillion.inspect-legacy-record/v1" {
        return Err("input");
    }
    Ok(request)
}
fn inspect(request: Request) -> Result<Summary, String> {
    let limits = ReadLimits {
        rows: 4096,
        cell_bytes: 8 * 1024 * 1024,
        result_bytes: 16 * 1024 * 1024,
        ..ReadLimits::default()
    };
    let catalog = NativeCatalog::open(
        request.state,
        request.receipt.into(),
        AccountIdentity {
            user_id: request.account.user_id,
            owner_id: request.account.owner_id,
        },
        limits,
    )
    .map_err(|_| "catalog")?;
    let original = catalog
        .open_object(
            &request.object.binding,
            &request.object.original_id,
            request.object.sqlite.into(),
        )
        .map_err(|_| "object")?;
    let mut records =
        LegacyRecords::open(original, Bounds::default()).map_err(|_| "record-engine")?;
    let kept = LegacyKept::new(Limits::default()).map_err(|_| "point-supply")?;
    let record = records.read_stored(&request.record_id, &kept);
    // Every terminal record attempt retains the same fixed phase measurements,
    // including success or an outer bounds refusal after a completed point.
    let _ = writeln!(
        io::stderr().lock(),
        "original record timing [{}]",
        records.last_read_timing()
    );
    let record = record.map_err(|error| {
        let phase = match error {
            trillion_local::legacy_records::Error::ReplayRequired(_) => "record-replay-required",
            trillion_local::legacy_records::Error::WrongEngine(_) => "record-assembly-required",
            trillion_local::legacy_records::Error::Invalid(_) => "record-input",
            trillion_local::legacy_records::Error::Bounds(_) => "record-bounds",
            trillion_local::legacy_records::Error::Source(_) => "record-source",
            trillion_local::legacy_records::Error::Schema(_) => "record-schema",
            trillion_local::legacy_records::Error::UnsupportedEngine(_) => "record-engine-unsupported",
            trillion_local::legacy_records::Error::Corrupt(_) => "record-corrupt",
            trillion_local::legacy_records::Error::Deadline(_) => "record-deadline",
        };
        match records.last_read_diagnostic() {
            Some(diagnostic) => format!("{phase}; {diagnostic}"),
            None => phase.to_owned(),
        }
    })?;
    if let Some(record) = &record {
        // Validate through the existing ECMAScript value model without changing the
        // raw stored text over which the inspection digest is taken.
        trillion_local::ecma_json::parse(
            record.value_json.as_bytes(),
            trillion_local::ecma_json::Limits::default(),
        )
        .map_err(|_| "value-json")?;
    }
    Ok(summarize(record.as_ref()))
}
fn main() {
    let result = if std::env::args_os().count() == 1 {
        read_request(io::stdin().lock())
            .map_err(str::to_owned)
            .and_then(inspect)
    } else {
        Err("arguments".to_owned())
    };
    let result = result.and_then(|summary| {
        let mut bytes = serde_json::to_vec(&summary).map_err(|_| "output")?;
        bytes.push(b'\n');
        io::stdout()
            .lock()
            .write_all(&bytes)
            .map_err(|_| "output".to_owned())
    });
    if let Err(phase) = result {
        let _ = writeln!(
            io::stderr().lock(),
            "original record inspection refused [{phase}]"
        );
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn summary_only_exposes_exists_counts_and_exact_raw_value_digest() {
        let record = StoredRecord {
            id: "private-id-sentinel".into(),
            record_type: "private-type-sentinel".into(),
            sequence: "private-sequence-sentinel".into(),
            value_json: r#"{"private-value-sentinel":1.00}"#.into(),
            meta_json: Some("private-meta-sentinel".into()),
            protected_key_present: true,
        };
        let output = serde_json::to_string(&summarize(Some(&record))).unwrap();
        for private in [
            "private-id-sentinel",
            "private-type-sentinel",
            "private-sequence-sentinel",
            "private-value-sentinel",
            "private-meta-sentinel",
        ] {
            assert!(!output.contains(private));
        }
        assert!(output.contains(
            &blake3::hash(record.value_json.as_bytes())
                .to_hex()
                .to_string()
        ));
        let none = serde_json::to_value(summarize(None)).unwrap();
        assert_eq!(none["present"], false);
        assert_eq!(none["record_count"], 0);
        assert!(none["value_json_blake3"].is_null());
    }
    #[test]
    fn request_bounds_and_missing_schema_refuse_without_input_details() {
        assert!(read_request(&b"private-invalid-input"[..]).is_err());
        assert!(read_request(vec![b'x'; MAX_INPUT + 1].as_slice()).is_err());
        assert!(read_request(&b"{}"[..]).is_err());
    }
}
