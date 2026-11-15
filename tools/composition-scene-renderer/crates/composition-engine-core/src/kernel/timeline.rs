//! crates/composition-engine-core/src/kernel/timeline.rs
//!
//! Timeline Primitive (P8) - PURE FUNCTIONAL
//!
//! Collects performance metrics and traces for debugging.
//! In pure architecture, kernel.ts handles phase ordering.
//!
//! Laws:
//! 1. All functions are pure (return new data)
//! 2. Metrics are immutable snapshots
//! 3. Traces are append-only immutable arrays
//! 4. Phase order validation is deterministic
//!
//! Ported from: frontends/web/composition-engine/kernel/timeline.ts

use super::types::{FrameMetrics, FrameTrace, FrameTraceEvent, Phase};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================================
// Constants
// ============================================================================

/// Canonical phase execution order
pub const PHASE_ORDER: &[Phase] = &[
    Phase::Input,
    Phase::Fsm,
    Phase::Context,
    Phase::Layout,
    Phase::Scene,
    Phase::Semantics,
    Phase::Render,
];

/// Default phase budgets in milliseconds (targeting 60fps = 16.67ms total)
pub fn default_budgets() -> HashMap<Phase, f64> {
    let mut budgets = HashMap::new();
    budgets.insert(Phase::Input, 2.0);
    budgets.insert(Phase::Fsm, 2.0);
    budgets.insert(Phase::Context, 2.0);
    budgets.insert(Phase::Layout, 4.0);
    budgets.insert(Phase::Scene, 2.0);
    budgets.insert(Phase::Semantics, 2.0);
    budgets.insert(Phase::Render, 4.0);
    budgets
}

// ============================================================================
// Trace Functions
// ============================================================================

/// Record an event in the trace
pub fn record_event(trace: &FrameTrace, event: FrameTraceEvent) -> FrameTrace {
    let mut new_trace = trace.clone();
    new_trace.push(event);
    new_trace
}

/// Begin an undo group in the trace
pub fn begin_undo_group(trace: &FrameTrace, label: Option<String>) -> FrameTrace {
    let mut new_trace = trace.clone();
    new_trace.push(FrameTraceEvent::UndoBegin { label });
    new_trace
}

/// End an undo group in the trace
pub fn end_undo_group(trace: &FrameTrace) -> FrameTrace {
    let mut new_trace = trace.clone();
    new_trace.push(FrameTraceEvent::UndoEnd);
    new_trace
}

/// Create an empty trace
pub fn init_trace() -> FrameTrace {
    Vec::new()
}

/// Clear a trace (for replay scenarios)
pub fn clear_trace() -> FrameTrace {
    Vec::new()
}

// ============================================================================
// Metrics Functions
// ============================================================================

/// Initialize frame metrics
pub fn init_metrics() -> FrameMetrics {
    FrameMetrics {
        frame_count: 0,
        total_time: 0.0,
        phase_timings: HashMap::new(),
        dropped_frames: 0,
    }
}

/// Record phase timing
pub fn record_phase(metrics: &FrameMetrics, phase: Phase, duration: f64) -> FrameMetrics {
    let mut phase_timings = metrics.phase_timings.clone();
    let timings = phase_timings.entry(phase).or_default();

    // Keep last 60 frames for averaging
    let mut new_timings = timings.clone();
    new_timings.push(duration);
    if new_timings.len() > 60 {
        new_timings.remove(0);
    }

    phase_timings.insert(phase, new_timings);

    FrameMetrics {
        frame_count: metrics.frame_count,
        total_time: metrics.total_time,
        phase_timings,
        dropped_frames: metrics.dropped_frames,
    }
}

/// Complete a frame
pub fn complete_frame(
    metrics: &FrameMetrics,
    frame_duration: f64,
    target_frame_time: f64,
) -> FrameMetrics {
    let dropped = if frame_duration > target_frame_time {
        metrics.dropped_frames + 1
    } else {
        metrics.dropped_frames
    };

    FrameMetrics {
        frame_count: metrics.frame_count + 1,
        total_time: metrics.total_time + frame_duration,
        phase_timings: metrics.phase_timings.clone(),
        dropped_frames: dropped,
    }
}

/// Complete a frame with default target (16.67ms for 60fps)
pub fn complete_frame_default(metrics: &FrameMetrics, frame_duration: f64) -> FrameMetrics {
    complete_frame(metrics, frame_duration, 16.67)
}

/// Reset metrics to initial state
pub fn reset_metrics() -> FrameMetrics {
    init_metrics()
}

// ============================================================================
// Metrics Queries
// ============================================================================

/// Get average frame time
pub fn get_average_frame_time(metrics: &FrameMetrics) -> f64 {
    if metrics.frame_count == 0 {
        return 0.0;
    }
    metrics.total_time / metrics.frame_count as f64
}

/// Get average phase time
pub fn get_average_phase_time(metrics: &FrameMetrics, phase: Phase) -> f64 {
    match metrics.phase_timings.get(&phase) {
        Some(timings) if !timings.is_empty() => {
            let sum: f64 = timings.iter().sum();
            sum / timings.len() as f64
        }
        _ => 0.0,
    }
}

/// Get current FPS
pub fn get_current_fps(metrics: &FrameMetrics) -> f64 {
    let avg_frame_time = get_average_frame_time(metrics);
    if avg_frame_time == 0.0 {
        return 0.0;
    }
    1000.0 / avg_frame_time
}

/// Get frame drop percentage
pub fn get_drop_percentage(metrics: &FrameMetrics) -> f64 {
    if metrics.frame_count == 0 {
        return 0.0;
    }
    (metrics.dropped_frames as f64 / metrics.frame_count as f64) * 100.0
}

/// Phase timing summary
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhaseSummary {
    pub avg: f64,
    pub max: f64,
    pub min: f64,
}

/// Get phase performance summary
pub fn get_phase_summary(metrics: &FrameMetrics) -> HashMap<Phase, PhaseSummary> {
    let mut summary = HashMap::new();

    for (phase, timings) in &metrics.phase_timings {
        if timings.is_empty() {
            continue;
        }

        let avg = timings.iter().sum::<f64>() / timings.len() as f64;
        let max = timings.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let min = timings.iter().cloned().fold(f64::INFINITY, f64::min);

        summary.insert(*phase, PhaseSummary { avg, max, min });
    }

    summary
}

/// Get last timing for a phase
pub fn get_last_phase_timing(metrics: &FrameMetrics, phase: Phase) -> f64 {
    match metrics.phase_timings.get(&phase) {
        Some(timings) if !timings.is_empty() => *timings.last().unwrap(),
        _ => 0.0,
    }
}

// ============================================================================
// Phase Validation
// ============================================================================

/// Get the index of a phase in the execution order
pub fn get_phase_index(phase: Phase) -> Option<usize> {
    PHASE_ORDER.iter().position(|&p| p == phase)
}

/// Check if phase A should run before phase B
pub fn is_phase_order_valid(current: Phase, next: Phase) -> bool {
    match (get_phase_index(current), get_phase_index(next)) {
        (Some(current_idx), Some(next_idx)) => next_idx > current_idx,
        _ => false,
    }
}

/// Validate that phases are in correct order
pub fn validate_phase_sequence(phases: &[Phase]) -> bool {
    for window in phases.windows(2) {
        if !is_phase_order_valid(window[0], window[1]) {
            return false;
        }
    }
    true
}

// ============================================================================
// Budget Tracking
// ============================================================================

/// Check if a phase exceeded its budget
pub fn is_over_budget(duration: f64, phase: Phase, budgets: &HashMap<Phase, f64>) -> bool {
    match budgets.get(&phase) {
        Some(&budget) => duration > budget,
        None => false,
    }
}

/// Check if a phase exceeded its budget using default budgets
pub fn is_over_budget_default(duration: f64, phase: Phase) -> bool {
    is_over_budget(duration, phase, &default_budgets())
}

/// Get phases that are over budget based on metrics
pub fn get_over_budget_phases(metrics: &FrameMetrics, budgets: &HashMap<Phase, f64>) -> Vec<Phase> {
    let mut result = Vec::new();

    for &phase in PHASE_ORDER {
        let avg = get_average_phase_time(metrics, phase);
        if let Some(&budget) = budgets.get(&phase) {
            if avg > budget {
                result.push(phase);
            }
        }
    }

    result
}

/// Get phases that are over budget using default budgets
pub fn get_over_budget_phases_default(metrics: &FrameMetrics) -> Vec<Phase> {
    get_over_budget_phases(metrics, &default_budgets())
}

/// Check if frame is within total budget (targeting 60fps)
pub fn is_within_frame_budget(metrics: &FrameMetrics, target_frame_time: f64) -> bool {
    let avg_frame_time = get_average_frame_time(metrics);
    avg_frame_time <= target_frame_time
}

/// Check if frame is within budget using default target (16.67ms)
pub fn is_within_frame_budget_default(metrics: &FrameMetrics) -> bool {
    is_within_frame_budget(metrics, 16.67)
}

// ============================================================================
// Performance Report
// ============================================================================

/// Phase detail in performance report
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhaseDetail {
    pub avg: f64,
    pub budget: f64,
    pub over_budget: bool,
}

/// Comprehensive performance report
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PerformanceReport {
    pub fps: f64,
    pub avg_frame_time: f64,
    pub dropped_frames: u64,
    pub drop_percentage: f64,
    pub phases: HashMap<Phase, PhaseDetail>,
    pub healthy: bool,
}

/// Generate a comprehensive performance report
pub fn get_performance_report(
    metrics: &FrameMetrics,
    budgets: &HashMap<Phase, f64>,
    target_frame_time: f64,
) -> PerformanceReport {
    let mut phases = HashMap::new();

    for &phase in PHASE_ORDER {
        let avg = get_average_phase_time(metrics, phase);
        let budget = budgets.get(&phase).copied().unwrap_or(0.0);
        phases.insert(
            phase,
            PhaseDetail {
                avg,
                budget,
                over_budget: avg > budget,
            },
        );
    }

    let avg_frame_time = get_average_frame_time(metrics);
    let drop_percentage = get_drop_percentage(metrics);

    PerformanceReport {
        fps: get_current_fps(metrics),
        avg_frame_time,
        dropped_frames: metrics.dropped_frames,
        drop_percentage,
        phases,
        healthy: avg_frame_time <= target_frame_time && drop_percentage < 5.0,
    }
}

/// Generate a performance report with default settings
pub fn get_performance_report_default(metrics: &FrameMetrics) -> PerformanceReport {
    get_performance_report(metrics, &default_budgets(), 16.67)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_metrics() {
        let metrics = init_metrics();
        assert_eq!(metrics.frame_count, 0);
        assert_eq!(metrics.total_time, 0.0);
        assert!(metrics.phase_timings.is_empty());
        assert_eq!(metrics.dropped_frames, 0);
    }

    #[test]
    fn test_record_phase() {
        let metrics = init_metrics();
        let metrics = record_phase(&metrics, Phase::Layout, 3.5);

        let timings = metrics.phase_timings.get(&Phase::Layout).unwrap();
        assert_eq!(timings.len(), 1);
        assert_eq!(timings[0], 3.5);
    }

    #[test]
    fn test_record_phase_rolling_window() {
        let mut metrics = init_metrics();

        // Record 65 timings - should keep only last 60
        for i in 0..65 {
            metrics = record_phase(&metrics, Phase::Layout, i as f64);
        }

        let timings = metrics.phase_timings.get(&Phase::Layout).unwrap();
        assert_eq!(timings.len(), 60);
        assert_eq!(timings[0], 5.0); // First 5 should be removed
        assert_eq!(*timings.last().unwrap(), 64.0);
    }

    #[test]
    fn test_complete_frame() {
        let metrics = init_metrics();
        let metrics = complete_frame(&metrics, 15.0, 16.67);
        assert_eq!(metrics.frame_count, 1);
        assert_eq!(metrics.total_time, 15.0);
        assert_eq!(metrics.dropped_frames, 0);

        let metrics = complete_frame(&metrics, 20.0, 16.67);
        assert_eq!(metrics.frame_count, 2);
        assert_eq!(metrics.total_time, 35.0);
        assert_eq!(metrics.dropped_frames, 1);
    }

    #[test]
    fn test_get_average_frame_time() {
        let metrics = init_metrics();
        assert_eq!(get_average_frame_time(&metrics), 0.0);

        let metrics = FrameMetrics {
            frame_count: 10,
            total_time: 150.0,
            phase_timings: HashMap::new(),
            dropped_frames: 0,
        };
        assert_eq!(get_average_frame_time(&metrics), 15.0);
    }

    #[test]
    fn test_get_average_phase_time() {
        let mut phase_timings = HashMap::new();
        phase_timings.insert(Phase::Layout, vec![2.0, 3.0, 4.0, 5.0, 6.0]);

        let metrics = FrameMetrics {
            frame_count: 5,
            total_time: 80.0,
            phase_timings,
            dropped_frames: 0,
        };

        assert_eq!(get_average_phase_time(&metrics, Phase::Layout), 4.0);
        assert_eq!(get_average_phase_time(&metrics, Phase::Input), 0.0); // No data
    }

    #[test]
    fn test_get_current_fps() {
        let metrics = FrameMetrics {
            frame_count: 60,
            total_time: 1000.0, // 60 frames in 1000ms = 16.67ms/frame
            phase_timings: HashMap::new(),
            dropped_frames: 0,
        };

        let fps = get_current_fps(&metrics);
        assert!((fps - 60.0).abs() < 0.1);
    }

    #[test]
    fn test_get_drop_percentage() {
        let metrics = FrameMetrics {
            frame_count: 100,
            total_time: 1670.0,
            phase_timings: HashMap::new(),
            dropped_frames: 5,
        };

        assert_eq!(get_drop_percentage(&metrics), 5.0);
    }

    #[test]
    fn test_phase_order_validation() {
        assert!(is_phase_order_valid(Phase::Input, Phase::Fsm));
        assert!(is_phase_order_valid(Phase::Layout, Phase::Render));
        assert!(!is_phase_order_valid(Phase::Render, Phase::Input));
        assert!(!is_phase_order_valid(Phase::Layout, Phase::Layout)); // Same phase

        assert!(validate_phase_sequence(&[
            Phase::Input,
            Phase::Fsm,
            Phase::Context
        ]));
        assert!(!validate_phase_sequence(&[
            Phase::Fsm,
            Phase::Input,
            Phase::Context
        ]));
    }

    #[test]
    fn test_budget_tracking() {
        let budgets = default_budgets();

        assert!(is_over_budget(5.0, Phase::Layout, &budgets)); // Budget is 4.0
        assert!(!is_over_budget(3.0, Phase::Layout, &budgets));
    }

    #[test]
    fn test_performance_report() {
        let mut metrics = init_metrics();
        metrics = record_phase(&metrics, Phase::Layout, 3.0);
        metrics = record_phase(&metrics, Phase::Render, 3.0);
        metrics = complete_frame(&metrics, 15.0, 16.67);
        metrics = complete_frame(&metrics, 15.0, 16.67);

        let report = get_performance_report_default(&metrics);

        assert!(report.healthy);
        assert!(report.fps > 0.0);
        assert_eq!(report.dropped_frames, 0);
    }

    #[test]
    fn test_trace_operations() {
        let trace = init_trace();
        assert!(trace.is_empty());

        let trace = record_event(&trace, FrameTraceEvent::Layout);
        assert_eq!(trace.len(), 1);

        let trace = begin_undo_group(&trace, Some("test".to_string()));
        assert_eq!(trace.len(), 2);

        let trace = end_undo_group(&trace);
        assert_eq!(trace.len(), 3);
    }

    #[test]
    fn test_get_phase_summary() {
        let mut phase_timings = HashMap::new();
        phase_timings.insert(Phase::Layout, vec![2.0, 4.0, 6.0]);

        let metrics = FrameMetrics {
            frame_count: 3,
            total_time: 48.0,
            phase_timings,
            dropped_frames: 0,
        };

        let summary = get_phase_summary(&metrics);
        let layout_summary = summary.get(&Phase::Layout).unwrap();

        assert_eq!(layout_summary.avg, 4.0);
        assert_eq!(layout_summary.min, 2.0);
        assert_eq!(layout_summary.max, 6.0);
    }
}
