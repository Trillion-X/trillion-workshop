// tools/check-against-a-persons-rules-and-verdicts/do-work/units-from-files.mjs
//
// A unit may name its words by a kept file instead of carrying them (`text_file`): the local path of a transcript
// the hearing tool kept in Files ({ text, segments }), placed in the run's folder by the engine from its identity, so a
// long recording's words never ride in a workflow step's answer (the wake book keeps each step answer, 1 MiB a record). The
// unit's text is the file's `text`; a unit that carries words keeps them (an empty `text` carries none), and an empty
// `text_file` (a step that heard nothing) names no file.
import { readFileSync } from 'node:fs';

export function unitsWithTextFiles(units, read = file => readFileSync(file, 'utf8')) {
  return units.map(unit => {
    if (!unit || typeof unit !== 'object' || !('text_file' in unit)) return unit;
    const { text_file: file, ...rest } = unit;
    if (typeof file !== 'string' || file === '' || (typeof rest.text === 'string' && rest.text !== '')) return rest;
    const kept = JSON.parse(read(file));
    if (typeof kept?.text !== 'string') throw new Error('The transcript file has no text.');
    return { ...rest, text: kept.text };
  });
}
