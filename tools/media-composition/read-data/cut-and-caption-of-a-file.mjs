// tools/media-composition/read-data/cut-and-caption-of-a-file.mjs
//
// Purpose
//   tool:cut-and-caption as a function of its input: the one clip the person names by its identity (files[0].identity) is
//   handed to do-work/cut-and-caption.mjs as a file (files-identity-as-a-file.mjs). The CLI renders the edit into the run's
//   folder; the rendered clip is kept in the person's files through the run's host (writeLarge, the lease road) before the
//   folder is removed. The answer is { result, files } as the row's output schema names it: the CLI's measured render and the
//   clip's identity, length and media type. Run by workflows do-work/run-a-function.mjs as cutAndCaptionOfAFile(input, host).
//
// Non-Negotiable Invariants
//   1. The clip is read through the run's host and the rendered clip is kept through it; this file names no path of the person's.
//   2. The CLI is the one owner of the cut and the caption; this file passes it the file's path and the input's settings.
//   3. The rendered clip is kept before the run's folder is removed, so the answer never names a file that is gone.
import { execFile } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withFilesIdentityAsFile } from './files-identity-as-a-file.mjs';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(new URL(import.meta.url))), '..', 'do-work', 'cut-and-caption.mjs');
const OUTPUT_NAME = 'clip.mp4';
const OUTPUT_MEDIA_TYPE = 'video/mp4';

/** The rendered file as the host's large-file sender reads it: its size, and a read at any offset. */
const sourceOf = async file => {
  const handle = await open(file, 'r');
  return { size: (await stat(file)).size, readAt: async (offset, length) => (await readRange(handle, offset, length)), close: () => handle.close() };
};
const readRange = async (handle, offset, length) => {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await handle.read(bytes, 0, length, offset);
  return bytes.subarray(0, bytesRead);
};

/** The CLI's arguments for one input, with the video's path in place of its identity. */
const argumentsFor = (video, input, output) => [
  CLI,
  '--video', video,
  '--from', String(input.from),
  '--to', String(input.to),
  '--output', output,
  ...(input.transcript ? ['--transcript', JSON.stringify(input.transcript)] : []),
  ...(input.transcript_from !== undefined ? ['--transcript-from', String(input.transcript_from)] : []),
  ...(input.style !== undefined ? ['--style', typeof input.style === 'string' ? input.style : JSON.stringify(input.style)] : []),
];

export async function cutAndCaptionOfAFile(input, host) {
  return withFilesIdentityAsFile(host, input.files[0].identity, async video => {
    const output = path.join(path.dirname(video), OUTPUT_NAME);
    const { stdout } = await run('node', argumentsFor(video, input, output), { maxBuffer: 64 * 1024 * 1024 });
    const rendered = JSON.parse(String(stdout).trim().split('\n').pop());
    const source = await sourceOf(output);
    const kept = await host.writeLarge(OUTPUT_NAME, source, { mediaType: OUTPUT_MEDIA_TYPE }).finally(() => source.close());
    return {
      result: rendered,
      files: { video: { identity: kept.identity, bytes: kept.byte_length, media_type: OUTPUT_MEDIA_TYPE, name: OUTPUT_NAME } },
    };
  });
}
