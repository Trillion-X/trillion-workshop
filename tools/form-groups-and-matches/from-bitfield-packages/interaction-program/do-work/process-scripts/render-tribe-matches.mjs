// packages/interaction-program/do-work/process-scripts/render-tribe-matches.mjs
//
// Render leaf (T4): AI tribe-match items -> a destination-descriptor for the Matches tab.
// Pure + blind: reads matches.json (the ai-records-producer.result items[] — each
// {members:[name,name], score:0-100, rationale}) and writes descriptor.json (the
// destination-descriptor payload the Matches surface renders). It owns NO scoring and
// NO storage — it maps scored pairs into the surface's card contract, nothing more.
//
// Run: node render-tribe-matches.mjs <matches.json> <descriptor.json>
//
// Card contract (from the live descriptor): sections[].items[] =
//   { title:"<m0>  ✕  <m1>", chip:"<score>% match", detail:<rationale>, color:<hex>, tone }
// Color/tone are a pure function of score (a data threshold, not a per-instance branch):
// score is a universal 0-100 measure; the band -> {color,tone} map is the only Society here.

import { readFileSync, writeFileSync } from "node:fs";

const BANDS = [
  { min: 90, color: "#3fb27f", tone: "success" }, // strong complementary
  { min: 75, color: "#7c6cf0", tone: "success" }, // good
  { min: 60, color: "#e0a340", tone: "info" },    // moderate
  { min: 0,  color: "#8a8f98", tone: "neutral" }, // weak
];

function band(score) {
  const s = Number.isFinite(score) ? score : 0;
  return BANDS.find((b) => s >= b.min) ?? BANDS[BANDS.length - 1];
}

function matchItems(raw) {
  // Accept the ai-records-producer.result shape ({items:[...]}), a bare array, or
  // {records:[{payload:{items}}]} — read the first array of match-like objects found.
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.items)) return raw.items;
  if (raw && Array.isArray(raw.records)) {
    for (const r of raw.records) {
      const p = r && r.payload ? r.payload : r;
      if (p && Array.isArray(p.items)) return p.items;
    }
  }
  return [];
}

function card(m) {
  const members = Array.isArray(m.members) ? m.members : [];
  const m0 = String(members[0] ?? "").trim();
  const m1 = String(members[1] ?? "").trim();
  const score = Math.round(Number(m.score));
  const b = band(score);
  return {
    title: m1 ? `${m0}  ✕  ${m1}` : m0,
    chip: Number.isFinite(score) ? `${score}% match` : "match",
    detail: String(m.rationale ?? m.detail ?? m.text ?? "").trim(),
    color: b.color,
    tone: b.tone,
  };
}

function main(argv) {
  const inPath = argv[2];
  const outPath = argv[3];
  if (!inPath || !outPath) {
    process.stderr.write("usage: render-tribe-matches.mjs <matches.json> <descriptor.json>\n");
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(inPath, "utf8"));
  const cycle = typeof raw.cycle === "string" ? raw.cycle : "live";
  const items = matchItems(raw)
    .map(card)
    .filter((c) => c.title) // drop malformed pairs (no members)
    .sort((a, b) => (parseInt(b.chip) || 0) - (parseInt(a.chip) || 0)); // best first

  const descriptor = {
    kind: "destination-descriptor",
    id: "destination-descriptor:tribe-matches",
    ref: "destination:tribe-matches",
    cycle,
    program_id: "weekly-matchmaker",
    provenance: "llm:claude-oneshot",
    partition_key: "runtime-partition",
    sections: [{ items }],
  };
  writeFileSync(outPath, JSON.stringify(descriptor, null, 2));
  process.stdout.write(`[render-tribe-matches] rendered ${items.length} cards for cycle ${cycle}\n`);
}

try {
  main(process.argv);
} catch (err) {
  try {
    const out = process.argv[3];
    if (out) writeFileSync(out, JSON.stringify({ error: String((err && err.message) || err) }));
  } catch { /* ignore */ }
  process.stderr.write(`render-tribe-matches: ${(err && err.stack) || err}\n`);
  process.exit(1);
}
