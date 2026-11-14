import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

export async function loadTsModule(relativePath) {
  const entryPoint = fileURLToPath(new URL(relativePath, import.meta.url));
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2022',
    write: false,
    external: ['@bitfield/runtime-kit'],
  });
  const contextRequire = (specifier) => {
    if (specifier === '@bitfield/runtime-kit') return { sendRequestToBitfieldTarget: async () => ({}) };
    // Builder-only tests never execute owner targets; keep their transport surface inert.
    if (specifier === '@bitfield/runtime-kit/protocol') return {
      buildEngineReadCurrentRequestFromLabels: () => { throw new Error('builder test invoked engine read'); },
      buildEngineWriteBatchRequestFromLabels: () => { throw new Error('builder test invoked engine write'); },
      decodeEngineReadCurrentReply: () => { throw new Error('builder test decoded engine reply'); },
    };
    return require(specifier);
  };
  const context = { exports: {}, module: { exports: {} }, require: contextRequire, console, TextEncoder, TextDecoder };
  context.exports = context.module.exports;
  vm.runInNewContext(result.outputFiles[0].text, context);
  return context.module.exports;
}

export async function readPackageFile(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}
