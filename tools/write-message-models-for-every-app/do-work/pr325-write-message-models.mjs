// tools/write-message-models-for-every-app/do-work/write-message-models.mjs
//
// Moved from Trillion-X/trillion scripts/device-bridge-models.mjs.
// Writes the device message models from one models file: Swift for the Mac app and the iPhone app, and a
// TypeScript declaration. `--check` exits 1 when a written file is behind its source; `--write` (the default) brings
// them up to date. Nothing here names a model or a field: they are the rows.
// Usage: node write-message-models.mjs --models <models.json> [--root <folder the target files are under>] [--check|--write]
// (the old copy read one fixed file of its own repository; the models file and the root are now the caller's.)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const option = name => { const at = process.argv.indexOf(name); return at === -1 ? null : process.argv[at + 1] ?? null; };
const SOURCE = option('--models') ?? 'models.json';
const ROOT = resolve(option('--root') ?? dirname(resolve(SOURCE)));
const swiftScalar = { String: 'String', Int: 'Int', Bool: 'Bool' };
const tsScalar = { String: 'string', Int: 'number', Bool: 'boolean' };
const HEADER = `generated from ${SOURCE} by write-message-models.mjs; change the rows there and run the script, never this file`;

export function renderSwift(spec, target) {
  const named = spec.targets[target];
  const typeOf = (type, optional) => {
    const inner = Array.isArray(type) ? `[${named.names[type[0]]}]` : swiftScalar[type] ?? named.names[type];
    return optional ? `${inner}?` : inner;
  };
  const blocks = spec.models.filter(model => named.names[model.name]).map(model => {
    const conforms = [...named.protocols, ...(named.identifiable.includes(model.name) ? ['Identifiable'] : [])].join(', ');
    const fields = model.fields.map(field => `    ${field.mutable ? 'var' : 'let'} ${field.name}: ${typeOf(field.type, field.optional)}`).join('\n');
    return `/// ${model.doc}\nstruct ${named.names[model.name]}: ${conforms} {\n${fields}\n}`;
  });
  return `// ${HEADER}\nimport Foundation\n\n${blocks.join('\n\n')}\n`;
}

export function renderTypescript(spec) {
  const typeOf = type => (Array.isArray(type) ? `${typeOf(type[0])}[]` : tsScalar[type] ?? type);
  const blocks = spec.models.map(model => `/** ${model.doc} */\nexport interface ${model.name} {\n${model.fields.map(field => `  ${field.name}${field.optional ? '?' : ''}: ${typeOf(field.type)};`).join('\n')}\n}`);
  return `// ${HEADER}\n\n${blocks.join('\n\n')}\n`;
}

export function outputs(spec = JSON.parse(readFileSync(resolve(SOURCE), 'utf8'))) {
  return [
    { file: spec.targets.mac.file, text: renderSwift(spec, 'mac') },
    { file: spec.targets.ios.file, text: renderSwift(spec, 'ios') },
    { file: spec.targets.typescript.file, text: renderTypescript(spec) },
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const behind = [];
  for (const { file, text } of outputs()) {
    let have = null;
    try { have = readFileSync(join(ROOT, file), 'utf8'); } catch { /* not written yet */ }
    if (have === text) continue;
    behind.push(file);
    if (!process.argv.includes('--check')) { mkdirSync(dirname(join(ROOT, file)), { recursive: true }); writeFileSync(join(ROOT, file), text); }
  }
  if (process.argv.includes('--check')) {
    if (behind.length) { process.stderr.write(`Behind ${SOURCE}: ${behind.join(', ')}. Run: node write-message-models.mjs --models ${SOURCE} --write\n`); process.exit(1); }
  } else process.stdout.write(behind.length ? `Wrote ${behind.join(', ')}\n` : 'Up to date.\n');
}
