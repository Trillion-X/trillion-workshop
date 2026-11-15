//! The world's identities: one live session per identity. A second session opened under an identity that is live is
//! refused, so two processes can never answer as one computer.

use std::collections::BTreeMap;

#[derive(Debug, PartialEq, Eq)]
pub enum IdentityError {
    /// The identity already has a live session.
    Duplicate,
}

#[derive(Default)]
pub struct Identities {
    live: BTreeMap<String, u64>,
    next_session: u64,
}

impl Identities {
    pub fn open(&mut self, identity: &str) -> Result<u64, IdentityError> {
        if self.live.contains_key(identity) {
            return Err(IdentityError::Duplicate);
        }
        self.next_session += 1;
        self.live.insert(identity.to_string(), self.next_session);
        Ok(self.next_session)
    }

    pub fn close(&mut self, identity: &str) {
        self.live.remove(identity);
    }
}
