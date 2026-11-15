//! Multi-writer merge & conflict surfacing.
//!
//! When two writers fork the causal DAG:
//! - If a WASM merge reducer is declared → engine auto-merges by invoking it
//! - If no reducer exists → engine preserves fork as explicit `ConflictSet` object
//!
//! Conflicts are queryable, subscribable, auditable, and resolvable.
//! The ExternalWriter receives the conflict and translates it into domain representation.
//! The engine never dictates HOW conflicts are shown.

use crate::newtypes::{FactAddress, Hash, PathSegment, PrincipalId};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;

/// First-class conflict object — the engine NEVER silently drops a side.
/// When two writers fork the causal DAG and no WASM reducer is declared,
/// the engine preserves BOTH sides as a ConflictSet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictSet {
    /// Which entity is in conflict.
    pub address: FactAddress,

    /// ALL concurrent branches — 2 or more.
    /// Conflicts rarely exceed 4 branches.
    pub branches: SmallVec<[ConflictBranch; 4]>,

    /// Deterministic hash of sorted branch hashes.
    pub set_hash: Hash,

    /// hybrid logical clock time when the engine detected the fork.
    pub detected_at: u64,
}

/// One branch of a conflict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictBranch {
    /// Causal predecessor of this branch.
    pub parent_hash: Hash,

    /// When this branch was written.
    pub hybrid_logical_clock_time: u64,

    /// Sub-entity path where the conflict occurred.
    pub path: SmallVec<[PathSegment; 8]>,

    /// The opaque bytes — None = retraction.
    #[serde(with = "branch_payload_serde")]
    pub payload: Option<Bytes>,

    /// Who wrote this branch.
    pub actor: PrincipalId,
}

/// Serde helpers for branch payload.
mod branch_payload_serde {
    use bytes::Bytes;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        bytes: &Option<Bytes>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match bytes {
            None => serializer.serialize_none(),
            Some(b) => serializer.serialize_bytes(b),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Bytes>, D::Error> {
        match <Option<Vec<u8>>>::deserialize(deserializer)? {
            None => Ok(None),
            Some(vec) => Ok(Some(Bytes::from(vec))),
        }
    }
}

/// Causal context for each conflict branch.
/// The reducer needs more than raw bytes — LWW needs timestamps, RBAC needs actor identity.
#[derive(Debug, Clone)]
pub struct BranchContext<'a> {
    /// Opaque bytes — None = this branch deleted the entity.
    pub payload: Option<&'a [u8]>,

    /// When this branch was written.
    pub hybrid_logical_clock_time: u64,

    /// Who wrote this branch.
    pub actor: PrincipalId,

    /// Sub-entity path context.
    pub path: &'a [PathSegment],
}

/// Zero-allocation merge result.
/// 80%+ of merges are branch-selection (LWW, priority-based).
/// Forcing Vec<u8> allocation for "just pick branch[0]" is O(N) waste.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MergeAction {
    /// O(1) zero-copy: keep branches[idx] as-is.
    KeepBranch(usize),

    /// O(N) allocation: computed a new merged value.
    NewPayload(Vec<u8>),

    /// O(1) deletion: merged result is "delete this entity".
    Tombstone,
}

/// Merge error — the reducer cannot merge these branches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeError {
    pub reason: String,
}

impl ConflictSet {
    /// Create a new conflict set with the given branches.
    pub fn new(
        address: FactAddress,
        branches: SmallVec<[ConflictBranch; 4]>,
        detected_at: u64,
    ) -> Self {
        // Compute deterministic hash of sorted branch hashes
        let mut branch_hashes = branches
            .iter()
            .map(|b| b.parent_hash.digest().to_vec())
            .collect::<Vec<_>>();
        branch_hashes.sort();

        let hash_data = branch_hashes.iter().flatten().copied().collect::<Vec<_>>();
        let set_hash = Hash::blake3_hash(&hash_data);

        ConflictSet {
            address,
            branches,
            set_hash,
            detected_at,
        }
    }

    /// Check if all branches are retractions (all have payload = None).
    pub fn all_tombstone(&self) -> bool {
        self.branches.iter().all(|b| b.payload.is_none())
    }

    /// Get the branch with the latest hybrid logical clock time (Last Writer Wins).
    pub fn latest_branch(&self) -> Option<&ConflictBranch> {
        self.branches
            .iter()
            .max_by_key(|b| b.hybrid_logical_clock_time)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_conflict_set_creation() {
        let address = FactAddress::from_digest(0x1F, vec![1; 32]);
        let mut branches = SmallVec::new();

        let branch1 = ConflictBranch {
            parent_hash: Hash::blake3([2; 32]),
            hybrid_logical_clock_time: 100,
            path: SmallVec::new(),
            payload: Some(Bytes::from("version_a")),
            actor: PrincipalId::from_digest(0x1F, vec![3; 32]),
        };

        let branch2 = ConflictBranch {
            parent_hash: Hash::blake3([4; 32]),
            hybrid_logical_clock_time: 105,
            path: SmallVec::new(),
            payload: Some(Bytes::from("version_b")),
            actor: PrincipalId::from_digest(0x1F, vec![5; 32]),
        };

        branches.push(branch1);
        branches.push(branch2);

        let conflict = ConflictSet::new(address.clone(), branches, 110);

        assert_eq!(conflict.address, address);
        assert_eq!(conflict.branches.len(), 2);
        assert_eq!(conflict.detected_at, 110);
    }

    #[test]
    fn test_all_tombstone() {
        let address = FactAddress::from_digest(0x1F, vec![1; 32]);
        let mut branches = SmallVec::new();

        branches.push(ConflictBranch {
            parent_hash: Hash::blake3([2; 32]),
            hybrid_logical_clock_time: 100,
            path: SmallVec::new(),
            payload: None,
            actor: PrincipalId::from_digest(0x1F, vec![3; 32]),
        });

        branches.push(ConflictBranch {
            parent_hash: Hash::blake3([4; 32]),
            hybrid_logical_clock_time: 101,
            path: SmallVec::new(),
            payload: None,
            actor: PrincipalId::from_digest(0x1F, vec![5; 32]),
        });

        let conflict = ConflictSet::new(address, branches, 102);
        assert!(conflict.all_tombstone());
    }

    #[test]
    fn test_latest_branch() {
        let address = FactAddress::from_digest(0x1F, vec![1; 32]);
        let mut branches = SmallVec::new();

        branches.push(ConflictBranch {
            parent_hash: Hash::blake3([2; 32]),
            hybrid_logical_clock_time: 100,
            path: SmallVec::new(),
            payload: Some(Bytes::from("old")),
            actor: PrincipalId::from_digest(0x1F, vec![3; 32]),
        });

        branches.push(ConflictBranch {
            parent_hash: Hash::blake3([4; 32]),
            hybrid_logical_clock_time: 150,
            path: SmallVec::new(),
            payload: Some(Bytes::from("new")),
            actor: PrincipalId::from_digest(0x1F, vec![5; 32]),
        });

        let conflict = ConflictSet::new(address, branches, 160);
        let latest = conflict.latest_branch().unwrap();

        assert_eq!(latest.hybrid_logical_clock_time, 150);
        assert_eq!(latest.payload, Some(Bytes::from("new")));
    }

    #[test]
    fn test_merge_action_variants() {
        let action1 = MergeAction::KeepBranch(0);
        assert!(matches!(action1, MergeAction::KeepBranch(0)));

        let action2 = MergeAction::NewPayload(vec![1, 2, 3]);
        assert!(matches!(action2, MergeAction::NewPayload(_)));

        let action3 = MergeAction::Tombstone;
        assert!(matches!(action3, MergeAction::Tombstone));
    }

    #[test]
    fn test_branch_context_creation() {
        let payload = b"test";
        let path = vec![PathSegment::from_digest(0x1F, vec![1; 32])];
        let ctx = BranchContext {
            payload: Some(payload),
            hybrid_logical_clock_time: 100,
            actor: PrincipalId::from_digest(0x1F, vec![2; 32]),
            path: &path,
        };

        assert!(ctx.payload.is_some());
        assert_eq!(ctx.hybrid_logical_clock_time, 100);
    }
}
