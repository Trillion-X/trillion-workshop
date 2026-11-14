// Author the emergent domains as pure DATA over the GENERIC visual-database primitive.
// Each domain = one entity-type trio + one generic board carrier record
// (`kind:"board"` at `package::visual-database::board::<slug>`) holding
// its own `visual-database.fields` and `visual-database.views` DATA, the SAME
// grammar a consumer things-file ships. ZERO new code per domain.
// Run: node author-emergent-configs.mjs [--dry-run]   (studio must be up; partition bitfield-studio)
import { createTargetBasisClient } from '/Users/example/dev/bitfield-runtime-kit/references/background-runner-shell/scripts/target-basis.mjs';
import { applyCurrentStateWritesLive, readCurrent } from '/Users/example/dev/bitfield-runtime-kit/references/background-runner-shell/scripts/apply-current-state-writes-live.mjs';
import { EMERGENT_CONFIGS, domainWrites } from './emergent-configs.mjs';
const SHELL = process.env.BITFIELD_SHELL_URL ?? 'http://127.0.0.1:3012';
const P = 'bitfield-studio';
const dryRun = process.argv.includes('--dry-run');
const client = createTargetBasisClient(SHELL);

const writes = EMERGENT_CONFIGS.flatMap(([slug, label, stages, extras]) => domainWrites(slug, label, stages, extras));

console.log('configs:', EMERGENT_CONFIGS.length, 'writes:', writes.length);
if (dryRun) process.exit(0);
const BATCH = 20;
let ok = 0;
for (let i = 0; i < writes.length; i += BATCH) {
  const slice = writes.slice(i, i + BATCH).map(w => ({ partition_label: P, ...w }));
  const r = await applyCurrentStateWritesLive({ shellUrl: SHELL, request: { partition_label: P, writes: slice }, fillExpectedCurrent: true });
  ok += r.ok ? slice.length : 0;
  console.log(`batch ${i / BATCH}: ok=${r.ok} (${slice.length})`);
  if (!r.ok) for (const v of r.verification.filter(v => !v.ok)) console.log('FAIL', JSON.stringify(v).slice(0, 150));
}
// readback receipts — every board is a GENERIC kind:"board" carrier
let found = 0;
for (const [slug] of EMERGENT_CONFIGS) {
  const b = await readCurrent(client, { partition_label: P, address_label: `package::visual-database::board::${slug}`, address_mode: 'identity_text' }).catch(() => null);
  if (b?.payload?.kind === 'board') found += 1;
  else console.log('MISSING readback:', slug);
}
console.log(`readback receipts: ${found}/${EMERGENT_CONFIGS.length} generic kind:"board" carriers live`);
