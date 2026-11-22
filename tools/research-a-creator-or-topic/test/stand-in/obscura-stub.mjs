#!/usr/bin/env node
// Stands in for the Obscura browser in tests: writes a small PNG to the --screenshot path, or exits 1 for an address
// that contains "unreachable".
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const url = args[1];
const file = args[args.indexOf('--screenshot') + 1];
if (url.includes('unreachable')) process.exit(1);
writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
