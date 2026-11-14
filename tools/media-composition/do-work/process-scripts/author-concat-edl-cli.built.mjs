// author-concat-edl-cli.mjs
import { readFileSync, writeFileSync } from "node:fs";

// ../author-concat-edl.mjs
function authorConcatEdl(input = {}) {
  const { baseArtifact: baseArtifact2, windows: windows2 = [], encode: encode2, idPrefix: idPrefix2 = "h" } = input;
  if (!baseArtifact2) throw new Error("[author-concat-edl] baseArtifact is required");
  const valid = [];
  const skipped = [];
  windows2.forEach((w, index) => {
    const start = Number(w?.start);
    const end = Number(w?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      skipped.push({ index, reason: "invalid-window" });
      return;
    }
    valid.push({ start, end, overlaySource: w.overlaySource });
  });
  valid.sort((a, b) => a.start - b.start);
  const round = (n) => +n.toFixed(4);
  const segments = valid.map((w, n) => ({
    id: `${idPrefix2}${n}`,
    kind: "base_span",
    src_in: round(w.start),
    src_out: round(w.end)
  }));
  const overlays = [];
  valid.forEach((w, n) => {
    if (typeof w.overlaySource === "string" && w.overlaySource !== "") {
      overlays.push({ id: `ov${n}`, source: w.overlaySource, at_src: round(w.start), end_src: round(w.end) });
    }
  });
  const edl = {
    ...encode2 ? { encode: encode2 } : {},
    base: { kind: "video", artifact: baseArtifact2 },
    spine: { segments },
    ...overlays.length ? { overlays } : {}
  };
  return {
    edl,
    segmentCount: segments.length,
    skipped,
    totalDurationS: round(segments.reduce((s, seg) => s + (seg.src_out - seg.src_in), 0))
  };
}

// author-concat-edl-cli.mjs
console.log = (...args) => process.stderr.write(args.map(String).join(" ") + "\n");
console.info = console.log;
console.debug = console.log;
function parseArgs(argv) {
  const flags2 = {};
  const positional2 = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      flags2[a.slice(2)] = argv[i + 1] ?? "";
      i += 1;
    } else positional2.push(a);
  }
  return { flags: flags2, positional: positional2 };
}
var { flags, positional } = parseArgs(process.argv.slice(2));
var windows;
var baseArtifact;
var encode;
var idPrefix;
if (flags["windows-json"] !== void 0 || flags["base-artifact"] !== void 0) {
  windows = JSON.parse(flags["windows-json"] ?? "[]");
  baseArtifact = flags["base-artifact"];
  if (flags["encode-json"]) encode = JSON.parse(flags["encode-json"]);
  if (flags["id-prefix"]) idPrefix = flags["id-prefix"];
} else {
  windows = JSON.parse(readFileSync(positional[0], "utf8"));
  baseArtifact = positional[1];
}
var result = authorConcatEdl({ baseArtifact, windows, ...encode ? { encode } : {}, ...idPrefix ? { idPrefix } : {} });
var json = JSON.stringify(result);
if (flags["output-json"]) writeFileSync(flags["output-json"], json);
else process.stdout.write(json + "\n");
