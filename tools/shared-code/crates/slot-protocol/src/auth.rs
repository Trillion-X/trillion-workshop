//! Projection-boundary authorization.
//!
//! Capability intersection against read_capabilities.
//! Revocation scrub command dispatch.

use crate::newtypes::CapabilityHash;
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;

/// Projection-boundary authorization check.
/// Verifies that the requesting principal's capabilities intersect with the envelope's read_capabilities.
#[derive(Debug, Clone)]
pub struct AuthorizationContext {
    /// Principal's granted capabilities.
    pub granted: SmallVec<[CapabilityHash; 8]>,

    /// Envelope's read_capabilities requirement.
    pub required: SmallVec<[CapabilityHash; 8]>,

    /// When true, all capability checks pass regardless of granted/required intersection.
    /// Used for authenticated principals whose full capability set has not yet been
    /// extracted from a capability token (§14.1 CapabilityContextBinding).
    /// The filtering CODE is permanent — only this flag changes when §14.1 lands
    /// and real capability tokens provide the granted set.
    pub authenticated: bool,
}

impl AuthorizationContext {
    /// Check if the principal has any required capability.
    pub fn has_permission(&self) -> bool {
        // Authenticated principals pass all checks — preserves pre-capability-token
        // behavior where authenticated users see all workspace data.
        if self.authenticated {
            return true;
        }

        if self.required.is_empty() {
            // No restriction = all principals pass
            return true;
        }

        // Principal must have at least one required capability
        self.required.iter().any(|req| self.granted.contains(req))
    }

    /// Get the intersection of granted and required capabilities.
    pub fn intersection(&self) -> SmallVec<[CapabilityHash; 8]> {
        let mut result = SmallVec::new();
        for req in &self.required {
            if self.granted.contains(req) {
                result.push(req.clone());
            }
        }
        result
    }
}

/// Latest accepted capability expiry time (SP3).
/// Prevents rollback attacks on capability tokens.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatestAcceptedCapabilityExpiry {
    /// Last known expiry timestamp.
    pub latest_accepted_expiry: u64,
}

impl LatestAcceptedCapabilityExpiry {
    /// Create a new latest accepted capability expiry tracker.
    pub fn new(initial_latest_accepted_expiry: u64) -> Self {
        LatestAcceptedCapabilityExpiry {
            latest_accepted_expiry: initial_latest_accepted_expiry,
        }
    }

    /// Check if a capability expiry is valid (not rolled back).
    pub fn is_valid_expiry(&self, expiry_time: u64) -> bool {
        expiry_time >= self.latest_accepted_expiry
    }

    /// Accept a newer capability expiry time and keep the stored value monotonic.
    pub fn accept_expiry(&mut self, new_expiry_time: u64) {
        if new_expiry_time > self.latest_accepted_expiry {
            self.latest_accepted_expiry = new_expiry_time;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_authorization_no_restriction() {
        let ctx = AuthorizationContext {
            granted: SmallVec::new(),
            required: SmallVec::new(),
            authenticated: false,
        };
        assert!(ctx.has_permission());
    }

    #[test]
    fn test_authorization_match() {
        let cap = CapabilityHash::from_digest(0x1F, vec![1; 32]);
        let mut granted = SmallVec::new();
        granted.push(cap.clone());

        let mut required = SmallVec::new();
        required.push(cap);

        let ctx = AuthorizationContext {
            granted,
            required,
            authenticated: false,
        };
        assert!(ctx.has_permission());
    }

    #[test]
    fn test_authorization_no_match() {
        let cap1 = CapabilityHash::from_digest(0x1F, vec![1; 32]);
        let cap2 = CapabilityHash::from_digest(0x1F, vec![2; 32]);

        let mut granted = SmallVec::new();
        granted.push(cap1);

        let mut required = SmallVec::new();
        required.push(cap2);

        let ctx = AuthorizationContext {
            granted,
            required,
            authenticated: false,
        };
        assert!(!ctx.has_permission());
    }

    #[test]
    fn test_authorization_intersection() {
        let cap1 = CapabilityHash::from_digest(0x1F, vec![1; 32]);
        let cap2 = CapabilityHash::from_digest(0x1F, vec![2; 32]);
        let cap3 = CapabilityHash::from_digest(0x1F, vec![3; 32]);

        let mut granted = SmallVec::new();
        granted.push(cap1);
        granted.push(cap2.clone());

        let mut required = SmallVec::new();
        required.push(cap2.clone());
        required.push(cap3);

        let ctx = AuthorizationContext {
            granted,
            required,
            authenticated: false,
        };
        let intersection = ctx.intersection();

        assert_eq!(intersection.len(), 1);
        assert_eq!(intersection[0], cap2);
    }

    #[test]
    fn test_latest_accepted_capability_expiry_valid() {
        let latest_expiry = LatestAcceptedCapabilityExpiry::new(100);
        assert!(latest_expiry.is_valid_expiry(100));
        assert!(latest_expiry.is_valid_expiry(101));
        assert!(!latest_expiry.is_valid_expiry(99));
    }

    #[test]
    fn test_latest_accepted_capability_expiry_update() {
        let mut latest_expiry = LatestAcceptedCapabilityExpiry::new(100);
        latest_expiry.accept_expiry(150);
        assert_eq!(latest_expiry.latest_accepted_expiry, 150);

        latest_expiry.accept_expiry(120); // Lower value, should not update
        assert_eq!(latest_expiry.latest_accepted_expiry, 150);
    }
}
