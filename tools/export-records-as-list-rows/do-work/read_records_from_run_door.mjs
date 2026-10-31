// Read one declared records source through the capability the Rust run handed this process on fd 3.
// The caller supplies only a records-door module path, type and optional id prefix; no credential is accepted.
import { pathToFileURL } from 'node:url';

const [clientPath, descriptorText, type, prefix] = process.argv.slice(2);
try {
  if (!clientPath || !descriptorText || !type) throw new Error('A records-door module, descriptor and record type are required.');
  const descriptor = Number(descriptorText);
  if (!Number.isInteger(descriptor) || (descriptor !== 0 && descriptor < 3)) throw new Error('The records descriptor must be an input pipe or an open file descriptor.');
  const { openRecordsDoor } = await import(pathToFileURL(clientPath).href);
  if (typeof openRecordsDoor !== 'function') throw new Error('The records-door module has no client.');
  const door = openRecordsDoor({ descriptor });
  const records = [];
  for await (const record of door.list({ type, ...(prefix === undefined ? {} : { prefix }) })) records.push(record);
  process.stdout.write(JSON.stringify(records));
} catch (error) {
  // The capability is never copied to an error path; RecordsDoorError messages are the door client's fixed words.
  const said = error && typeof error.message === 'string' ? error.message : 'The run records door could not answer.';
  process.stderr.write(`${said}\n`);
  process.exitCode = 2;
}
