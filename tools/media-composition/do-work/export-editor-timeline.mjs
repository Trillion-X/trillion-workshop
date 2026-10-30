/**
 * file: packages/media-composition/do-work/export-editor-timeline.mjs
 *
 * PURPOSE: Write an edit (the EDL contract) as a Final Cut Pro 7 XML (xmeml) timeline that Premiere Pro, DaVinci
 * Resolve and Final Cut import, so a person can finish the edit in their own editor. The translation is
 * export-xmeml.mjs's; this only reads the arguments and writes its XML to a file.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Sources are named as the person's editor will find them (absolute paths on their computer); nothing here
 *    opens a source, so the timeline can be made where the recordings are not.
 * 2. What the XML keeps and what it could not carry are returned (`retained`, `limitations`), never hidden.
 *
 * Usage: node export-editor-timeline.mjs --edl JSON --title TEXT --output FILE.xml [--source-metadata JSON]
 * Output (stdout, JSON): { sequence, retained, limitations, bytes }
 */
import { statSync, writeFileSync } from 'node:fs';
import { exportXmeml } from './export-xmeml.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let at = 2; at < process.argv.length; at += 2) args.set(process.argv[at].replace(/^--/, ''), process.argv[at + 1]);
  try {
    const output = args.get('output');
    if (!args.get('edl') || !output) throw new Error('usage: export-editor-timeline.mjs --edl JSON --title TEXT --output FILE.xml [--source-metadata JSON]');
    const parse = (name, fallback) => {
      if (!args.get(name)) return fallback;
      try { return JSON.parse(args.get(name)); } catch { throw new Error(`--${name} is not JSON.`); }
    };
    const { xml, support } = exportXmeml({ title: args.get('title') ?? 'Edit', edl: parse('edl'), sourceMetadata: parse('source-metadata', {}) });
    writeFileSync(output, xml);
    process.stdout.write(`${JSON.stringify({ sequence: support.sequence, retained: support.retained, limitations: support.limitations, bytes: statSync(output).size })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
