// src/storage/supplies/tests/conformance.rs
//
// Purpose: Run the parent crate's records conformance suite (tests/records_conformance.rs) against one real database
// server through its supply. `STORAGE_SUPPLY` and `STORAGE_URL` choose the supply and the server; build.rs makes the suite.
//
// Non-Negotiable Invariants:
// - The test bodies are the parent's, unedited. Only the engine chooser is replaced (tests/replacement/store_under_test.rs).
// - A server that is not running fails the run; it is never skipped silently.
//
// Key Concepts:
// - One cargo invocation per supply and server: `STORAGE_SUPPLY=postgres STORAGE_URL=... cargo test --features postgres`.
//
// Security Considerations:
// - Scratch store names on a local throwaway server only; no account data.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

#![allow(dead_code, unused_imports)]

extern crate local_engine as trillion_local;

include!(concat!(env!("OUT_DIR"), "/suite.rs"));
