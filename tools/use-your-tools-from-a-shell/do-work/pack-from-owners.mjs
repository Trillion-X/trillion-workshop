#!/usr/bin/env node
// tools/use-your-tools-from-a-shell/do-work/pack-from-owners.mjs
//
// Writes the files this program carries from their owners (command.json `packs.files`): each owner's bytes, unchanged, to
// the place the program imports them from. Run it after an owner's file changes; nothing here is copied by hand. It is
// not an install file: the installed command only reads the packed bytes.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import settings from './command.json' with { type: 'json' };

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, '..', '..');

/** Copies every packed file from its owner; answers the packed paths written. */
export function packFromOwners({ rules = settings, tools = TOOLS, here = HERE } = {}) {
  return rules.packs.files.map(row => {
    const to = join(here, row.packed);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(tools, row.owner), to);
    return to;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) for (const path of packFromOwners()) process.stdout.write(`${path}\n`);
