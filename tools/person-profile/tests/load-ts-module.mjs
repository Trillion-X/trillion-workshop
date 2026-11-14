import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export async function loadTsModule(path) {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    external: ['node:*'],
  });
  const code = result.outputFiles[0].text;
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return import(url);
}

export function packageFile(path) {
  return new URL(path, pathToFileURL(`${process.cwd()}/`).href).pathname;
}
