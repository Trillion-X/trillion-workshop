// tools/office-files/do-work/describe-presentation-runtime-surface.mjs
//
// PURPOSE: Print the property names the presentation runtime exposes on one
// slide, one shape's text object, and the speaker-notes object, so the edit
// owner is written against the real accessor names rather than guessed ones.
// Read-only: opens a deck, prints, exits.
//
// Run: node describe-presentation-runtime-surface.mjs <runtimeModule> <deck.pptx>

import process from "node:process";
import path from "node:path";

const [runtimeModule, deckPath] = process.argv.slice(2);
if (!runtimeModule || !deckPath) {
  console.error("usage: <runtimeModule> <deck.pptx>");
  process.exit(1);
}
const { FileBlob, PresentationFile } = await import(path.resolve(runtimeModule));
const deck = await PresentationFile.importPptx(await FileBlob.load(deckPath));
const slide = deck.slides.getItem(0);
const shape = Array.from(slide.shapes.items).find((s) => s.text);

function names(obj) {
  const out = new Set();
  let cur = obj;
  while (cur && cur !== Object.prototype) {
    for (const n of Object.getOwnPropertyNames(cur)) out.add(n);
    cur = Object.getPrototypeOf(cur);
  }
  return [...out].filter((n) => n !== "constructor").sort();
}

console.log(JSON.stringify({
  slide: names(slide),
  shape: shape ? names(shape) : null,
  shapeText: shape ? names(shape.text) : null,
  shapeTextString: shape ? String(shape.text?.text ?? shape.text?.toString?.() ?? "") : null,
  speakerNotes: names(slide.speakerNotes),
  speakerNotesText: String(slide.speakerNotes.text ?? ""),
  notesTextFrame: names(slide.speakerNotes.textFrame),
}, null, 1));
