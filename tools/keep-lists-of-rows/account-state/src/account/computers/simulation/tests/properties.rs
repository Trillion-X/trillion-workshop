//! Property rows: each row (`src/account/computers/simulation/properties.json`) names one predicate kind. There is
//! one check per kind; a row only chooses its kind, its id and, where the kind needs one, its bound.

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Kind {
    /// Holds in every state of the run.
    Always,
    /// Reached within `bound` ms of the start of the wait.
    Liveness,
    /// The measured value stays at or under `bound`.
    Bounded,
    /// The stored shape decodes with the current build.
    Compat,
    /// Two values the run produced are equal.
    Equality,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Property {
    pub id: String,
    pub kind: Kind,
    #[serde(default)]
    pub bound: Option<i64>,
}

/// What a scenario observed for one property. Its variant must match the property's kind.
#[derive(Debug, PartialEq, Eq)]
pub enum Evidence {
    Always(bool),
    Liveness { started_at: i64, reached_at: Option<i64> },
    Bounded(i64),
    Compat(bool),
    Equality { left: String, right: String },
}

/// `Ok` when the evidence satisfies the property. A mismatched kind and evidence is an error, never a pass.
pub fn check(property: &Property, evidence: &Evidence) -> Result<(), String> {
    let violated = |why: String| Err(format!("{}: {why}", property.id));
    match (property.kind, evidence) {
        (Kind::Always, Evidence::Always(true)) => Ok(()),
        (Kind::Always, Evidence::Always(false)) => violated("the state was not held".into()),
        (Kind::Liveness, Evidence::Liveness { started_at, reached_at }) => {
            let bound = property.bound.ok_or_else(|| format!("{}: liveness needs a bound", property.id))?;
            match reached_at {
                Some(at) if at - started_at <= bound => Ok(()),
                Some(at) => violated(format!("reached after {} ms, bound {bound} ms", at - started_at)),
                None => violated("never reached".into()),
            }
        }
        (Kind::Bounded, Evidence::Bounded(value)) => {
            let bound = property.bound.ok_or_else(|| format!("{}: bounded needs a bound", property.id))?;
            if *value <= bound {
                Ok(())
            } else {
                violated(format!("{value} is over the bound {bound}"))
            }
        }
        (Kind::Compat, Evidence::Compat(true)) => Ok(()),
        (Kind::Compat, Evidence::Compat(false)) => violated("a stored shape does not decode".into()),
        (Kind::Equality, Evidence::Equality { left, right }) => {
            if left == right {
                Ok(())
            } else {
                violated(format!("{left} != {right}"))
            }
        }
        (kind, evidence) => violated(format!("{kind:?} property given {evidence:?}")),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PropertyRows {
    format: String,
    about: String,
    rows: Vec<Property>,
}

pub fn load(json: &str) -> Vec<Property> {
    let rows: PropertyRows = serde_json::from_str(json).expect("property rows parse");
    assert_eq!(rows.format, "deterministic-world-properties/1", "unknown property row format");
    assert!(!rows.about.is_empty(), "property rows name their purpose");
    rows.rows
}
