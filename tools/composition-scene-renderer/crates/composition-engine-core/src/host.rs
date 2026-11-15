//! crates/composition-engine-core/src/host.rs
//!
//! Host Adapters — Extended platform adapter interfaces.
//!
//! # Purpose
//! This module extends the basic Host trait (defined in kernel/types.rs) with
//! additional adapter interfaces for rendering, scheduling, text metrics, and
//! input handling. These form the complete contract that platform adapters
//! must implement.
//!
//! # Architecture
//! ```text
//! ┌─────────────────────────────────────────────────┐
//! │              Composition Engine                  │
//! │   (kernel, blueprint, resolver, bridges)         │
//! └──────────────────────┬──────────────────────────┘
//!                        │ uses traits
//!                        ▼
//! ┌─────────────────────────────────────────────────┐
//! │              Host Adapters (Traits)              │
//! │  RenderAdapter, SchedulerAdapter, InputAdapter   │
//! │  TextMetricsAdapter, FullHost                    │
//! └──────────────────────┬──────────────────────────┘
//!                        │ implemented by
//!                        ▼
//! ┌─────────────────────────────────────────────────┐
//! │           Platform Implementations               │
//! │  web-react/, ios/, android/, desktop/            │
//! └─────────────────────────────────────────────────┘
//! ```
//!
//! # Basic Host (kernel/types.rs)
//! Agent 1 defined the basic Host trait with:
//! - `now()` - Get current timestamp
//! - `raf()` - Request animation frame
//! - `measure_text()` - Measure text dimensions
//! - `dispatch_action()` - Execute side effects
//!
//! # Extended Adapters (this file)
//! This file adds specialized adapter traits for complex scenarios:
//! - `RenderAdapter` - Render immutable snapshots
//! - `SchedulerAdapter` - Timing primitives
//! - `TextMetricsAdapter` - Text measurement
//! - `InputAdapter` - Bridge OS/DOM events
//! - `FullHost` - Combines all adapters
//!
//! Ported from: frontends/web/composition-engine/host/i-host.ts

use crate::kernel::types::{SceneSnapshot, Size, ID};

// ============================================================================
// Render Adapter
// ============================================================================

/// Render Adapter — consumes immutable snapshots
///
/// Receives complete scene snapshots from the kernel and renders them
/// to the platform's native UI system (DOM, SwiftUI, Compose, etc.)
///
/// # Non-Negotiable Invariants
/// - Never mutates the snapshot
/// - Receives complete data each frame (no incremental updates)
/// - Unmount must clean up all resources
pub trait RenderAdapter: Send + Sync {
    /// Render a complete scene snapshot
    ///
    /// Called once per frame with new immutable data containing:
    /// - Immutable scene tree
    /// - Layout frames (Map<ID, LayoutFrame>)
    /// - Focus state
    /// - Semantic properties
    fn render(&self, snapshot: &SceneSnapshot);

    /// Clean up rendering resources
    ///
    /// Called when the composition engine is being torn down.
    /// Must release all platform resources (DOM nodes, views, etc.)
    fn unmount(&self);
}

// ============================================================================
// Scheduler Adapter
// ============================================================================

/// Unsubscribe callback type
pub type CancelRaf = Box<dyn FnOnce() + Send>;

/// Scheduler Adapter — provides timing primitives
///
/// Bridges the kernel's frame scheduling to the platform's animation system
/// (requestAnimationFrame, CADisplayLink, Choreographer, etc.)
pub trait SchedulerAdapter: Send + Sync {
    /// Request animation frame
    ///
    /// # Arguments
    /// * `callback` - Function to call on next frame with timestamp (ms)
    ///
    /// # Returns
    /// Cancel function to abort the request
    fn raf(&self, callback: Box<dyn FnOnce(f64) + Send>) -> CancelRaf;

    /// Get current high-resolution timestamp (milliseconds)
    fn now(&self) -> f64;
}

// ============================================================================
// Text Metrics Adapter
// ============================================================================

/// Font specification for text measurement
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FontSpec {
    pub family: Option<String>,
    pub size: Option<f64>,
    pub weight: Option<FontWeightSpec>,
}

/// Font weight specification
#[derive(Debug, Clone, PartialEq)]
pub enum FontWeightSpec {
    Numeric(u16),
    Named(String),
}

impl FontSpec {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_family(mut self, family: impl Into<String>) -> Self {
        self.family = Some(family.into());
        self
    }

    pub fn with_size(mut self, size: f64) -> Self {
        self.size = Some(size);
        self
    }

    pub fn with_weight_numeric(mut self, weight: u16) -> Self {
        self.weight = Some(FontWeightSpec::Numeric(weight));
        self
    }

    pub fn with_weight_named(mut self, weight: impl Into<String>) -> Self {
        self.weight = Some(FontWeightSpec::Named(weight.into()));
        self
    }
}

/// Text Metrics Adapter — measures text dimensions
///
/// Bridges text measurement to the platform's font/text system.
/// Required for proper layout of text nodes.
pub trait TextMetricsAdapter: Send + Sync {
    /// Measure text dimensions
    ///
    /// # Arguments
    /// * `text` - The text string to measure
    /// * `font` - Font specification (family, size, weight)
    ///
    /// # Returns
    /// Size containing width and height of the measured text
    fn measure(&self, text: &str, font: &FontSpec) -> Size;

    /// Measure text with line wrapping
    ///
    /// # Arguments
    /// * `text` - The text string to measure
    /// * `font` - Font specification
    /// * `max_width` - Maximum width before wrapping
    ///
    /// # Returns
    /// Size containing width and height after wrapping
    fn measure_wrapped(&self, text: &str, font: &FontSpec, _max_width: f64) -> Size {
        // Default implementation: ignore wrapping
        self.measure(text, font)
    }

    /// Get font metrics (line height, baseline, etc.)
    ///
    /// # Arguments
    /// * `font` - Font specification
    ///
    /// # Returns
    /// Font metrics for the specified font
    fn get_font_metrics(&self, font: &FontSpec) -> FontMetrics {
        // Default implementation: estimate from font size
        let size = font.size.unwrap_or(16.0);
        FontMetrics {
            line_height: size * 1.2,
            baseline: size * 0.8,
            cap_height: size * 0.7,
            x_height: size * 0.5,
        }
    }
}

/// Font metrics
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct FontMetrics {
    pub line_height: f64,
    pub baseline: f64,
    pub cap_height: f64,
    pub x_height: f64,
}

// ============================================================================
// Input Adapter
// ============================================================================

/// Input event from the platform
#[derive(Debug, Clone, PartialEq)]
pub struct PlatformInputEvent {
    pub event_type: PlatformInputType,
    pub timestamp: f64,
    pub target: Option<ID>,
    pub data: serde_json::Value,
}

/// Platform input event types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlatformInputType {
    PointerDown,
    PointerUp,
    PointerMove,
    PointerCancel,
    KeyDown,
    KeyUp,
    Wheel,
    Focus,
    Blur,
    Composition,
}

/// Input callback type
pub type InputCallback = Box<dyn Fn(PlatformInputEvent) + Send + Sync>;

/// Unsubscribe handle for input
pub type InputUnsubscribe = Box<dyn FnOnce() + Send>;

/// Input Adapter — bridges OS/DOM events to kernel Input bus
///
/// Translates platform-specific input events (DOM events, UIEvents, MotionEvents)
/// into the kernel's canonical input format.
pub trait InputAdapter: Send + Sync {
    /// Attach to a host element and start forwarding events
    ///
    /// # Arguments
    /// * `root_element` - Platform-specific root element (DOM Element, UIView, etc.)
    /// * `callback` - Function to call for each input event
    ///
    /// # Returns
    /// Unsubscribe handle to stop forwarding
    fn attach(&self, root_element: RootElement, callback: InputCallback) -> InputUnsubscribe;

    /// Detach and stop forwarding events
    fn detach(&self);

    /// Set pointer capture on a node
    fn set_pointer_capture(&self, pointer_id: u32, node_id: &ID);

    /// Release pointer capture
    fn release_pointer_capture(&self, pointer_id: u32);

    /// Check if pointer is captured by a node
    fn has_pointer_capture(&self, _pointer_id: u32, _node_id: &ID) -> bool {
        false
    }
}

/// Root element type (platform-specific)
///
/// This is opaque to the engine. Platform adapters know how to interpret it.
#[derive(Debug, Clone)]
pub enum RootElement {
    /// Opaque pointer/reference (cast to platform type in adapter)
    Opaque(usize),
    /// No root element (headless mode)
    None,
}

impl RootElement {
    /// Create from a raw pointer
    pub fn from_ptr<T>(ptr: *const T) -> Self {
        RootElement::Opaque(ptr as usize)
    }

    /// Cast to a raw pointer
    ///
    /// # Safety
    ///
    /// The caller must ensure the stored opaque address was originally created
    /// from a valid `*const T` and that the pointed-to value still outlives the
    /// returned pointer. This type does not own or validate the target memory.
    pub unsafe fn as_ptr<T>(&self) -> Option<*const T> {
        match self {
            RootElement::Opaque(addr) => Some(*addr as *const T),
            RootElement::None => None,
        }
    }
}

// ============================================================================
// Full Host Interface
// ============================================================================

/// Full Host interface combining all adapters
///
/// Platform implementations should provide a struct that implements this trait
/// by composing the individual adapter implementations.
///
/// # Example
/// ```ignore
/// struct WebHost {
///     render: WebRenderAdapter,
///     scheduler: WebSchedulerAdapter,
///     text_metrics: WebTextMetricsAdapter,
///     input: WebInputAdapter,
/// }
///
/// impl FullHost for WebHost {
///     fn render(&self) -> &dyn RenderAdapter { &self.render }
///     fn scheduler(&self) -> &dyn SchedulerAdapter { &self.scheduler }
///     fn text_metrics(&self) -> &dyn TextMetricsAdapter { &self.text_metrics }
///     fn input(&self) -> &dyn InputAdapter { &self.input }
/// }
/// ```
pub trait FullHost: Send + Sync {
    /// Get the render adapter
    fn render(&self) -> &dyn RenderAdapter;

    /// Get the scheduler adapter
    fn scheduler(&self) -> &dyn SchedulerAdapter;

    /// Get the text metrics adapter
    fn text_metrics(&self) -> &dyn TextMetricsAdapter;

    /// Get the input adapter
    fn input(&self) -> &dyn InputAdapter;
}

// ============================================================================
// Null/Mock Implementations (for testing)
// ============================================================================

/// Null render adapter (does nothing)
pub struct NullRenderAdapter;

impl RenderAdapter for NullRenderAdapter {
    fn render(&self, _snapshot: &SceneSnapshot) {}
    fn unmount(&self) {}
}

/// Null scheduler adapter (immediate execution)
pub struct NullSchedulerAdapter;

impl SchedulerAdapter for NullSchedulerAdapter {
    fn raf(&self, callback: Box<dyn FnOnce(f64) + Send>) -> CancelRaf {
        callback(0.0);
        Box::new(|| {})
    }

    fn now(&self) -> f64 {
        0.0
    }
}

/// Null text metrics adapter (fixed size)
pub struct NullTextMetricsAdapter;

impl TextMetricsAdapter for NullTextMetricsAdapter {
    fn measure(&self, text: &str, font: &FontSpec) -> Size {
        let char_width = font.size.unwrap_or(16.0) * 0.6;
        let line_height = font.size.unwrap_or(16.0) * 1.2;
        Size::new(text.len() as f64 * char_width, line_height)
    }
}

/// Null input adapter (no events)
pub struct NullInputAdapter;

impl InputAdapter for NullInputAdapter {
    fn attach(&self, _root_element: RootElement, _callback: InputCallback) -> InputUnsubscribe {
        Box::new(|| {})
    }

    fn detach(&self) {}

    fn set_pointer_capture(&self, _pointer_id: u32, _node_id: &ID) {}

    fn release_pointer_capture(&self, _pointer_id: u32) {}
}

/// Null full host (for testing)
pub struct NullHost {
    render: NullRenderAdapter,
    scheduler: NullSchedulerAdapter,
    text_metrics: NullTextMetricsAdapter,
    input: NullInputAdapter,
}

impl NullHost {
    pub fn new() -> Self {
        Self {
            render: NullRenderAdapter,
            scheduler: NullSchedulerAdapter,
            text_metrics: NullTextMetricsAdapter,
            input: NullInputAdapter,
        }
    }
}

impl Default for NullHost {
    fn default() -> Self {
        Self::new()
    }
}

impl FullHost for NullHost {
    fn render(&self) -> &dyn RenderAdapter {
        &self.render
    }

    fn scheduler(&self) -> &dyn SchedulerAdapter {
        &self.scheduler
    }

    fn text_metrics(&self) -> &dyn TextMetricsAdapter {
        &self.text_metrics
    }

    fn input(&self) -> &dyn InputAdapter {
        &self.input
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_font_spec_builder() {
        let font = FontSpec::new()
            .with_family("Inter")
            .with_size(16.0)
            .with_weight_numeric(700);

        assert_eq!(font.family, Some("Inter".to_string()));
        assert_eq!(font.size, Some(16.0));
        assert_eq!(font.weight, Some(FontWeightSpec::Numeric(700)));
    }

    #[test]
    fn test_null_text_metrics() {
        let adapter = NullTextMetricsAdapter;
        let font = FontSpec::new().with_size(16.0);

        let size = adapter.measure("hello", &font);
        assert!(size.w > 0.0);
        assert!(size.h > 0.0);
    }

    #[test]
    fn test_null_host() {
        let host = NullHost::new();

        // Can get all adapters
        let _ = host.render();
        let _ = host.scheduler();
        let _ = host.text_metrics();
        let _ = host.input();
    }

    #[test]
    fn test_root_element() {
        let element = RootElement::Opaque(12345);
        match element {
            RootElement::Opaque(addr) => assert_eq!(addr, 12345),
            _ => panic!("Expected Opaque"),
        }

        let none = RootElement::None;
        match none {
            RootElement::None => {}
            _ => panic!("Expected None"),
        }
    }
}
