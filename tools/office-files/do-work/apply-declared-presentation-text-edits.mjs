// tools/office-files/do-work/apply-declared-presentation-text-edits.mjs
//
// PURPOSE: Apply one declared edit request to a presentation file and write a
// new file. The request is DATA; this script knows no deck, no slide, no
// product. It reads a pptx through the artifact runtime, applies four kinds of
// edit, exports, then re-imports the output and prints what it reads back.
//
// NON-NEGOTIABLE INVARIANTS
// 1. The source file is never modified. The output path is written.
// 2. Every edit names an ORIGINAL slide index. `slide_order` is applied last,
//    so a request has one numbering.
// 3. `slide_order` must be a permutation of every slide, else the request is
//    refused whole; a silently dropped or doubled slide is worse than no edit.
// 4. A `replace_text` rule that matches nothing is reported as matched 0.
// 5. Readback is the proof: slide titles in final order and notes per slide.
//
// REQUEST (JSON):
//   {
//     "runtimeModule": "<absolute path to a module exporting FileBlob and PresentationFile>",
//     "source": "<in.pptx>", "output": "<out.pptx>",
//     "fonts": { "regular": "<typeface>", "bold": "<typeface>" },   // optional; a text item may also carry "typeface"
//     "slides": [
//       { "index": 3,                       // original 1-based index
//         "bg": "#171922",                  // optional; with "text"/"rect" the slide is rebuilt whole
//         "text": [{ "s": "...", "pos": {left,top,width,height}, "sz": 32, "b": true, "tc": "#fff", "a": "center", "va": "middle" }],
//         "rect": [{ "pos": {...}, "fill": "#...", "line": "#...", "lineW": 1, "radius": 12 }],
//         "replace_text": [{ "contains": "old headline", "with": "new headline" }],  // keeps every other shape
//         "notes": "speaker notes text" },
//       ...
//     ],
//     "delete": [1, 15],                    // original indices removed
//     "slide_order": [2, 3, 1, ...]         // original indices in the new order, MINUS deleted ones, every survivor once
//   }
//
// Run: node apply-declared-presentation-text-edits.mjs --request <request.json>

import process from "node:process";
import fs from "node:fs";
import path from "node:path";

const flag = process.argv.indexOf("--request");
if (flag < 0 || flag + 1 >= process.argv.length) {
  console.error("--request <path> required");
  process.exit(1);
}
const req = JSON.parse(fs.readFileSync(process.argv[flag + 1], "utf8"));
const { FileBlob, PresentationFile } = await import(path.resolve(req.runtimeModule));

const deck = await PresentationFile.importPptx(await FileBlob.load(req.source));
const original = Array.from(deck.slides.items);
const total = original.length;
const deleted = new Set(req.delete || []);

if (req.slide_order) {
  const survivors = [];
  for (let i = 1; i <= total; i++) if (!deleted.has(i)) survivors.push(i);
  const given = [...req.slide_order].sort((a, b) => a - b);
  const same = given.length === survivors.length && given.every((v, k) => v === survivors[k]);
  if (!same) {
    console.error(JSON.stringify({ refused: "slide_order must list every surviving original index exactly once", expected: survivors, got: req.slide_order }));
    process.exit(2);
  }
}

const report = [];
for (const d of req.slides || []) {
  const s = original[d.index - 1];
  if (!s) throw new Error(`Slide ${d.index} out of range 1..${total}`);
  const entry = { index: d.index };

  if (d.text || d.rect) {
    for (const el of Array.from(s.shapes.items)) el.delete();
    if (d.bg) s.background.fill = d.bg;
    for (const t of d.text || []) {
      const shape = s.shapes.add({ geometry: "textbox", position: t.pos, fill: "none", line: { style: "solid", fill: "none", width: 0 } });
      shape.text.set(t.s);
      shape.text.fontSize = t.sz || 24;
      shape.text.bold = !!t.b;
      shape.text.color = t.tc || "#f5f5f7";
      shape.text.alignment = t.a || "left";
      shape.text.verticalAlignment = t.va || "top";
      shape.text.autoFit = "shrinkText";
      const typeface = t.typeface ?? (t.b ? req.fonts?.bold : req.fonts?.regular);
      if (typeface) shape.text.typeface = typeface;
    }
    for (const r of d.rect || []) {
      const spec = { geometry: r.radius ? "roundRect" : "rect", position: r.pos, fill: r.fill, line: { style: "solid", fill: r.line || "none", width: r.lineW || 0 } };
      if (r.radius) spec.borderRadius = r.radius;
      s.shapes.add(spec);
    }
    entry.rebuilt = true;
  }

  if (d.replace_text) {
    entry.replace_text = [];
    for (const rule of d.replace_text) {
      let matched = 0;
      for (const shape of Array.from(s.shapes.items)) {
        let current = "";
        try { current = String(shape.text?.toString?.() ?? ""); } catch { continue; }
        if (current.includes(rule.contains)) {
          shape.text.set(rule.with);
          matched += 1;
        }
      }
      entry.replace_text.push({ contains: rule.contains, matched });
    }
  }

  if (typeof d.notes === "string") {
    s.speakerNotes.setText(d.notes);
    entry.notes = true;
  }
  report.push(entry);
}

for (const i of [...deleted].sort((a, b) => b - a)) original[i - 1].delete();

if (req.slide_order) {
  req.slide_order.forEach((origIndex, position) => original[origIndex - 1].moveTo(position));
}

await (await PresentationFile.exportPptx(deck)).save(req.output);

const back = await PresentationFile.importPptx(await FileBlob.load(req.output));
const readback = [];
for (let i = 0; i < back.slides.items.length; i++) {
  const slide = back.slides.getItem(i);
  let title = "";
  for (const shape of Array.from(slide.shapes.items)) {
    try { const t = String(shape.text?.toString?.() ?? ""); if (t.trim()) { title = t.trim().split("\n")[0].slice(0, 90); break; } } catch {}
  }
  let notes = "";
  try { notes = String(slide.speakerNotes.text ?? ""); } catch {}
  readback.push({ slide: i + 1, title, notes: notes.slice(0, 120) });
}
console.log(JSON.stringify({ output: req.output, slideCount: back.slides.items.length, edits: report, readback }, null, 1));
