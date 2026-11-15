//! Custody for source-bearing `workspace:write` replies. The source is the
//! workspace store itself (`crate::workspace_store`, a record store resource), never a
//! fabricated EEAF donor record; its scope stamp is the source epoch. Callers
//! must supply the SAME selected command transaction and run its current
//! account/browser/source checks around capture and verify.
//! This module mints no output permit and does not disclose a result.
use super::workspace_write::{self as contract, Action, ResultDependence};
use crate::{
    ecma_json::{self, Object, Value},
    storage::sqlite::Access,
    workspace_store::Workspace,
};
use content_crypto::advanced::blake3;
use crate::storage::sqlite::Connection;

const VERSION: &str = "workspace-output-source-v2";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    Source(crate::refusal_cause::Cause),
    Withdrawn(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause.clone(),
            Self::Bounds(cause) => cause.clone(),
            Self::Source(cause) => cause.clone(),
            Self::Withdrawn(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Error);

pub type Result<T> = std::result::Result<T, Error>;

/// Stored *inside* the existing sealed command result beside its exact public
/// result. No plaintext source value, key, alternate result or second store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Witness {
    kind: OutputKind,
    epoch: Option<i64>,
    result_digest: String,
}
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum OutputKind {
    WriteCount,
    WriteConflicts,
    Resolve,
}
impl OutputKind {
    fn name(self) -> &'static str {
        match self {
            Self::WriteCount => "write-count",
            Self::WriteConflicts => "write-conflicts",
            Self::Resolve => "resolve",
        }
    }
    fn parse(value: &str) -> Result<Self> {
        match value {
            "write-count" => Ok(Self::WriteCount),
            "write-conflicts" => Ok(Self::WriteConflicts),
            "resolve" => Ok(Self::Resolve),
            _ => Err(crate::cause!(Error::Invalid)),
        }
    }
}

/// Source proof for one final disclosure on the retained selected connection.
/// It is not an account/policy permit: the native owner must check those again
/// around `assert_current`. No bool or caller snapshot can construct it.
pub struct FinalOutputPermit {
    handle: usize,
    account: String,
    witness: Witness,
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    if let Value::Object(value) = value {
        value.get(&key.into())
    } else {
        None
    }
}
fn text(value: &Value) -> Result<String> {
    let Value::String(value) = value else {
        return Err(crate::cause!(Error::Invalid));
    };
    value.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))
}
fn digest(value: &Value) -> Result<String> {
    let bytes = ecma_json::stringify(value, Default::default()).map_err(|error| Error::Bounds(error.cause()))?;
    Ok(format!("1f:{}", blake3::hash(bytes.as_bytes()).to_hex()))
}
fn row(workspace: &Workspace<'_>, label: &str) -> Result<Option<Value>> {
    let (_, held) = workspace.get(label).map_err(|error| Error::Source(error.cause()))?;
    Ok(held.map(|(_, value)| value))
}
fn open<'db>(db: &'db Connection, account: &str) -> Result<Workspace<'db>> {
    Workspace::lend(db, account, Access::Read).map_err(|error| Error::Source(error.cause()))
}
/// The source epoch: the workspace store's scope stamp. Every change, delete
/// included, moves it forward and it never moves back, so a delete/recreate
/// with an identical value cannot revive an erased reply.
fn epoch(workspace: &Workspace<'_>) -> Result<i64> {
    workspace.stamp().map_err(|error| Error::Source(error.cause()))
}

fn kind_of(action: &Action, result: &Value) -> Result<OutputKind> {
    if !contract::result_matches(action, result) {
        return Err(crate::cause!(Error::Invalid));
    }
    Ok(match action {
        Action::Writes { .. } if field(result, "conflicts").is_none() => OutputKind::WriteCount,
        Action::Writes { .. } => OutputKind::WriteConflicts,
        Action::Resolve { .. } => OutputKind::Resolve,
    })
}
fn coherent(workspace: &Workspace<'_>, kind: OutputKind, result: &Value) -> Result<()> {
    match kind {
        OutputKind::WriteCount => {
            let Some(Value::Number(n)) = field(result, "written") else {
                return Err(crate::cause!(Error::Invalid));
            };
            if !n.is_finite()
                || n.fract() != 0.0
                || *n < 1.0
                || *n > 64.0
                || field(result, "conflicts").is_some()
            {
                return Err(crate::cause!(Error::Invalid));
            }
        }
        OutputKind::WriteConflicts => {
            if field(result, "written") != Some(&Value::Number(0.0)) {
                return Err(crate::cause!(Error::Invalid));
            }
            let Some(Value::Array(conflicts)) = field(result, "conflicts") else {
                return Err(crate::cause!(Error::Invalid));
            };
            if conflicts.is_empty() {
                return Err(crate::cause!(Error::Invalid));
            }
            for item in conflicts {
                let address = text(field(item, "address").ok_or(crate::cause!(Error::Invalid))?)?;
                let current = field(item, "current").ok_or(crate::cause!(Error::Invalid))?;
                if !matches!(field(current, "found"), Some(Value::Bool(_))) {
                    return Err(crate::cause!(Error::Invalid));
                }
                let found = field(current, "found") == Some(&Value::Bool(true));
                let held = row(workspace, &address)?;
                if found {
                    let source = held.ok_or(crate::cause!(Error::Withdrawn))?;
                    let claim = text(field(current, "identity").ok_or(crate::cause!(Error::Invalid))?)?;
                    let actual =
                        contract::workspace_value_identity(&source).map_err(|error| Error::Source(error.cause()))?;
                    if claim != actual || field(current, "value") != Some(&source) {
                        return Err(crate::cause!(Error::Withdrawn));
                    }
                } else if held.is_some()
                    || field(current, "identity") != Some(&Value::String("missing".into()))
                    || field(current, "value").is_some()
                {
                    return Err(crate::cause!(Error::Withdrawn));
                }
                if let Some(id) = field(item, "id") {
                    let id = text(id)?;
                    if row(workspace, &super::workspace_write_sql::conflict_label(&id))?.is_none() {
                        return Err(crate::cause!(Error::Withdrawn));
                    }
                }
            }
        }
        OutputKind::Resolve => match field(result, "resolved") {
            Some(Value::Bool(true)) => {
                let address = text(field(result, "address").ok_or(crate::cause!(Error::Invalid))?)?;
                let kept = text(field(result, "kept").ok_or(crate::cause!(Error::Invalid))?)?;
                let source = row(workspace, &address)?;
                if kept == "missing" {
                    if source.is_some() {
                        return Err(crate::cause!(Error::Withdrawn));
                    }
                } else if source
                    .as_ref()
                    .and_then(|v| contract::workspace_value_identity(v).ok())
                    .as_deref()
                    != Some(kept.as_str())
                {
                    return Err(crate::cause!(Error::Withdrawn));
                }
            }
            Some(Value::Bool(false)) => {
                let id = text(field(result, "conflict_id").ok_or(crate::cause!(Error::Invalid))?)?;
                if row(workspace, &super::workspace_write_sql::conflict_label(&id))?.is_none() {
                    return Err(crate::cause!(Error::Withdrawn));
                }
            }
            _ => return Err(crate::cause!(Error::Invalid)),
        },
    }
    Ok(())
}

/// Capture after the effect, before sealing, while its IMMEDIATE lock and
/// current source witness remain held. The caller stores `witness.value()`
/// inside the authenticated sealed result envelope, never in command context.
pub fn capture(db: &Connection, account: &str, action: &Action, result: &Value) -> Result<Witness> {
    let kind = kind_of(action, result)?;
    let workspace = open(db, account)?;
    coherent(&workspace, kind, result)?;
    let dependence = contract::result_dependence(action, result).map_err(|error| Error::Invalid(error.cause()))?;
    let epoch = if dependence == ResultDependence::WorkspaceSource {
        Some(epoch(&workspace)?)
    } else {
        None
    };
    Ok(Witness {
        kind,
        epoch,
        result_digest: digest(result)?,
    })
}

/// Verify after opening the original sealed result and again at final output.
/// Any intervening workspace write/delete, including an ABA restore, withholds
/// source-bearing output; count-only replies retain their original receipt.
pub fn verify(db: &Connection, account: &str, action: &Action, result: &Value, witness: &Witness) -> Result<()> {
    if kind_of(action, result)? != witness.kind {
        return Err(crate::cause!(Error::Withdrawn));
    }
    verify_saved(db, account, result, witness)
}

/// Retried committed output is checked without rereading or persisting the
/// original private input. The sealed witness names its original result kind.
pub fn verify_saved(db: &Connection, account: &str, result: &Value, witness: &Witness) -> Result<()> {
    if witness.result_digest != digest(result)? {
        return Err(crate::cause!(Error::Withdrawn));
    }
    let workspace = open(db, account)?;
    match witness.kind {
        OutputKind::WriteCount if witness.epoch.is_none() => coherent(&workspace, witness.kind, result),
        OutputKind::WriteConflicts | OutputKind::Resolve => {
            let before = witness.epoch.ok_or(crate::cause!(Error::Withdrawn))?;
            if epoch(&workspace)? != before {
                return Err(crate::cause!(Error::Withdrawn));
            }
            coherent(&workspace, witness.kind, result)?;
            if epoch(&workspace)? != before {
                return Err(crate::cause!(Error::Withdrawn));
            }
            Ok(())
        }
        _ => Err(crate::cause!(Error::Withdrawn)),
    }
}

/// Committed retry needs no original private input. Its authenticated sealed
/// witness supplies the result kind and captured source epoch.
pub fn final_output_permit_saved(
    db: &Connection,
    account: &str,
    result: &Value,
    witness: &Witness,
) -> Result<FinalOutputPermit> {
    verify_saved(db, account, result, witness)?;
    Ok(FinalOutputPermit {
        handle: unsafe { db.handle() } as usize,
        account: account.to_owned(),
        witness: witness.clone(),
    })
}

impl FinalOutputPermit {
    pub fn assert_current(&self, db: &Connection, result: &Value) -> Result<()> {
        if unsafe { db.handle() } as usize != self.handle {
            return Err(crate::cause!(Error::Withdrawn));
        }
        verify_saved(db, &self.account, result, &self.witness)
    }
}

impl Witness {
    pub fn value(&self) -> Value {
        let mut fields = Object::new();
        fields.insert("version".into(), Value::String(VERSION.into()));
        fields.insert("kind".into(), Value::String(self.kind.name().into()));
        fields.insert(
            "epoch".into(),
            // A stamp exceeds 2^53: kept as its decimal text, never a float.
            self.epoch.map_or(Value::Null, |n| Value::String(n.to_string().as_str().into())),
        );
        fields.insert(
            "result_digest".into(),
            Value::String(self.result_digest.as_str().into()),
        );
        Value::Object(fields)
    }
    pub fn from_value(value: &Value) -> Result<Self> {
        if field(value, "version") != Some(&Value::String(VERSION.into())) {
            return Err(crate::cause!(Error::Invalid));
        }
        let kind = OutputKind::parse(&text(field(value, "kind").ok_or(crate::cause!(Error::Invalid))?)?)?;
        let epoch = match field(value, "epoch") {
            Some(Value::Null) => None,
            Some(stamp @ Value::String(_)) => Some(
                text(stamp)?
                    .parse::<i64>()
                    .ok()
                    .filter(|stamp| *stamp >= 0)
                    .ok_or(crate::cause!(Error::Invalid))?,
            ),
            _ => return Err(crate::cause!(Error::Invalid)),
        };
        let result_digest = text(field(value, "result_digest").ok_or(crate::cause!(Error::Invalid))?)?;
        if !result_digest.starts_with("1f:")
            || result_digest.len() != 67
            || !result_digest[3..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(crate::cause!(Error::Invalid));
        }
        Ok(Self {
            kind,
            epoch,
            result_digest,
        })
    }
}
