//! Source-owned evidence for a complete records query.
//!
//! A `QueryWitness` is captured by the source that answered the query. It binds the physical resource set and its
//! current revisions together with the installed model and schema generations. It is an in-memory value: it is not
//! serialized into an answer, derived from returned row ids, or treated as a write grant. The writer still checks the
//! current principal, grants, and exact query authority independently before it validates this witness.
//!
//! The caller must use `complete_query` around the whole logical walk, including every internal page. A truncated,
//! refused, or changing walk yields no witnessed answer. A later writer calls `validate` on its current source before
//! starting effects. The source implementation owns how it observes and checks these revisions under current rights.

use super::{Error, Result};
use serde_json::Value;

/// One exact read scope used to answer a query.
///
/// `resource` is the logical source label, `operation` names the read performed there, and `scope` is its full
/// canonical input. A caller supplies these from the admitted query; the source rechecks that each is still allowed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadScope {
    resource: String,
    operation: String,
    scope: Value,
}

impl ReadScope {
    pub(crate) fn new(resource: String, operation: String, scope: Value) -> Result<Self> {
        if resource.is_empty() || operation.is_empty() {
            return Err(crate::cause!(Error::Source));
        }
        Ok(Self {
            resource,
            operation,
            scope,
        })
    }

    pub fn resource(&self) -> &str {
        &self.resource
    }

    pub fn operation(&self) -> &str {
        &self.operation
    }

    pub fn scope(&self) -> &Value {
        &self.scope
    }
}

/// The exact logical query and the read scopes its complete answer used.
///
/// This binding travels inside the opaque witness. The write supplies its current binding too; changing the operation,
/// input, or any read scope refuses before source revision validation and before write effects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryBinding {
    operation: String,
    input: Value,
    read_scopes: Vec<ReadScope>,
}

impl QueryBinding {
    pub(crate) fn new(
        operation: String,
        input: Value,
        mut read_scopes: Vec<ReadScope>,
    ) -> Result<Self> {
        if operation.is_empty() || read_scopes.is_empty() {
            return Err(crate::cause!(Error::Source));
        }
        read_scopes.sort_by(|left, right| {
            left.resource
                .cmp(&right.resource)
                .then_with(|| left.operation.cmp(&right.operation))
                .then_with(|| left.scope.to_string().cmp(&right.scope.to_string()))
        });
        if read_scopes.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(crate::cause!(Error::Source));
        }
        Ok(Self {
            operation,
            input,
            read_scopes,
        })
    }

    pub fn operation(&self) -> &str {
        &self.operation
    }

    pub fn input(&self) -> &Value {
        &self.input
    }

    pub fn read_scopes(&self) -> &[ReadScope] {
        &self.read_scopes
    }
}

/// The revision of one physical resource participating in a logical records collection.
///
/// `generation` identifies this resource incarnation. `stamp` is its source-owned current change stamp; it is only
/// compared for equality. Resource names are sorted and checked by `QueryWitness::from_source` so a missing,
/// duplicated, or reordered physical resource cannot silently describe the same collection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceRevision {
    name: String,
    generation: String,
    stamp: i64,
}

impl ResourceRevision {
    /// Build one source revision. This constructor does not make the token authoritative; only a source may place it
    /// in a witness returned by `Source`.
    pub(crate) fn new(name: String, generation: String, stamp: i64) -> Result<Self> {
        if name.is_empty() || generation.is_empty() || stamp < 0 {
            return Err(crate::cause!(Error::Source));
        }
        Ok(Self {
            name,
            generation,
            stamp,
        })
    }
}

/// Equality-only source evidence for a complete records query.
///
/// Fields stay private so callers cannot manufacture a witness from a page or content digest. A source captures the
/// value from its actual records, model, schema, and resource owners, then validates it by reading those owners again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryWitness {
    source: String,
    binding: QueryBinding,
    resources: Vec<ResourceRevision>,
    model_generation: String,
    schema_generation: String,
}

impl QueryWitness {
    /// Build a witness from source-owned generations and the sorted set of physical record-store revisions.
    pub(crate) fn from_source(
        source: String,
        binding: QueryBinding,
        resources: Vec<ResourceRevision>,
        model_generation: String,
        schema_generation: String,
    ) -> Result<Self> {
        if source.is_empty()
            || model_generation.is_empty()
            || schema_generation.is_empty()
            || resources.is_empty()
            || resources
                .windows(2)
                .any(|pair| pair[0].name >= pair[1].name)
        {
            return Err(crate::cause!(Error::Source));
        }
        Ok(Self {
            source,
            binding,
            resources,
            model_generation,
            schema_generation,
        })
    }
}

/// A query source reads its witness from the same current owners that serve the logical query.
///
/// Implementations must check current source authority on every call and fail closed on incomplete catalogs, unreadable
/// generations, or any missing physical resource. In particular, an implementation must represent independently
/// changing model and schema generations explicitly; a records stamp alone does not cover either one.
pub trait Source {
    /// Read the current source revisions after checking the current authority for the exact query and every read scope.
    fn query_witness(&mut self, binding: &QueryBinding) -> Result<QueryWitness>;
}

/// A query result whose whole bounded walk completed under one unchanged source witness.
///
/// This is deliberately not serializable. The answer can be returned to a caller, while the witness remains internal
/// evidence for the later write-time check.
#[derive(Debug)]
pub struct Witnessed<T> {
    answer: T,
    witness: QueryWitness,
}

impl<T> Witnessed<T> {
    pub fn answer(&self) -> &T {
        &self.answer
    }

    pub fn witness(&self) -> &QueryWitness {
        &self.witness
    }

    pub fn into_parts(self) -> (T, QueryWitness) {
        (self.answer, self.witness)
    }
}

/// Whether a logical query finished every page within its declared walk bounds.
#[derive(Debug)]
pub enum QueryResult<T> {
    Complete(T),
    Incomplete,
}

/// Run every page of one logical query between two source reads.
///
/// The caller reports `Incomplete` when its page cursor still has work, its paging source was not consistent, or a
/// declared scan bound ended before completion. Any source change during the walk refuses the whole answer.
pub fn complete_query<S, T>(
    source: &mut S,
    binding: &QueryBinding,
    query: impl FnOnce(&mut S) -> Result<QueryResult<T>>,
) -> Result<Witnessed<T>>
where
    S: Source,
{
    let before = source.query_witness(binding)?;
    let answer = match query(source)? {
        QueryResult::Complete(answer) => answer,
        QueryResult::Incomplete => return Err(crate::cause!(Error::Source)),
    };
    let after = source.query_witness(binding)?;
    if before != after {
        return Err(crate::cause!(Error::Source));
    }
    Ok(Witnessed {
        answer,
        witness: before,
    })
}

/// Re-read and compare a query witness before a write starts. Current rights and source availability are the source's
/// responsibility and remain checked independently of equality.
pub fn validate(
    source: &mut impl Source,
    expected: &QueryWitness,
    current_binding: &QueryBinding,
) -> Result<bool> {
    if expected.binding != *current_binding {
        return Ok(false);
    }
    Ok(source.query_witness(current_binding)? == *expected)
}

/// Validate the query evidence before the caller starts any write effects.
///
/// The closure is not invoked on a source mismatch or a failed current-rights check. The native write owner must still
/// hold its normal transaction/admission and perform its independent principal and grant checks around this call.
pub fn write_if_current<S, T>(
    source: &mut S,
    expected: &QueryWitness,
    current_binding: &QueryBinding,
    write: impl FnOnce(&mut S) -> Result<T>,
) -> Result<T>
where
    S: Source,
{
    if !validate(source, expected, current_binding)? {
        return Err(crate::cause!(Error::Source));
    }
    write(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn binding(kind: &str, scope_resource: &str) -> QueryBinding {
        QueryBinding::new(
            "records:list".into(),
            json!({"type": kind, "reverse": true, "limit": 1}),
            vec![ReadScope::new(
                scope_resource.into(),
                "records:list".into(),
                json!({"kind": kind}),
            )
            .unwrap()],
        )
        .unwrap()
    }

    fn witness(stamp: i64, model: &str, schema: &str) -> QueryWitness {
        QueryWitness::from_source(
            "selected-account".into(),
            binding("test-row", "@own-records"),
            vec![
                ResourceRevision::new("@own-records".into(), "book-4".into(), stamp).unwrap(),
                ResourceRevision::new("resource-a".into(), "resource-9".into(), 12).unwrap(),
            ],
            model.into(),
            schema.into(),
        )
        .unwrap()
    }

    struct ChangingSource {
        revisions: Vec<QueryWitness>,
        reads: usize,
    }

    impl Source for ChangingSource {
        fn query_witness(&mut self, binding: &QueryBinding) -> Result<QueryWitness> {
            let index = self.reads.min(self.revisions.len() - 1);
            self.reads += 1;
            let witness = self.revisions[index].clone();
            if witness.binding != *binding {
                return Err(crate::cause!(Error::Source));
            }
            Ok(witness)
        }
    }

    #[test]
    fn complete_query_holds_all_physical_resource_revisions() {
        let mut source = ChangingSource {
            revisions: vec![witness(7, "model-a", "schema-a"); 2],
            reads: 0,
        };
        let binding = binding("test-row", "@own-records");
        let result = complete_query(&mut source, &binding, |_| {
            // The query can traverse any number of internal pages before declaring completion.
            Ok(QueryResult::Complete(vec!["row-a", "row-b"]))
        })
        .unwrap();
        assert_eq!(result.answer(), &["row-a", "row-b"]);
        assert_eq!(source.reads, 2);
    }

    #[test]
    fn incomplete_pagination_returns_no_witnessed_answer() {
        let mut source = ChangingSource {
            revisions: vec![witness(7, "model-a", "schema-a"); 1],
            reads: 0,
        };
        assert!(matches!(
            complete_query(
                &mut source,
                &binding("test-row", "@own-records"),
                |_| Ok(QueryResult::<Vec<&str>>::Incomplete)
            ),
            Err(Error::Source(_))
        ));
        assert_eq!(source.reads, 1);
    }

    #[test]
    fn resource_change_during_any_page_refuses_the_whole_query() {
        let mut source = ChangingSource {
            revisions: vec![
                witness(7, "model-a", "schema-a"),
                witness(8, "model-a", "schema-a"),
            ],
            reads: 0,
        };
        let binding = binding("test-row", "@own-records");
        assert!(matches!(
            complete_query(&mut source, &binding, |_| Ok(QueryResult::Complete(()))),
            Err(Error::Source(_))
        ));
    }

    #[test]
    fn model_and_schema_generations_are_independent_witness_parts() {
        let current = witness(7, "model-b", "schema-a");
        assert_ne!(current, witness(7, "model-a", "schema-a"));
        assert_ne!(current, witness(7, "model-b", "schema-b"));
    }

    #[test]
    fn model_generation_change_during_the_walk_refuses_the_answer() {
        let mut source = ChangingSource {
            revisions: vec![
                witness(7, "model-a", "schema-a"),
                witness(7, "model-b", "schema-a"),
            ],
            reads: 0,
        };
        let binding = binding("test-row", "@own-records");
        assert!(matches!(
            complete_query(&mut source, &binding, |_| Ok(QueryResult::Complete(()))),
            Err(Error::Source(_))
        ));
    }

    #[test]
    fn schema_generation_change_during_the_walk_refuses_the_answer() {
        let mut source = ChangingSource {
            revisions: vec![
                witness(7, "model-a", "schema-a"),
                witness(7, "model-a", "schema-b"),
            ],
            reads: 0,
        };
        let binding = binding("test-row", "@own-records");
        assert!(matches!(
            complete_query(&mut source, &binding, |_| Ok(QueryResult::Complete(()))),
            Err(Error::Source(_))
        ));
    }

    #[test]
    fn a_change_in_a_secondary_physical_resource_refuses_the_answer() {
        let before = witness(7, "model-a", "schema-a");
        let after = QueryWitness::from_source(
            "selected-account".into(),
            binding("test-row", "@own-records"),
            vec![
                ResourceRevision::new("@own-records".into(), "book-4".into(), 7).unwrap(),
                ResourceRevision::new("resource-a".into(), "resource-9".into(), 13).unwrap(),
            ],
            "model-a".into(),
            "schema-a".into(),
        )
        .unwrap();
        let mut source = ChangingSource {
            revisions: vec![before, after],
            reads: 0,
        };
        let binding = binding("test-row", "@own-records");
        assert!(matches!(
            complete_query(&mut source, &binding, |_| Ok(QueryResult::Complete(()))),
            Err(Error::Source(_))
        ));
    }

    #[test]
    fn malformed_or_partial_resource_vectors_are_refused() {
        assert!(QueryWitness::from_source(
            "selected-account".into(),
            binding("test-row", "@own-records"),
            vec![
                ResourceRevision::new("resource-b".into(), "g2".into(), 1).unwrap(),
                ResourceRevision::new("resource-a".into(), "g1".into(), 1).unwrap(),
            ],
            "model".into(),
            "schema".into(),
        )
        .is_err());
        assert!(QueryWitness::from_source(
            "selected-account".into(),
            binding("test-row", "@own-records"),
            vec![ResourceRevision::new("resource-a".into(), "g1".into(), 1).unwrap()],
            String::new(),
            "schema".into(),
        )
        .is_err());
    }

    #[test]
    fn write_validation_detects_aba_by_source_revision() {
        let first = witness(7, "model-a", "schema-a");
        let away = witness(8, "model-a", "schema-a");
        let back = witness(9, "model-a", "schema-a");
        let mut source = ChangingSource {
            revisions: vec![back],
            reads: 0,
        };
        assert!(!validate(
            &mut source,
            &first,
            &binding("test-row", "@own-records")
        )
        .unwrap());
        assert_ne!(first, away);
        assert_ne!(away, witness(7, "model-a", "schema-a"));
    }

    #[test]
    fn a_conflict_does_not_enter_the_write_effect_closure() {
        let expected = witness(7, "model-a", "schema-a");
        let mut source = ChangingSource {
            revisions: vec![witness(8, "model-a", "schema-a")],
            reads: 0,
        };
        let binding = binding("test-row", "@own-records");
        let mut effects = 0;
        let result = write_if_current(&mut source, &expected, &binding, |_| {
            effects += 1;
            Ok(())
        });
        assert!(matches!(result, Err(Error::Source(_))));
        assert_eq!(effects, 0);
    }

    #[test]
    fn revoked_query_authority_refuses_before_write_effects() {
        struct Revoked;
        impl Source for Revoked {
            fn query_witness(&mut self, _binding: &QueryBinding) -> Result<QueryWitness> {
                Err(crate::cause!(Error::Source))
            }
        }

        let expected = witness(7, "model-a", "schema-a");
        let mut source = Revoked;
        let binding = binding("test-row", "@own-records");
        let mut effects = 0;
        let result = write_if_current(&mut source, &expected, &binding, |_| {
            effects += 1;
            Ok(())
        });
        assert!(matches!(result, Err(Error::Source(_))));
        assert_eq!(effects, 0);
    }
}
