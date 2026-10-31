import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderRecordPublicationProjection } from './render-public-page.mjs';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [envelopePath, outputPath] = process.argv.slice(2);
  if (!envelopePath) {
    console.error('Give the path of the envelope file: node render-public-page-cli.mjs ENVELOPE.json [OUTPUT.html]');
    process.exit(1);
  }
  try {
    const output = renderRecordPublicationProjection(JSON.parse(readFileSync(envelopePath, 'utf8')));
    if (outputPath) {
      writeFileSync(outputPath, output.artifact.bytes);
      const { bytes, ...facts } = output.artifact;
      console.log(JSON.stringify({ artifact: { ...facts, byte_length: Buffer.byteLength(bytes) }, proof: output.proof, written: outputPath }));
    } else {
      console.log(JSON.stringify(output));
    }
  } catch (error) {
    console.error(`The page could not be written: ${error.message}. Check that the envelope is JSON with publication_descriptor and source_record.`);
    process.exit(1);
  }
}
