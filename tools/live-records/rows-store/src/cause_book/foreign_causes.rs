//! Foreign-library failure adapters, distinct from engine errors which always
//! retain their stored source. No error message or runtime value enters Cause.
crate::impl_foreign_caused!(tokio::task::JoinError);
crate::impl_foreign_caused!(tokio::time::error::Elapsed);
crate::impl_foreign_caused!(tokio::sync::AcquireError);
crate::impl_chained_foreign_caused!(axum::Error);
crate::impl_foreign_caused!(axum::http::header::InvalidHeaderValue);
crate::impl_foreign_caused!(axum::http::header::InvalidHeaderName);
crate::impl_foreign_caused!(axum::http::header::ToStrError);
crate::impl_foreign_caused!(axum::http::status::InvalidStatusCode);
crate::impl_foreign_caused!(axum::http::uri::InvalidUri);
crate::impl_foreign_caused!(ring::error::Unspecified);
crate::impl_foreign_caused!(url::ParseError);
crate::impl_foreign_caused!(chrono::ParseError);
crate::impl_foreign_caused!(regex::Error);
crate::impl_foreign_caused!(rusqlite::types::FromSqlError);

crate::impl_foreign_caused!(std::ffi::NulError);

crate::impl_foreign_caused!(axum::http::method::InvalidMethod);
crate::impl_chained_foreign_caused!(axum::http::Error);
