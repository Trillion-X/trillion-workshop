// Portable public TLS owner. DNS API credentials travel only through the vault and SSH stdin.
//
// Every fact about one server is the run's input: its name (hostname), address and pinned key (knownHost), the port
// its connection to the engine listens on (remotePort), the receptionist build it runs (receptionistBinary) and its
// layout (`host`: where the host owner lives, its state folder, its services and accounts, the receptionist's build
// pattern, address, paths and environment, the downloads folder and the site whose pages the host hands on). The
// engine hands the server's administration key as a file (credential_mounts mount_path) and the DNS key on descriptor
// 3; this file names no product, no vault and no schedule (renewal is a wake the person declares).
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { administrationArguments, heldKeyFile, knownHostsLine } from '../../administer-a-rented-host/do-work/administration-arguments.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

import * as core from './renew-a-tls-certificate-core.mjs';
core.useSharedOwners({ administrationArguments, heldKeyFile, knownHostsLine, makeHashCodeHexFromBytes });
export * from './renew-a-tls-certificate-core.mjs';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) core.runCLI();
