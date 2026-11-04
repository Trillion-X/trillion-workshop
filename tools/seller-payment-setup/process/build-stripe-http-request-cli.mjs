// Explicit command-line entry. The request assembler remains inert when
// imported or bundled into another host; this command only constructs bytes.
import { readCliInput } from './read-cli-input.mjs';
import { buildStripeHttpRequest } from './build-stripe-http-request.mjs';

const input = readCliInput(process.argv.slice(2));
process.stdout.write(`${JSON.stringify(buildStripeHttpRequest(input))}\n`);
