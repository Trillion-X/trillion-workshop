// crates/workflow/tests/monte_carlo_marketing.rs
//
// Purpose:
//   Monte Carlo simulation for marketing campaign optimization.
//   Runs 10,000 iterations, each sampling random persona weights within
//   defined ranges, scoring all 1,000 campaign combinations (10 headlines ×
//   5 tones × 4 CTAs × 5 channels) across 6 personas, then reports win
//   frequencies — which combos dominate per-persona, cross-persona, and
//   by business value.
//
// Scoring formula (per persona):
//   headline_score = sum(headline_vec[d] * persona_weight[d]) / 100.0
//   tone_score     = sum(tone_vec[d]     * persona_weight[d]) / 100.0
//   cta_score      = persona_cta[cta]    / 10.0
//   channel_score  = persona_channel[ch] / 10.0
//   total          = headline_score + tone_score + cta_score + channel_score
//   bv             = total * market_size * avg_ltv / 1000.0
//
// This test is pure Rust math (Physics). No EEAF backend needed.

use rand::RngExt;
use std::collections::HashMap;

// ─── Dimensions ──────────────────────────────────────────────────────────────

const DIMS: usize = 10;

// ─── Personas ─────────────────────────────────────────────────────────────────

struct Persona {
    name: &'static str,
    /// (min, max) inclusive for each of 10 dimensions
    weight_ranges: [(f64, f64); DIMS],
    market_size: f64,
    avg_ltv: f64,
    cta_scores: [f64; 4],     // audit, consult, workshop, quiz
    channel_scores: [f64; 5], // instagram, facebook, email, youtube, landing
}

fn personas() -> Vec<Persona> {
    vec![
        Persona {
            name: "Frustrated Technician",
            weight_ranges: [
                (7.0, 10.0), // pain
                (5.0, 9.0),  // engineering
                (4.0, 8.0),  // urgency
                (3.0, 7.0),  // aspiration
                (1.0, 5.0),  // status
                (2.0, 6.0),  // roi
                (5.0, 9.0),  // fear
                (3.0, 7.0),  // empathy
                (1.0, 5.0),  // premium
                (4.0, 8.0),  // challenge
            ],
            market_size: 1000.0,
            avg_ltv: 5000.0,
            cta_scores: [9.0, 5.0, 4.0, 6.0],
            channel_scores: [6.0, 5.0, 4.0, 8.0, 7.0],
        },
        Persona {
            name: "Proactive Architect",
            weight_ranges: [
                (2.0, 6.0),  // pain
                (6.0, 10.0), // engineering
                (3.0, 7.0),  // urgency
                (5.0, 9.0),  // aspiration
                (3.0, 7.0),  // status
                (7.0, 10.0), // roi
                (5.0, 9.0),  // fear
                (2.0, 6.0),  // empathy
                (4.0, 8.0),  // premium
                (1.0, 5.0),  // challenge
            ],
            market_size: 600.0,
            avg_ltv: 15000.0,
            cta_scores: [7.0, 9.0, 5.0, 4.0],
            channel_scores: [4.0, 8.0, 6.0, 5.0, 7.0],
        },
        Persona {
            name: "Adult Champion",
            weight_ranges: [
                (3.0, 7.0),  // pain
                (4.0, 8.0),  // engineering
                (1.0, 5.0),  // urgency
                (5.0, 9.0),  // aspiration
                (7.0, 10.0), // status
                (3.0, 7.0),  // roi
                (1.0, 5.0),  // fear
                (1.0, 4.0),  // empathy
                (7.0, 10.0), // premium
                (5.0, 9.0),  // challenge
            ],
            market_size: 400.0,
            avg_ltv: 8000.0,
            cta_scores: [6.0, 8.0, 3.0, 4.0],
            channel_scores: [5.0, 4.0, 6.0, 5.0, 9.0],
        },
        Persona {
            name: "Time-Crunched Grinder",
            weight_ranges: [
                (5.0, 9.0),  // pain
                (3.0, 7.0),  // engineering
                (8.0, 10.0), // urgency
                (4.0, 8.0),  // aspiration
                (2.0, 6.0),  // status
                (3.0, 7.0),  // roi
                (7.0, 10.0), // fear
                (2.0, 6.0),  // empathy
                (1.0, 5.0),  // premium
                (3.0, 7.0),  // challenge
            ],
            market_size: 500.0,
            avg_ltv: 3000.0,
            cta_scores: [9.0, 5.0, 3.0, 6.0],
            channel_scores: [8.0, 4.0, 3.0, 7.0, 5.0],
        },
        Persona {
            name: "Club Legend",
            weight_ranges: [
                (2.0, 6.0),  // pain
                (1.0, 5.0),  // engineering
                (3.0, 7.0),  // urgency
                (3.0, 7.0),  // aspiration
                (8.0, 10.0), // status
                (1.0, 5.0),  // roi
                (4.0, 8.0),  // fear
                (1.0, 4.0),  // empathy
                (6.0, 10.0), // premium
                (7.0, 10.0), // challenge
            ],
            market_size: 300.0,
            avg_ltv: 6000.0,
            cta_scores: [5.0, 8.0, 3.0, 2.0],
            channel_scores: [4.0, 7.0, 5.0, 4.0, 6.0],
        },
        Persona {
            name: "Second-Chance Parent",
            weight_ranges: [
                (4.0, 8.0),  // pain
                (3.0, 7.0),  // engineering
                (5.0, 9.0),  // urgency
                (6.0, 10.0), // aspiration
                (1.0, 5.0),  // status
                (5.0, 9.0),  // roi
                (7.0, 10.0), // fear
                (6.0, 10.0), // empathy
                (2.0, 6.0),  // premium
                (1.0, 5.0),  // challenge
            ],
            market_size: 700.0,
            avg_ltv: 12000.0,
            cta_scores: [9.0, 6.0, 5.0, 4.0],
            channel_scores: [5.0, 9.0, 5.0, 6.0, 6.0],
        },
    ]
}

// ─── Headlines ────────────────────────────────────────────────────────────────

fn headlines() -> Vec<(&'static str, [f64; DIMS])> {
    vec![
        ("pain", [10.0, 3.0, 4.0, 2.0, 1.0, 2.0, 6.0, 5.0, 1.0, 3.0]),
        (
            "aspiration",
            [2.0, 3.0, 2.0, 10.0, 4.0, 3.0, 1.0, 4.0, 5.0, 3.0],
        ),
        (
            "fear_urgency",
            [5.0, 2.0, 9.0, 2.0, 2.0, 4.0, 10.0, 3.0, 1.0, 3.0],
        ),
        (
            "authority",
            [3.0, 8.0, 2.0, 5.0, 6.0, 4.0, 2.0, 2.0, 7.0, 2.0],
        ),
        (
            "challenge",
            [4.0, 3.0, 4.0, 5.0, 7.0, 2.0, 4.0, 1.0, 3.0, 10.0],
        ),
        (
            "curiosity",
            [3.0, 4.0, 3.0, 6.0, 3.0, 3.0, 3.0, 3.0, 3.0, 4.0],
        ),
        (
            "identity",
            [4.0, 3.0, 2.0, 6.0, 10.0, 3.0, 3.0, 2.0, 8.0, 5.0],
        ),
        (
            "engineering",
            [5.0, 10.0, 3.0, 4.0, 3.0, 5.0, 2.0, 2.0, 4.0, 3.0],
        ),
        ("roi", [3.0, 5.0, 4.0, 5.0, 3.0, 10.0, 5.0, 2.0, 4.0, 2.0]),
        (
            "social_proof",
            [3.0, 3.0, 3.0, 5.0, 5.0, 4.0, 3.0, 5.0, 5.0, 3.0],
        ),
    ]
}

// ─── Tones ────────────────────────────────────────────────────────────────────

fn tones() -> Vec<(&'static str, [f64; DIMS])> {
    vec![
        (
            "clinical",
            [4.0, 9.0, 3.0, 3.0, 3.0, 5.0, 3.0, 1.0, 4.0, 2.0],
        ),
        (
            "empathetic",
            [5.0, 2.0, 3.0, 5.0, 2.0, 2.0, 4.0, 10.0, 3.0, 1.0],
        ),
        (
            "provocative",
            [5.0, 3.0, 5.0, 4.0, 6.0, 3.0, 5.0, 1.0, 4.0, 9.0],
        ),
        (
            "urgent",
            [5.0, 3.0, 10.0, 3.0, 2.0, 4.0, 8.0, 3.0, 2.0, 4.0],
        ),
        (
            "premium",
            [2.0, 5.0, 2.0, 6.0, 8.0, 4.0, 2.0, 2.0, 10.0, 3.0],
        ),
    ]
}

// ─── Combo key ───────────────────────────────────────────────────────────────

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
struct Combo {
    headline: usize,
    tone: usize,
    cta: usize,
    channel: usize,
}

impl Combo {
    fn label(&self, headline_names: &[&'static str], tone_names: &[&'static str]) -> String {
        const CTA_NAMES: [&str; 4] = ["audit", "consult", "workshop", "quiz"];
        const CHANNEL_NAMES: [&str; 5] = ["instagram", "facebook", "email", "youtube", "landing"];
        format!(
            "{}|{}|{}|{}",
            headline_names[self.headline],
            tone_names[self.tone],
            CTA_NAMES[self.cta],
            CHANNEL_NAMES[self.channel],
        )
    }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

fn score(
    weights: &[f64; DIMS],
    headline_vec: &[f64; DIMS],
    tone_vec: &[f64; DIMS],
    cta_score: f64,
    channel_score: f64,
) -> f64 {
    let headline_score: f64 = headline_vec
        .iter()
        .zip(weights.iter())
        .map(|(h, w)| h * w)
        .sum::<f64>()
        / 100.0;
    let tone_score: f64 = tone_vec
        .iter()
        .zip(weights.iter())
        .map(|(t, w)| t * w)
        .sum::<f64>()
        / 100.0;
    headline_score + tone_score + cta_score / 10.0 + channel_score / 10.0
}

// ─── Win frequency tables ─────────────────────────────────────────────────────

struct WinCounts {
    per_persona: Vec<HashMap<Combo, u64>>, // [persona_idx] -> combo -> count
    cross_persona: HashMap<Combo, u64>,    // highest-avg-score combo across all personas
    business_value: HashMap<Combo, u64>,   // highest-total-BV combo
}

// ─── Test ─────────────────────────────────────────────────────────────────────

#[test]
fn monte_carlo_marketing() {
    const ITERATIONS: u64 = 10_000;

    let personas = personas();
    let headlines = headlines();
    let tones = tones();

    let n_headlines = headlines.len();
    let n_tones = tones.len();
    let n_ctas: usize = 4;
    let n_channels: usize = 5;
    let n_combos = n_headlines * n_tones * n_ctas * n_channels; // 10×5×4×5 = 1000

    // Enumerate all combos up front
    let mut combos: Vec<Combo> = Vec::with_capacity(n_combos);
    for h in 0..n_headlines {
        for t in 0..n_tones {
            for c in 0..n_ctas {
                for ch in 0..n_channels {
                    combos.push(Combo {
                        headline: h,
                        tone: t,
                        cta: c,
                        channel: ch,
                    });
                }
            }
        }
    }

    let mut win_counts = WinCounts {
        per_persona: (0..personas.len()).map(|_| HashMap::new()).collect(),
        cross_persona: HashMap::new(),
        business_value: HashMap::new(),
    };

    let mut rng = rand::rng();

    for _ in 0..ITERATIONS {
        // Sample random weights for each persona this iteration
        let sampled_weights: Vec<[f64; DIMS]> = personas
            .iter()
            .map(|p| {
                let mut w = [0.0f64; DIMS];
                for (d, value) in w.iter_mut().enumerate().take(DIMS) {
                    *value = rng.random_range(p.weight_ranges[d].0..=p.weight_ranges[d].1);
                }
                w
            })
            .collect();

        // Score all combos for all personas
        // scores[persona_idx][combo_idx] = (total_score, bv)
        let mut scores: Vec<Vec<(f64, f64)>> = vec![vec![(0.0, 0.0); n_combos]; personas.len()];

        for (pi, persona) in personas.iter().enumerate() {
            let weights = &sampled_weights[pi];
            for (ci, combo) in combos.iter().enumerate() {
                let total = score(
                    weights,
                    &headlines[combo.headline].1,
                    &tones[combo.tone].1,
                    persona.cta_scores[combo.cta],
                    persona.channel_scores[combo.channel],
                );
                let bv = total * persona.market_size * persona.avg_ltv / 1000.0;
                scores[pi][ci] = (total, bv);
            }
        }

        // Per-persona winner: combo with highest total_score for that persona
        for (pi, persona_scores) in scores.iter().enumerate() {
            let winner_idx = persona_scores
                .iter()
                .enumerate()
                .max_by(|a, b| a.1 .0.partial_cmp(&b.1 .0).unwrap())
                .map(|(i, _)| i)
                .unwrap();
            *win_counts.per_persona[pi]
                .entry(combos[winner_idx].clone())
                .or_insert(0) += 1;
        }

        // Cross-persona winner: combo with highest AVERAGE total_score across all personas
        let cross_winner_idx = (0..n_combos)
            .max_by(|&a, &b| {
                let avg_a: f64 =
                    scores.iter().map(|ps| ps[a].0).sum::<f64>() / personas.len() as f64;
                let avg_b: f64 =
                    scores.iter().map(|ps| ps[b].0).sum::<f64>() / personas.len() as f64;
                avg_a.partial_cmp(&avg_b).unwrap()
            })
            .unwrap();
        *win_counts
            .cross_persona
            .entry(combos[cross_winner_idx].clone())
            .or_insert(0) += 1;

        // Business value winner: combo with highest TOTAL BV across all personas
        let bv_winner_idx = (0..n_combos)
            .max_by(|&a, &b| {
                let bv_a: f64 = scores.iter().map(|ps| ps[a].1).sum::<f64>();
                let bv_b: f64 = scores.iter().map(|ps| ps[b].1).sum::<f64>();
                bv_a.partial_cmp(&bv_b).unwrap()
            })
            .unwrap();
        *win_counts
            .business_value
            .entry(combos[bv_winner_idx].clone())
            .or_insert(0) += 1;
    }

    // ── Print report ──────────────────────────────────────────────────────────

    let headline_names: Vec<&'static str> = headlines.iter().map(|(n, _)| *n).collect();
    let tone_names: Vec<&'static str> = tones.iter().map(|(n, _)| *n).collect();

    println!();
    println!("╔══════════════════════════════════════════════════════════════════╗");
    println!("║          MONTE CARLO MARKETING SIMULATION RESULTS               ║");
    println!("╚══════════════════════════════════════════════════════════════════╝");
    println!();
    println!("  Iterations : {:>10}", ITERATIONS);
    println!(
        "  Scorings   : {:>10}  ({} combos × {} personas × {} iterations)",
        n_combos as u64 * personas.len() as u64 * ITERATIONS,
        n_combos,
        personas.len(),
        ITERATIONS
    );
    println!();

    // Per-persona top 5
    println!("── PER-PERSONA WIN FREQUENCY (top 5) ─────────────────────────────");
    for (pi, persona) in personas.iter().enumerate() {
        let mut top: Vec<(&Combo, u64)> = win_counts.per_persona[pi]
            .iter()
            .map(|(k, &v)| (k, v))
            .collect();
        top.sort_by(|a, b| b.1.cmp(&a.1));
        top.truncate(5);

        println!();
        println!(
            "  {} (market={}, ltv={})",
            persona.name, persona.market_size as u32, persona.avg_ltv as u32
        );
        for (rank, (combo, wins)) in top.iter().enumerate() {
            let pct = *wins as f64 / ITERATIONS as f64 * 100.0;
            println!(
                "    #{} {:>5.1}%  {}",
                rank + 1,
                pct,
                combo.label(&headline_names, &tone_names)
            );
        }
    }

    // Cross-persona top 5
    println!();
    println!("── CROSS-PERSONA WIN FREQUENCY (top 5) ───────────────────────────");
    println!("   (combo with highest average score across all personas)");
    println!();
    let mut cross_top: Vec<(&Combo, u64)> = win_counts
        .cross_persona
        .iter()
        .map(|(k, &v)| (k, v))
        .collect();
    cross_top.sort_by(|a, b| b.1.cmp(&a.1));
    cross_top.truncate(5);
    for (rank, (combo, wins)) in cross_top.iter().enumerate() {
        let pct = *wins as f64 / ITERATIONS as f64 * 100.0;
        println!(
            "  #{} {:>5.1}%  {}",
            rank + 1,
            pct,
            combo.label(&headline_names, &tone_names)
        );
    }

    // Business value top 5
    println!();
    println!("── BUSINESS VALUE WIN FREQUENCY (top 5) ──────────────────────────");
    println!("   (combo with highest total BV = total × market_size × avg_ltv / 1000)");
    println!();
    let mut bv_top: Vec<(&Combo, u64)> = win_counts
        .business_value
        .iter()
        .map(|(k, &v)| (k, v))
        .collect();
    bv_top.sort_by(|a, b| b.1.cmp(&a.1));
    bv_top.truncate(5);
    for (rank, (combo, wins)) in bv_top.iter().enumerate() {
        let pct = *wins as f64 / ITERATIONS as f64 * 100.0;
        println!(
            "  #{} {:>5.1}%  {}",
            rank + 1,
            pct,
            combo.label(&headline_names, &tone_names)
        );
    }

    println!();
    println!("──────────────────────────────────────────────────────────────────");

    // Assertions: results are non-empty and sum to ITERATIONS
    let cross_total: u64 = win_counts.cross_persona.values().sum();
    let bv_total: u64 = win_counts.business_value.values().sum();
    assert_eq!(
        cross_total, ITERATIONS,
        "cross-persona wins must sum to iteration count"
    );
    assert_eq!(bv_total, ITERATIONS, "bv wins must sum to iteration count");
    for (pi, persona) in personas.iter().enumerate() {
        let persona_total: u64 = win_counts.per_persona[pi].values().sum();
        assert_eq!(
            persona_total, ITERATIONS,
            "per-persona wins for {} must sum to iteration count",
            persona.name
        );
    }
}
