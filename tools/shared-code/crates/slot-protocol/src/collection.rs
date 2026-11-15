// crates/slot-protocol/src/collection.rs
//
// Purpose:
//   Multi-target dispatch with collection policies. Transport-level scatter/gather
//   semantics — the engine remains 100% payload-blind. CollectionPolicy controls
//   HOW MANY replies to wait for, NOT what's inside them.
//
// Non-Negotiable Invariants:
//   1. CollectionPolicy is transport-level ONLY — zero payload inspection
//   2. Reply is opaque — the engine never deserializes slot responses
//   3. Single-target dispatch = dispatch_multi(&[one], All) — zero special cases
//   4. The engine never merges, interprets, or inspects reply content
//
// Architecture (§47 1062j Part 1):
//   Existing Slot::dispatch() is fire-and-forget (returns Hash receipt).
//   Existing Slot::query() is request/reply (returns Arc<[u8]>).
//   dispatch_multi() fans out query() to N slots per CollectionPolicy,
//   collecting replies as opaque byte slices. Semantic merge (Union/FirstMatch/Priority)
//   happens in the CALLER using crates/ask-many/, NOT here.

use crate::error::EnvelopeError;
use crate::registry::SlotRegistry;
use crate::Envelope;
use std::sync::Arc;

/// Transport-level collection policy — controls how many replies to wait for.
///
/// This is about TRANSPORT MECHANICS (how many replies), NOT about PAYLOAD SEMANTICS
/// (what's inside the replies). The engine never inspects reply content.
///
/// # L069 Adversarial Test
///
/// Any combination of CollectionPolicy × N targets × any payload type
/// works identically. All(3 targets) = wait for 3. First(3 targets) = take first.
/// Quorum(2, 3 targets) = wait for 2 of 3. Zero special cases.
#[derive(Debug, Clone, PartialEq)]
pub enum CollectionPolicy {
    /// Wait for ALL replies, return Vec of all.
    All,
    /// Take the first successful reply, cancel/ignore the rest.
    First,
    /// Wait for N replies (quorum), return those N.
    Quorum(usize),
    /// Wait up to N ms, return whatever arrived by then.
    Timeout { ms: u64 },
}

/// A reply from a single slot — opaque bytes tagged with the slot name.
///
/// The engine never deserializes `data`. Each slot serializes its own types.
/// The caller deserializes per its own schema.
#[derive(Debug, Clone)]
pub struct Reply {
    /// Name of the slot that produced this reply.
    pub slot_name: String,
    /// Opaque response bytes (slot-specific serialization).
    pub data: Arc<[u8]>,
}

/// Dispatch a query envelope to multiple slots per CollectionPolicy.
///
/// This is the transport-level scatter/gather primitive. It resolves N slot names
/// from the registry, dispatches the same envelope to each, and collects replies
/// per the policy. The engine never inspects payload bytes.
///
/// # Arguments
///
/// * `registry` - SlotRegistry to resolve slot names
/// * `envelope` - The query envelope to dispatch (cloned per target)
/// * `targets` - Slot names to dispatch to
/// * `policy` - How many replies to collect
///
/// # Returns
///
/// `Ok(Vec<Reply>)` - Collected replies per policy
/// `Err(EnvelopeError)` - All targets failed or policy not satisfiable
///
/// # Single-target dispatch
///
/// `dispatch_multi(registry, env, &["door-alpha"], All)` = current single-slot behavior.
/// Zero special cases.
pub async fn dispatch_multi(
    registry: &SlotRegistry,
    envelope: Envelope,
    targets: &[String],
    policy: CollectionPolicy,
) -> Result<Vec<Reply>, EnvelopeError> {
    if targets.is_empty() {
        return Err(EnvelopeError::Internal(
            "dispatch_multi: zero targets".to_string(),
        ));
    }

    // Resolve all slots upfront — fail fast if any target is unknown
    let mut slots = Vec::with_capacity(targets.len());
    for name in targets {
        let slot = registry.resolve(name)?;
        slots.push((name.clone(), slot));
    }

    // Dispatch to all targets concurrently
    let mut handles = Vec::with_capacity(slots.len());
    for (name, slot) in slots {
        let env_clone = envelope.clone();
        handles.push(tokio::spawn(async move {
            let result = slot.query(env_clone).await;
            (name, result)
        }));
    }

    // Collect per policy
    match policy {
        CollectionPolicy::All => {
            let mut replies = Vec::with_capacity(handles.len());
            let mut errors = Vec::new();
            for handle in handles {
                match handle.await {
                    Ok((name, Ok(data))) => replies.push(Reply {
                        slot_name: name,
                        data,
                    }),
                    Ok((name, Err(e))) => errors.push(format!("{}: {}", name, e)),
                    Err(e) => errors.push(format!("join: {}", e)),
                }
            }
            if replies.is_empty() && !errors.is_empty() {
                return Err(EnvelopeError::Internal(format!(
                    "all targets failed: {}",
                    errors.join("; ")
                )));
            }
            Ok(replies)
        }

        CollectionPolicy::First => {
            // Use select-style: take first success
            let (tx, mut rx) = tokio::sync::mpsc::channel::<Reply>(1);
            let error_tx = tokio::sync::mpsc::channel::<String>(handles.len());

            for handle in handles {
                let tx = tx.clone();
                let err_tx = error_tx.0.clone();
                tokio::spawn(async move {
                    match handle.await {
                        Ok((name, Ok(data))) => {
                            let _ = tx
                                .send(Reply {
                                    slot_name: name,
                                    data,
                                })
                                .await;
                        }
                        Ok((name, Err(e))) => {
                            let _ = err_tx.send(format!("{}: {}", name, e)).await;
                        }
                        Err(e) => {
                            let _ = err_tx.send(format!("join: {}", e)).await;
                        }
                    }
                });
            }
            drop(tx); // Close sender so rx completes when all spawned tasks finish
            drop(error_tx.0);

            match rx.recv().await {
                Some(reply) => Ok(vec![reply]),
                None => Err(EnvelopeError::Internal(
                    "all targets failed (First policy)".to_string(),
                )),
            }
        }

        CollectionPolicy::Quorum(n) => {
            if n > targets.len() {
                return Err(EnvelopeError::Internal(format!(
                    "quorum {} exceeds target count {}",
                    n,
                    targets.len()
                )));
            }
            let mut replies = Vec::with_capacity(n);
            for handle in handles {
                if replies.len() >= n {
                    break;
                }
                if let Ok((name, Ok(data))) = handle.await {
                    replies.push(Reply {
                        slot_name: name,
                        data,
                    }); // skip failures, try next
                }
            }
            if replies.len() < n {
                return Err(EnvelopeError::Internal(format!(
                    "quorum not reached: got {} of {}",
                    replies.len(),
                    n
                )));
            }
            Ok(replies)
        }

        CollectionPolicy::Timeout { ms } => {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(ms);
            let mut replies = Vec::with_capacity(handles.len());

            for handle in handles {
                if let Ok(Ok((name, Ok(data)))) = tokio::time::timeout_at(deadline, handle).await {
                    replies.push(Reply {
                        slot_name: name,
                        data,
                    }); // timeout or error — skip
                }
            }
            // Timeout returns whatever arrived — even empty is valid
            Ok(replies)
        }
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::method::MethodDescriptor;
    use crate::slot::Slot;
    use crate::{FactAddress, Hash, PartitionKey};
    use std::future::Future;
    use std::pin::Pin;

    /// Mock slot that returns its name as query response.
    struct EchoSlot {
        name: String,
    }

    impl Slot for EchoSlot {
        fn dispatch(&self, _entries: Vec<Envelope>) -> Result<Hash, EnvelopeError> {
            Ok(Hash::from_bytes([0u8; 32]))
        }

        fn query(
            &self,
            _envelope: Envelope,
        ) -> Pin<Box<dyn Future<Output = Result<Arc<[u8]>, EnvelopeError>> + Send + '_>> {
            let name = self.name.clone();
            Box::pin(async move { Ok(Arc::from(name.as_bytes())) })
        }

        fn methods(&self) -> Vec<MethodDescriptor> {
            vec![MethodDescriptor::new("echo", "returns slot name")]
        }
    }

    /// Mock slot that always fails.
    struct FailSlot;

    impl Slot for FailSlot {
        fn dispatch(&self, _entries: Vec<Envelope>) -> Result<Hash, EnvelopeError> {
            Err(EnvelopeError::Internal("fail".to_string()))
        }

        fn query(
            &self,
            _envelope: Envelope,
        ) -> Pin<Box<dyn Future<Output = Result<Arc<[u8]>, EnvelopeError>> + Send + '_>> {
            Box::pin(async { Err(EnvelopeError::Internal("fail".to_string())) })
        }

        fn methods(&self) -> Vec<MethodDescriptor> {
            vec![]
        }
    }

    fn test_envelope() -> Envelope {
        Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![1u8; 32]),
            FactAddress::from_digest(0x1F, vec![2u8; 32]),
            Some(bytes::Bytes::from_static(b"test")),
        )
    }

    #[tokio::test]
    async fn all_policy_collects_all_replies() {
        let registry = SlotRegistry::new();
        registry.register(
            "a".to_string(),
            Arc::new(EchoSlot {
                name: "a".to_string(),
            }),
        );
        registry.register(
            "b".to_string(),
            Arc::new(EchoSlot {
                name: "b".to_string(),
            }),
        );

        let replies = dispatch_multi(
            &registry,
            test_envelope(),
            &["a".to_string(), "b".to_string()],
            CollectionPolicy::All,
        )
        .await
        .unwrap();

        assert_eq!(replies.len(), 2);
        let names: Vec<&str> = replies.iter().map(|r| r.slot_name.as_str()).collect();
        assert!(names.contains(&"a"));
        assert!(names.contains(&"b"));
    }

    #[tokio::test]
    async fn first_policy_returns_one_reply() {
        let registry = SlotRegistry::new();
        registry.register(
            "a".to_string(),
            Arc::new(EchoSlot {
                name: "a".to_string(),
            }),
        );
        registry.register(
            "b".to_string(),
            Arc::new(EchoSlot {
                name: "b".to_string(),
            }),
        );

        let replies = dispatch_multi(
            &registry,
            test_envelope(),
            &["a".to_string(), "b".to_string()],
            CollectionPolicy::First,
        )
        .await
        .unwrap();

        assert_eq!(replies.len(), 1);
    }

    #[tokio::test]
    async fn quorum_policy_waits_for_n() {
        let registry = SlotRegistry::new();
        registry.register(
            "a".to_string(),
            Arc::new(EchoSlot {
                name: "a".to_string(),
            }),
        );
        registry.register(
            "b".to_string(),
            Arc::new(EchoSlot {
                name: "b".to_string(),
            }),
        );
        registry.register(
            "c".to_string(),
            Arc::new(EchoSlot {
                name: "c".to_string(),
            }),
        );

        let replies = dispatch_multi(
            &registry,
            test_envelope(),
            &["a".to_string(), "b".to_string(), "c".to_string()],
            CollectionPolicy::Quorum(2),
        )
        .await
        .unwrap();

        assert_eq!(replies.len(), 2);
    }

    #[tokio::test]
    async fn quorum_exceeds_target_count_errors() {
        let registry = SlotRegistry::new();
        registry.register(
            "a".to_string(),
            Arc::new(EchoSlot {
                name: "a".to_string(),
            }),
        );

        let result = dispatch_multi(
            &registry,
            test_envelope(),
            &["a".to_string()],
            CollectionPolicy::Quorum(5),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn timeout_policy_returns_whatever_arrived() {
        let registry = SlotRegistry::new();
        registry.register(
            "a".to_string(),
            Arc::new(EchoSlot {
                name: "a".to_string(),
            }),
        );

        let replies = dispatch_multi(
            &registry,
            test_envelope(),
            &["a".to_string()],
            CollectionPolicy::Timeout { ms: 5000 },
        )
        .await
        .unwrap();

        assert_eq!(replies.len(), 1);
    }

    #[tokio::test]
    async fn empty_targets_errors() {
        let registry = SlotRegistry::new();

        let result = dispatch_multi(&registry, test_envelope(), &[], CollectionPolicy::All).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn unknown_target_errors() {
        let registry = SlotRegistry::new();

        let result = dispatch_multi(
            &registry,
            test_envelope(),
            &["nonexistent".to_string()],
            CollectionPolicy::All,
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn all_targets_fail_returns_error() {
        let registry = SlotRegistry::new();
        registry.register("fail".to_string(), Arc::new(FailSlot));

        let result = dispatch_multi(
            &registry,
            test_envelope(),
            &["fail".to_string()],
            CollectionPolicy::All,
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn single_target_all_policy_is_standard_dispatch() {
        let registry = SlotRegistry::new();
        registry.register(
            "door-alpha".to_string(),
            Arc::new(EchoSlot {
                name: "door-alpha".to_string(),
            }),
        );

        let replies = dispatch_multi(
            &registry,
            test_envelope(),
            &["door-alpha".to_string()],
            CollectionPolicy::All,
        )
        .await
        .unwrap();

        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0].slot_name, "door-alpha");
        assert_eq!(&*replies[0].data, b"door-alpha");
    }

    #[tokio::test]
    async fn mixed_success_and_failure_all_policy() {
        let registry = SlotRegistry::new();
        registry.register(
            "ok".to_string(),
            Arc::new(EchoSlot {
                name: "ok".to_string(),
            }),
        );
        registry.register("fail".to_string(), Arc::new(FailSlot));

        let replies = dispatch_multi(
            &registry,
            test_envelope(),
            &["ok".to_string(), "fail".to_string()],
            CollectionPolicy::All,
        )
        .await
        .unwrap();

        // At least the successful one should be there
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0].slot_name, "ok");
    }
}
