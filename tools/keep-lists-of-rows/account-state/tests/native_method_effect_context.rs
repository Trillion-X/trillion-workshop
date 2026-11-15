// Exercise the actual source module through the existing physical read owner.
// This integration target supplies no account, task or release authority.
pub use trillion_local::{cause, carry_cause, impl_caused, ecma_json, refusal_cause, storage};

#[path = "../src/local_account/native_command_context/method_effect_context.rs"]
mod method_effect_context;
