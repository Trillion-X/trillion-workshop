//! These library errors have no stored engine refusal site. Their first engine
//! conversion names the failing condition; the library's data is never logged.
crate::impl_foreign_caused!(base64::DecodeError);
crate::impl_foreign_caused!(content_crypto::MultihashError);
crate::impl_foreign_caused!(chacha20poly1305::Error);
crate::impl_foreign_caused!(content_crypto::advanced::sha2::digest::InvalidLength);
