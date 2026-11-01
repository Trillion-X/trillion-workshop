import { open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 500_000;
const MAX_OUTPUT_BYTES = 50_000_000;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function importMarkdownFile({ source_path, output_path, granted_folder, document_id }) {
  if (![source_path, output_path, granted_folder].every(value => typeof value === 'string' && value.length)) {
    throw new TypeError('source_path, output_path, and the granted folder are required.');
  }
  const root = await realpath(granted_folder);
  const source = path.resolve(root, source_path);
  const output = path.resolve(root, output_path);
  const actualSource = await realpath(source);
  const outputParent = await realpath(path.dirname(output));
  if (!inside(root, actualSource) || !inside(root, path.join(outputParent, path.basename(output))) || source === output) {
    throw new Error('Source and output paths must be different files inside the granted folder.');
  }
  const sourceHandle = await open(actualSource, 'r');
  let markdown;
  try {
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.size > MAX_INPUT_BYTES) throw new Error(`Markdown must be a regular file no larger than ${MAX_INPUT_BYTES} bytes.`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await sourceHandle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('Source changed while being read; retry with a stable file.');
      offset += bytesRead;
    }
    const after = await sourceHandle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Source changed while being read; retry with a stable file.');
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { await sourceHandle.close(); }
  // Load the parser only after the CLI has entered its error boundary. The native
  // computer runner may have an incomplete ancestor package tree; module-load
  // failures must be returned as actionable errors instead of Node's raw stack.
  const { importMarkdown } = await import('./import-markdown.mjs');
  const result = importMarkdown(markdown, document_id, { maxResultBytes: MAX_OUTPUT_BYTES });
  const bytes = Buffer.from(JSON.stringify(result));
  if (bytes.length > MAX_OUTPUT_BYTES) throw new Error(`Editable result exceeds ${MAX_OUTPUT_BYTES} bytes.`);
  const outputHandle = await open(output, 'wx', 0o600);
  try {
    await outputHandle.chmod(0o600);
    await outputHandle.writeFile(bytes);
    await outputHandle.sync();
  } catch (error) {
    await outputHandle.close();
    await unlink(output).catch(() => {});
    throw error;
  }
  await outputHandle.close();
  return { kind: 'editable-document-import-file', output_path: output, output_bytes: bytes.length, block_count: result.block_count, source_identity: result.source_identity, round_trip: result.round_trip };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    const result = await importMarkdownFile({ ...JSON.parse(input), granted_folder: process.argv[2] });
    process.stdout.write(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
