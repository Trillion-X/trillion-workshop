// The record kinds the semantic index scripts read. The names are DATA in read-data/meaning-search.json (`kinds`);
// no script compares a row's kind to a literal. A renamed kind in that file is read everywhere at once.
import fs from "node:fs";

const SETTINGS = new URL("../../read-data/meaning-search.json", import.meta.url);

export const kinds = Object.freeze(JSON.parse(fs.readFileSync(SETTINGS, "utf-8")).kinds);
