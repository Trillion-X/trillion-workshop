//! Original decision-store canonical JSON and content identity.
//! Reuses the ECMAScript value model/serializer and the declared BLAKE3 owner.
//! The caller supplies its actual current locale comparator; this computation
//! neither authenticates that supply nor creates source or disclosure rights.
use crate::ecma_json::{self, JsString, Object, Value};
use content_crypto::advanced::blake3;
use std::{cmp::Ordering, fmt};
use zeroize::Zeroizing;

const MAX_COMPARISONS: usize = 32 * ecma_json::HARD_NODES;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub json: ecma_json::Limits,
    pub comparisons: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            json: Default::default(),
            comparisons: 1_000_000,
        }
    }
}
#[derive(Clone, Debug)]
pub enum Error {
    InvalidLimits(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    Comparator(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::InvalidLimits(cause) => cause,
            Self::Bounds(cause) => cause,
            Self::Comparator(cause) => cause,
        }
    }
}
crate::impl_caused!(Error);

// Equality keeps the domain classification; source identity is compared explicitly via cause().
impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidLimits(_) => "record canonical limits refused",
            Self::Bounds(_) => "record canonical computation exceeds bounds",
            Self::Comparator(_) => "record canonical locale unavailable",
        })
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// Fallible stable merge sort of references, preserving original enumeration
/// when the actual locale says two distinct keys compare equal.
fn ordered<'a, F, E>(
    input: &[(&'a JsString, &'a Value)],
    compare: &mut F,
    comparisons: &mut usize,
    maximum: usize,
) -> Result<Vec<(&'a JsString, &'a Value)>, Error>
where
    F: FnMut(&JsString, &JsString) -> Result<Ordering, E>,
    E: crate::refusal_cause::Caused,
{
    if input.len() < 2 {
        return Ok(input.to_vec());
    }
    let middle = input.len() / 2;
    let left = ordered(&input[..middle], compare, comparisons, maximum)?;
    let right = ordered(&input[middle..], compare, comparisons, maximum)?;
    let mut out = Vec::with_capacity(input.len());
    let (mut a, mut b) = (0, 0);
    while a < left.len() && b < right.len() {
        *comparisons = comparisons.checked_add(1).ok_or(crate::cause!(Error::Bounds))?;
        if *comparisons > maximum {
            return Err(crate::cause!(Error::Bounds));
        }
        let order = compare(left[a].0, right[b].0).map_err(|error| crate::carry_cause!(Error::Comparator, error))?;
        if order != Ordering::Greater {
            out.push(left[a]);
            a += 1;
        } else {
            out.push(right[b]);
            b += 1;
        }
    }
    out.extend_from_slice(&left[a..]);
    out.extend_from_slice(&right[b..]);
    Ok(out)
}

fn reorder<F, E>(
    value: &Value,
    compare: &mut F,
    count: &mut usize,
    maximum: usize,
) -> Result<Value, Error>
where
    F: FnMut(&JsString, &JsString) -> Result<Ordering, E>,
    E: crate::refusal_cause::Caused,
{
    Ok(match value {
        Value::Object(object) => {
            // Exactly Object.entries before stable localeCompare sorting.
            let entries = object.property_entries();
            let mut next = Object::new();
            for (key, value) in ordered(&entries, compare, count, maximum)? {
                next.insert(key.clone(), reorder(value, compare, count, maximum)?);
            }
            // The existing serializer will enumerate integer keys numerically,
            // exactly as Object.fromEntries followed by JSON.stringify does.
            Value::Object(next)
        }
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| reorder(value, compare, count, maximum))
                .collect::<Result<_, _>>()?,
        ),
        other => other.clone(),
    })
}

/// Port of decision-store.mjs::canonical for JSON-origin values. Sorting has
/// no bytewise/default-locale fallback. A caller must use the selected original
/// locale and check that source before and after this synchronous computation.
pub fn canonical<F, E>(value: &Value, limits: Limits, compare: &mut F) -> Result<String, Error>
where
    F: FnMut(&JsString, &JsString) -> Result<Ordering, E>,
    E: crate::refusal_cause::Caused,
{
    limits.json.validate().map_err(|error| Error::InvalidLimits(error.cause()))?;
    if limits.comparisons == 0 || limits.comparisons > MAX_COMPARISONS {
        return Err(crate::cause!(Error::InvalidLimits));
    }
    // Use the existing owner to validate ALL node/depth/string/output limits
    // before reference sorting or cloning. Ordering changes no encoded length.
    let measured =
        Zeroizing::new(ecma_json::stringify(value, limits.json).map_err(|error| Error::Bounds(error.cause()))?);
    if measured.len() > limits.json.input_bytes {
        return Err(crate::cause!(Error::Bounds));
    }
    drop(measured);
    let ordered = reorder(value, compare, &mut 0, limits.comparisons)?;
    ecma_json::stringify(&ordered, limits.json).map_err(|error| Error::Bounds(error.cause()))
}

/// Existing original content grammar, not a new hash/identity algorithm.
pub fn identity<F, E>(value: &Value, limits: Limits, compare: &mut F) -> Result<String, Error>
where
    F: FnMut(&JsString, &JsString) -> Result<Ordering, E>,
    E: crate::refusal_cause::Caused,
{
    let text = Zeroizing::new(canonical(value, limits, compare)?);
    Ok(format!("1f:{}", blake3::hash(text.as_bytes()).to_hex()))
}

#[cfg(test)]
mod refusal_cause_tests {
    use super::*;

    #[test]
    fn canonical_validation_retains_the_codec_condition_that_refused_it() {
        let mut json = ecma_json::Limits::default();
        json.input_bytes = ecma_json::HARD_BYTES + 1;
        let source = json.validate().unwrap_err();
        let result = canonical(&Value::Null, Limits { json, comparisons: 1 }, &mut |_: &JsString, _: &JsString| Ok::<_, ()>(Ordering::Equal));
        let failure = result.unwrap_err();
        assert!(matches!(failure, Error::InvalidLimits(_)));
        assert_eq!(failure.cause(), source.cause());
    }
}
