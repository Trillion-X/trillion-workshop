// A stand-in for a gate program of the older command line: `node older-gate.mjs lines.txt --kind narrator --no-model`.
// It prints a FAIL block naming file:LINE for each line holding the made-up word "amazing", as the older gate did.
import { readFileSync } from 'node:fs';

const [file] = process.argv.slice(2);
readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
  if (/amazing/i.test(line)) console.log(`FAIL [narrator] ${file}:${index + 1}\n  no-amazing: "amazing". Say what it does.`);
});
console.log('done');
