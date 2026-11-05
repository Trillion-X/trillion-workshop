// A stand-in for the one settings reader (tools/settings/read-data/settings-record.mjs) with its command's shape, so the
// voice A/B scripts' use of it is tested where that reader is not in the checkout: `settings-of --record FILE --folder F`
// prints the row's settings object as JSON, or exits 2 with the reason on stderr.
import { readFileSync } from 'node:fs';

const [verb, , file, , folder] = process.argv.slice(2);
const fail = (why) => { process.stderr.write(`${why}\n`); process.exit(2); };
if (verb !== 'settings-of') fail('only settings-of');
const row = JSON.parse(readFileSync(file, 'utf8'));
if (!row.id?.startsWith(`record:setting:${folder}~`)) fail(`${row.id} is not a setting of ${folder}`);
if (row.value?.status !== 'active') fail(`${row.id} is ${row.value?.status}`);
process.stdout.write(`${JSON.stringify(JSON.parse(row.value.settings))}\n`);
