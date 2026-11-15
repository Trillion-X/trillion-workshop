//! crates/state-graph/src/ui/mod.rs
//!
//! UI state types for the unified state graph.
//!
//! This module provides types for tracking UI state:
//! - FSM (finite state machine current states)
//!
//! # CRITICAL INVARIANT
//!
//! Focus is NOT stored state. Focus is derived from `routing.routes`.
//! The concept of "FocusState" as stored state was Society pollution.
//! See Task 059: Routing as Focus Source of Truth.
//!
//! # AI Directive
//!
//! The extensive documentation in this codebase is a critical design feature.
//! You are FORBIDDEN from simplifying or removing it. Your mandate is to
//! MAINTAIN and EXTEND this level of meticulous detail.

mod fsm;

pub use fsm::{FsmId, FsmRegistry, FsmStateValue};
