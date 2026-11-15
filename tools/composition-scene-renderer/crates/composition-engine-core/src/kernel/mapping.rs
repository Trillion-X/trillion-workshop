//! crates/composition-engine-core/src/kernel/mapping.rs
//!
//! Pure number transforms. No side effects, no dependencies.
//!
//! Ported from: frontends/web/composition-engine/kernel/mapping.ts

// ============================================================================
// Clamping & Snapping
// ============================================================================

/// Clamp value between min and max (inclusive)
#[inline]
pub fn clamp(x: f64, min: f64, max: f64) -> f64 {
    x.max(min).min(max)
}

/// Snap value to nearest multiple of step
#[inline]
pub fn snap(x: f64, step: f64) -> f64 {
    if step <= 0.0 || !step.is_finite() {
        return x;
    }
    (x / step).round() * step
}

// ============================================================================
// Linear Interpolation
// ============================================================================

/// Linear interpolation: lerp(a, b, 0) = a, lerp(a, b, 1) = b
#[inline]
pub fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// Inverse linear interpolation: find t such that lerp(a, b, t) = value
#[inline]
pub fn inverse_lerp(a: f64, b: f64, value: f64) -> f64 {
    if a == b {
        return 0.0;
    }
    (value - a) / (b - a)
}

// ============================================================================
// Range Mapping
// ============================================================================

/// Map value from one range to another
#[inline]
pub fn remap(x: f64, from_min: f64, from_max: f64, to_min: f64, to_max: f64) -> f64 {
    lerp(to_min, to_max, inverse_lerp(from_min, from_max, x))
}

/// Map value from one range to another (clamped to output range)
#[inline]
pub fn remap_clamped(x: f64, from_min: f64, from_max: f64, to_min: f64, to_max: f64) -> f64 {
    lerp(
        to_min,
        to_max,
        clamp(inverse_lerp(from_min, from_max, x), 0.0, 1.0),
    )
}

// ============================================================================
// Floating Point Utilities
// ============================================================================

/// Check approximate equality (for floating point comparisons)
#[inline]
pub fn approx_equal(a: f64, b: f64, epsilon: f64) -> bool {
    (a - b).abs() <= epsilon
}

/// Check approximate equality with default epsilon (1e-6)
#[inline]
pub fn approx_equal_default(a: f64, b: f64) -> bool {
    approx_equal(a, b, 1e-6)
}

/// Round to a specific number of decimal places
#[inline]
pub fn round_to(value: f64, decimals: u32) -> f64 {
    let factor = 10_f64.powi(decimals as i32);
    (value * factor).round() / factor
}

// ============================================================================
// Smoothstep Functions
// ============================================================================

/// Smoothstep interpolation (ease in/out) for t in [0, 1]
/// Uses Hermite interpolation: 3t^2 - 2t^3
#[inline]
pub fn smoothstep(t: f64) -> f64 {
    let tc = clamp(t, 0.0, 1.0);
    tc * tc * (3.0 - 2.0 * tc)
}

/// Smoother step interpolation (Ken Perlin's version)
/// Uses: 6t^5 - 15t^4 + 10t^3
#[inline]
pub fn smootherstep(t: f64) -> f64 {
    let tc = clamp(t, 0.0, 1.0);
    tc * tc * tc * (tc * (tc * 6.0 - 15.0) + 10.0)
}

// ============================================================================
// Function Composition (Generic)
// ============================================================================

/// Compose functions left-to-right: compose([f, g])(x) = g(f(x))
///
/// # Example
/// ```
/// use composition_engine_core::kernel::mapping::compose;
///
/// let double = |x: f64| x * 2.0;
/// let add_one = |x: f64| x + 1.0;
/// let composed = compose(vec![double, add_one]);
/// assert_eq!(composed(5.0), 11.0); // (5 * 2) + 1 = 11
/// ```
pub fn compose(fns: Vec<fn(f64) -> f64>) -> impl Fn(f64) -> f64 {
    move |x: f64| fns.iter().fold(x, |v, f| f(v))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clamp() {
        assert_eq!(clamp(5.0, 0.0, 10.0), 5.0);
        assert_eq!(clamp(-5.0, 0.0, 10.0), 0.0);
        assert_eq!(clamp(15.0, 0.0, 10.0), 10.0);
        assert_eq!(clamp(0.0, 0.0, 10.0), 0.0);
        assert_eq!(clamp(10.0, 0.0, 10.0), 10.0);
    }

    #[test]
    fn test_snap() {
        assert_eq!(snap(7.0, 5.0), 5.0);
        assert_eq!(snap(8.0, 5.0), 10.0);
        assert_eq!(snap(2.5, 5.0), 5.0);
        assert_eq!(snap(2.4, 5.0), 0.0);
        // Edge cases
        assert_eq!(snap(5.0, 0.0), 5.0);
        assert_eq!(snap(5.0, -1.0), 5.0);
    }

    #[test]
    fn test_lerp() {
        assert_eq!(lerp(0.0, 10.0, 0.0), 0.0);
        assert_eq!(lerp(0.0, 10.0, 1.0), 10.0);
        assert_eq!(lerp(0.0, 10.0, 0.5), 5.0);
        assert_eq!(lerp(10.0, 20.0, 0.25), 12.5);
    }

    #[test]
    fn test_inverse_lerp() {
        assert_eq!(inverse_lerp(0.0, 10.0, 0.0), 0.0);
        assert_eq!(inverse_lerp(0.0, 10.0, 10.0), 1.0);
        assert_eq!(inverse_lerp(0.0, 10.0, 5.0), 0.5);
        assert_eq!(inverse_lerp(10.0, 10.0, 5.0), 0.0); // Same endpoints
    }

    #[test]
    fn test_remap() {
        // Map 5 from [0,10] to [0,100]
        assert_eq!(remap(5.0, 0.0, 10.0, 0.0, 100.0), 50.0);
        // Map 2 from [0,10] to [100,200]
        assert_eq!(remap(2.0, 0.0, 10.0, 100.0, 200.0), 120.0);
    }

    #[test]
    fn test_remap_clamped() {
        // Value within range
        assert_eq!(remap_clamped(5.0, 0.0, 10.0, 0.0, 100.0), 50.0);
        // Value below range
        assert_eq!(remap_clamped(-5.0, 0.0, 10.0, 0.0, 100.0), 0.0);
        // Value above range
        assert_eq!(remap_clamped(15.0, 0.0, 10.0, 0.0, 100.0), 100.0);
    }

    #[test]
    fn test_approx_equal() {
        assert!(approx_equal(1.0, 1.0000001, 1e-6));
        assert!(!approx_equal(1.0, 1.001, 1e-6));
        assert!(approx_equal_default(1.0, 1.0000001));
    }

    #[test]
    fn test_round_to() {
        assert_eq!(round_to(3.14159, 2), 3.14);
        assert_eq!(round_to(3.145, 2), 3.15);
        assert_eq!(round_to(3.14159, 0), 3.0);
        assert_eq!(round_to(3.5, 0), 4.0);
    }

    #[test]
    fn test_smoothstep() {
        assert_eq!(smoothstep(0.0), 0.0);
        assert_eq!(smoothstep(1.0), 1.0);
        assert_eq!(smoothstep(0.5), 0.5);
        // Out of range values are clamped
        assert_eq!(smoothstep(-1.0), 0.0);
        assert_eq!(smoothstep(2.0), 1.0);
    }

    #[test]
    fn test_smootherstep() {
        assert_eq!(smootherstep(0.0), 0.0);
        assert_eq!(smootherstep(1.0), 1.0);
        assert!(approx_equal(smootherstep(0.5), 0.5, 1e-10));
        // Out of range values are clamped
        assert_eq!(smootherstep(-1.0), 0.0);
        assert_eq!(smootherstep(2.0), 1.0);
    }

    #[test]
    fn test_compose() {
        let double = |x: f64| x * 2.0;
        let add_one = |x: f64| x + 1.0;
        let composed = compose(vec![double, add_one]);
        assert_eq!(composed(5.0), 11.0); // (5 * 2) + 1 = 11

        let composed2 = compose(vec![add_one, double]);
        assert_eq!(composed2(5.0), 12.0); // (5 + 1) * 2 = 12
    }
}
