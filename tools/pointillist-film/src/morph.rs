//! crates/pointillist-film-core/src/morph.rs
//!
//! Dense cell-style interpolation. Positions are not interpolated here; square
//! identity remains grid-owned.

use crate::config::StyleBounds;
use crate::palette::Rgba8;
use crate::target::CellStyle;
use crate::validation::{ensure_finite, FilmResult};

pub fn morph_style(from: CellStyle, to: CellStyle, t: f32) -> CellStyle {
    let t = t.clamp(0.0, 1.0);
    CellStyle {
        color: from.color.lerp(to.color, t),
        opacity: lerp_scalar(from.opacity, to.opacity, t),
        scale: lerp_scalar(from.scale, to.scale, t),
    }
}

pub fn lerp_scalar(from: f32, to: f32, t: f32) -> f32 {
    from + (to - from) * t.clamp(0.0, 1.0)
}

pub fn mix_styles<'a>(
    weighted_styles: impl IntoIterator<Item = (CellStyle, f32)> + 'a,
    bounds: &StyleBounds,
) -> FilmResult<CellStyle> {
    let mut r = 0.0;
    let mut g = 0.0;
    let mut b = 0.0;
    let mut a = 0.0;
    let mut opacity = 0.0;
    let mut scale = 0.0;

    for (style, weight) in weighted_styles {
        ensure_finite("timeline.sample.weight", weight)?;
        r += style.color.r as f32 * weight;
        g += style.color.g as f32 * weight;
        b += style.color.b as f32 * weight;
        a += style.color.a as f32 * weight;
        opacity += style.opacity * weight;
        scale += style.scale * weight;
    }

    ensure_finite("timeline.mix.red", r)?;
    ensure_finite("timeline.mix.green", g)?;
    ensure_finite("timeline.mix.blue", b)?;
    ensure_finite("timeline.mix.alpha", a)?;
    ensure_finite("timeline.mix.opacity", opacity)?;
    ensure_finite("timeline.mix.scale", scale)?;

    Ok(CellStyle {
        color: Rgba8::new(clamp_byte(r), clamp_byte(g), clamp_byte(b), clamp_byte(a)),
        opacity: opacity.clamp(bounds.min_opacity, bounds.max_opacity),
        scale: scale.clamp(bounds.min_scale, bounds.max_scale),
    })
}

pub fn color_from_rgb(r: u8, g: u8, b: u8) -> CellStyle {
    CellStyle {
        color: Rgba8::new(r, g, b, 255),
        opacity: 1.0,
        scale: 1.0,
    }
}

fn clamp_byte(value: f32) -> u8 {
    value.round().clamp(0.0, 255.0) as u8
}
