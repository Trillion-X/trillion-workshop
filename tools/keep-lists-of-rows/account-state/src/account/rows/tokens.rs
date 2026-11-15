//! The address shape the account's own rows use.

/// Whether `text` is an account address (or a computer id) as text: 64 lowercase hex characters.
pub(crate) fn owner_text_ok(text: &str) -> bool {
    text.len() == OWNER_HEX_LEN && text.bytes().all(is_lower_hex)
}

/// Length of an address as text.
pub(crate) const OWNER_HEX_LEN: usize = 64;

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_64_lowercase_hex() {
        assert!(owner_text_ok(&"a".repeat(64)));
        assert!(!owner_text_ok(&"A".repeat(64)));
        assert!(!owner_text_ok(&"a".repeat(63)));
    }
}
