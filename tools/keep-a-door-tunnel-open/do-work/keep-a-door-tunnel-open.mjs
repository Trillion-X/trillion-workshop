// Retained outbound service connection: one server-loopback listener, one loopback door on this computer, pinned host key.
// The dedicated credential stays in the vault and reaches SSH only on a private descriptor.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { administrationArguments, heldKeyFile, knownHostsLine } from '../../administer-a-rented-host/do-work/administration-arguments.mjs';

import * as core from './keep-a-door-tunnel-open-core.mjs';
core.useSharedOwners({ administrationArguments, heldKeyFile, knownHostsLine });
export * from './keep-a-door-tunnel-open-core.mjs';
if (typeof process !== 'undefined' && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await core.runCLI();
