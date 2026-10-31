// crates/pointillist-film-core/tests/composition_gauntlet.rs
//
// Cross-module tests for the pointillist film primitive.

use pointillist_film_core::{
    decode_frame, encode_frame, encode_target_animation, frame_at, make_grid, sample_rgba_source,
    scalar_field_value, scalar_field_value_with_context, vector_field_value, CellStyle,
    FieldProgram, FilmConfig, FilmFrameRequest, FilmScript, GridConfig, Matrix4Field, Rgba8,
    ScalarBinaryOp, ScalarContext, ScalarExpression, ScalarField, ScalarFieldCombiner,
    ScalarUnaryOp, TargetAnimationRequest, TargetFrame, TargetSample, TimelineSegment, VectorField,
};

fn small_config() -> FilmConfig {
    FilmConfig {
        grid: GridConfig {
            columns: 4,
            rows: 2,
            cell_gap_fraction: 0.1,
        },
        ..FilmConfig::default()
    }
}

#[test]
fn square_grid_cells_stay_inside_normalized_surface() {
    let config = small_config();
    let grid = make_grid(&config).unwrap();
    assert_eq!(grid.cells.len(), 8);
    for cell in grid.cells {
        assert!(cell.center_x > 0.0 && cell.center_x < 1.0);
        assert!(cell.center_y > 0.0 && cell.center_y < 1.0);
        assert!(cell.side > 0.0);
        assert!(cell.side <= 0.45);
    }
}

#[test]
fn frame_generation_blends_color_without_moving_cells() {
    let config = small_config();
    let red = CellStyle {
        color: Rgba8::new(255, 0, 0, 255),
        opacity: 1.0,
        scale: 1.0,
    };
    let blue = CellStyle {
        color: Rgba8::new(0, 0, 255, 255),
        opacity: 0.5,
        scale: 2.0,
    };
    let script = FilmScript {
        targets: vec![
            TargetFrame::solid(&config, red).unwrap(),
            TargetFrame::solid(&config, blue).unwrap(),
        ],
        segments: vec![TimelineSegment {
            start_seconds: 0.0,
            duration_seconds: 2.0,
            samples: transfer_samples(0, 1, input()),
        }],
    };

    let frame = frame_at(&script, &config, 1.0).unwrap();
    assert_eq!(frame.cells[0].cell_id, 0);
    assert_eq!(frame.cells[7].cell_id, 7);
    assert_eq!(frame.cells[0].color, Rgba8::new(128, 0, 128, 255));
    assert_eq!(frame.cells[0].opacity, 0.75);
    assert_eq!(frame.cells[0].scale, 1.5);
}

#[test]
fn scalar_weight_fields_hold_source_until_the_segment_boundary() {
    let config = small_config();
    let red = CellStyle {
        color: Rgba8::new(255, 0, 0, 255),
        opacity: 1.0,
        scale: 1.0,
    };
    let blue = CellStyle {
        color: Rgba8::new(0, 0, 255, 255),
        opacity: 1.0,
        scale: 1.0,
    };
    let script = FilmScript {
        targets: vec![
            TargetFrame::solid(&config, red).unwrap(),
            TargetFrame::solid(&config, blue).unwrap(),
        ],
        segments: vec![TimelineSegment {
            start_seconds: 0.0,
            duration_seconds: 1.0,
            samples: transfer_samples(0, 1, unary(ScalarUnaryOp::Floor, input())),
        }],
    };

    let before_cut = frame_at(&script, &config, 0.99).unwrap();
    let at_cut = frame_at(&script, &config, 1.0).unwrap();

    assert_eq!(before_cut.cells[0].color, red.color);
    assert_eq!(at_cut.cells[0].color, blue.color);
}

#[test]
fn rgba_source_sampling_produces_dense_grid_target() {
    let config = small_config();
    let pixels = vec![
        Rgba8::new(255, 0, 0, 255),
        Rgba8::new(0, 255, 0, 255),
        Rgba8::new(0, 0, 255, 128),
        Rgba8::new(255, 255, 255, 0),
    ];

    let target = sample_rgba_source(2, 2, &pixels, &config).unwrap();
    assert_eq!(target.cells.len(), 8);
    assert_eq!(target.cells[0].color, Rgba8::new(255, 0, 0, 255));
    assert_eq!(target.cells[3].color, Rgba8::new(0, 255, 0, 255));
    assert_eq!(target.cells[4].color, Rgba8::new(0, 0, 255, 128));
    assert_eq!(target.cells[7].opacity, 0.0);
}

#[test]
fn frame_wire_round_trips_canonical_bytes() {
    let config = small_config();
    let target = TargetFrame::solid(
        &config,
        CellStyle {
            color: Rgba8::new(20, 30, 40, 255),
            opacity: 0.8,
            scale: 1.25,
        },
    )
    .unwrap();
    let script = FilmScript {
        targets: vec![target],
        segments: vec![],
    };
    let frame = frame_at(&script, &config, 3.5).unwrap();
    let encoded = encode_frame(&frame, &config).unwrap();
    let decoded = decode_frame(&encoded, &config).unwrap();
    let encoded_again = encode_frame(&decoded, &config).unwrap();

    assert_eq!(frame, decoded);
    assert_eq!(encoded, encoded_again);
}

#[test]
fn frame_request_generates_canonical_packed_bytes() {
    let config = small_config();
    let target = TargetFrame::solid(
        &config,
        CellStyle {
            color: Rgba8::new(7, 8, 9, 255),
            opacity: 0.9,
            scale: 1.1,
        },
    )
    .unwrap();
    let request = FilmFrameRequest {
        config: config.clone(),
        script: FilmScript {
            targets: vec![target],
            segments: vec![],
        },
        time_seconds: 0.25,
    };

    let encoded = request.packed_frame_bytes().unwrap();
    let decoded = decode_frame(&encoded, &config).unwrap();

    assert_eq!(decoded.time_seconds, 0.25);
    assert_eq!(decoded.cells[0].color, Rgba8::new(7, 8, 9, 255));
}

#[test]
fn scalar_field_composes_expression_terms_without_domain_vocabulary() {
    let field = ScalarField {
        combiner: ScalarFieldCombiner::Max,
        terms: vec![
            compact_power_term(-1.0, 0.5, 0.25, 2.0),
            compact_power_term(0.0, 0.5, 1.0, 2.0),
            compact_power_term(1.0, 0.5, 0.25, 2.0),
        ],
    };

    assert_eq!(scalar_field_value(&field, 0.0).unwrap(), 1.0);
    assert_eq!(scalar_field_value(&field, -1.0).unwrap(), 0.25);
    assert_eq!(scalar_field_value(&field, 1.0).unwrap(), 0.25);
    assert_eq!(scalar_field_value(&field, 2.0).unwrap(), 0.0);
}

#[test]
fn scalar_field_reads_indexed_context_channels() {
    let field = ScalarField {
        combiner: ScalarFieldCombiner::Sum,
        terms: vec![binary(
            ScalarBinaryOp::Multiply,
            ScalarExpression::Channel { index: 1 },
            binary(
                ScalarBinaryOp::Subtract,
                ScalarExpression::Channel { index: 2 },
                ScalarExpression::Channel { index: 0 },
            ),
        )],
    };
    let context = ScalarContext {
        channels: vec![2.0, 3.0, 7.0],
    };

    assert_eq!(
        scalar_field_value_with_context(&field, &context).unwrap(),
        15.0
    );
}

#[test]
fn vector_field_composes_coordinate_displacement_without_domain_vocabulary() {
    let field = VectorField {
        x: ScalarField {
            combiner: ScalarFieldCombiner::Sum,
            terms: vec![binary(
                ScalarBinaryOp::Multiply,
                ScalarExpression::Channel { index: 0 },
                ScalarExpression::Channel { index: 1 },
            )],
        },
        y: ScalarField {
            combiner: ScalarFieldCombiner::Sum,
            terms: vec![binary(
                ScalarBinaryOp::Multiply,
                ScalarExpression::Channel { index: 0 },
                ScalarExpression::Channel { index: 2 },
            )],
        },
    };
    let context = ScalarContext {
        channels: vec![0.5, 12.0, -8.0],
    };

    let vector = vector_field_value(&field, &context).unwrap();
    assert_eq!(vector.x, 6.0);
    assert_eq!(vector.y, -4.0);
}

#[test]
fn field_program_composes_matrix_and_material_channels_without_domain_vocabulary() {
    let program = FieldProgram {
        matrix: Some(Matrix4Field {
            components: vec![
                field(ScalarExpression::Channel { index: 0 }),
                field(constant(0.0)),
                field(constant(0.0)),
                field(ScalarExpression::Channel { index: 3 }),
                field(constant(0.0)),
                field(ScalarExpression::Channel { index: 1 }),
                field(constant(0.0)),
                field(ScalarExpression::Channel { index: 4 }),
                field(constant(0.0)),
                field(constant(0.0)),
                field(ScalarExpression::Channel { index: 2 }),
                field(ScalarExpression::Channel { index: 5 }),
                field(constant(0.0)),
                field(constant(0.0)),
                field(constant(0.0)),
                field(constant(1.0)),
            ],
        }),
        components: pointillist_film_core::ComponentField {
            components: vec![
                field(ScalarExpression::Channel { index: 6 }),
                field(ScalarExpression::Channel { index: 7 }),
                field(binary(
                    ScalarBinaryOp::Multiply,
                    ScalarExpression::Channel { index: 8 },
                    ScalarExpression::Channel { index: 9 },
                )),
            ],
        },
    };
    let context = ScalarContext {
        channels: vec![2.0, 3.0, 4.0, 11.0, 13.0, 17.0, 0.25, 0.5, 0.75, 0.8],
    };

    let sample = pointillist_film_core::field_program_sample(&program, &context).unwrap();
    let matrix = sample.matrix.unwrap();

    assert_eq!(
        matrix.components,
        [2.0, 0.0, 0.0, 11.0, 0.0, 3.0, 0.0, 13.0, 0.0, 0.0, 4.0, 17.0, 0.0, 0.0, 0.0, 1.0,],
    );
    assert_eq!(sample.components, vec![0.25, 0.5, 0.6]);
}

#[test]
fn scalar_field_encodes_periodic_math_as_data() {
    let field = ScalarField {
        combiner: ScalarFieldCombiner::Sum,
        terms: vec![binary(
            ScalarBinaryOp::Multiply,
            constant(0.5),
            binary(
                ScalarBinaryOp::Add,
                constant(1.0),
                unary(
                    ScalarUnaryOp::Cosine,
                    binary(
                        ScalarBinaryOp::Multiply,
                        ScalarExpression::Input,
                        constant(6.0),
                    ),
                ),
            ),
        )],
    };

    let high = scalar_field_value(&field, 0.0).unwrap();
    let low = scalar_field_value(&field, std::f32::consts::PI / 6.0).unwrap();

    assert!(high > 0.99);
    assert!(low < 0.01);
}

fn compact_power_term(
    center: f32,
    half_width: f32,
    amplitude: f32,
    exponent: f32,
) -> ScalarExpression {
    binary(
        ScalarBinaryOp::Multiply,
        constant(amplitude),
        binary(
            ScalarBinaryOp::Power,
            binary(
                ScalarBinaryOp::Maximum,
                constant(0.0),
                binary(
                    ScalarBinaryOp::Subtract,
                    constant(1.0),
                    unary(
                        ScalarUnaryOp::Abs,
                        binary(
                            ScalarBinaryOp::Divide,
                            binary(
                                ScalarBinaryOp::Subtract,
                                ScalarExpression::Input,
                                constant(center),
                            ),
                            constant(half_width),
                        ),
                    ),
                ),
            ),
            constant(exponent),
        ),
    )
}

fn binary(op: ScalarBinaryOp, left: ScalarExpression, right: ScalarExpression) -> ScalarExpression {
    ScalarExpression::Binary {
        op,
        left: Box::new(left),
        right: Box::new(right),
    }
}

fn unary(op: ScalarUnaryOp, value: ScalarExpression) -> ScalarExpression {
    ScalarExpression::Unary {
        op,
        value: Box::new(value),
    }
}

fn field(term: ScalarExpression) -> ScalarField {
    ScalarField {
        combiner: ScalarFieldCombiner::Sum,
        terms: vec![term],
    }
}

fn constant(value: f32) -> ScalarExpression {
    ScalarExpression::Constant { value }
}

fn input() -> ScalarExpression {
    ScalarExpression::Input
}

fn transfer_samples(from: usize, to: usize, progress: ScalarExpression) -> Vec<TargetSample> {
    vec![
        TargetSample {
            target: from,
            weight: field(binary(
                ScalarBinaryOp::Subtract,
                constant(1.0),
                progress.clone(),
            )),
        },
        TargetSample {
            target: to,
            weight: field(progress),
        },
    ]
}

#[test]
fn target_animation_wire_encodes_targets_once() {
    let config = small_config();
    let first = TargetFrame::solid(
        &config,
        CellStyle {
            color: Rgba8::new(10, 20, 30, 255),
            opacity: 0.5,
            scale: 1.0,
        },
    )
    .unwrap();
    let second = TargetFrame::solid(
        &config,
        CellStyle {
            color: Rgba8::new(200, 210, 220, 128),
            opacity: 0.25,
            scale: 1.0,
        },
    )
    .unwrap();
    let bytes = encode_target_animation(&TargetAnimationRequest {
        config,
        script: FilmScript {
            targets: vec![first, second],
            segments: vec![TimelineSegment {
                start_seconds: 0.125,
                duration_seconds: 0.5,
                samples: transfer_samples(0, 1, input()),
            }],
        },
        frame_rate: 8,
    })
    .unwrap();

    assert_eq!(&bytes[0..4], b"PFAT");
    assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), 2);
    assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]), 4);
    assert_eq!(u16::from_le_bytes([bytes[8], bytes[9]]), 2);
    assert_eq!(u16::from_le_bytes([bytes[10], bytes[11]]), 2);
    assert_eq!(u16::from_le_bytes([bytes[12], bytes[13]]), 1);
    assert_eq!(u16::from_le_bytes([bytes[14], bytes[15]]), 8);
    assert_eq!(
        u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]),
        125,
    );
    assert_eq!(
        u32::from_le_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]),
        500,
    );
    assert_eq!(u16::from_le_bytes([bytes[24], bytes[25]]), 2);
    assert_eq!(bytes.len(), 16 + 31 + 2 * 8 * 4);
    assert_eq!(&bytes[47..51], &[10, 20, 30, 128]);
}

#[test]
fn target_animation_encodes_generic_scalar_weight_programs() {
    let config = small_config();
    let first = TargetFrame::solid(
        &config,
        CellStyle {
            color: Rgba8::new(10, 20, 30, 255),
            opacity: 0.5,
            scale: 1.0,
        },
    )
    .unwrap();
    let second = TargetFrame::solid(
        &config,
        CellStyle {
            color: Rgba8::new(200, 210, 220, 128),
            opacity: 0.25,
            scale: 1.0,
        },
    )
    .unwrap();
    let bytes = encode_target_animation(&TargetAnimationRequest {
        config,
        script: FilmScript {
            targets: vec![first, second],
            segments: vec![TimelineSegment {
                start_seconds: 0.0,
                duration_seconds: 0.25,
                samples: transfer_samples(0, 1, unary(ScalarUnaryOp::Floor, input())),
            }],
        },
        frame_rate: 8,
    })
    .unwrap();

    assert_eq!(u16::from_le_bytes([bytes[24], bytes[25]]), 2);
    assert_eq!(bytes[48], 3);
    assert_eq!(bytes[49], 5);
}

#[test]
fn validation_rejects_non_finite_cell_scale() {
    let config = small_config();
    let invalid = CellStyle {
        color: Rgba8::new(0, 0, 0, 255),
        opacity: 1.0,
        scale: f32::NAN,
    };

    assert!(TargetFrame::solid(&config, invalid).is_err());
}
