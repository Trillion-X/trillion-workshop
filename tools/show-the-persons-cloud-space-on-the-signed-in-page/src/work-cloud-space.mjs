// src/work-cloud-space.mjs
//
// PURPOSE
//   The person's cloud space as the signed-in page reads it: its files, bytes and file types, summed from their own
//   files. Drives on the person's Mac are shown by Trillion Media on that Mac; nothing here asks a computer.
//
//   GET  /work/api/drives/cloud   the cloud space: its files, bytes and file types
//
// NON-NEGOTIABLE INVARIANTS
//   1. The file types are summed from the person's own names by extension; which extension is which kind is
//      src/workspace/file-previews.json, the same DATA the Files screen draws with.
//   2. Only a GET is answered; nothing here changes anything.
import previews from '../../keep-and-wake-ai-sessions-on-this-computer/src/workspace/file-previews.json' with { type: 'json' };

const CLOUD = '/work/api/drives/cloud';

export const isWorkCloudSpacePath = path => path === CLOUD;

/** The cloud space's totals and its file types, largest first, from the person's names by extension. */
export function cloudKinds(summary, byExtension) {
  const families = previews.families_by_extension;
  const labels = Object.fromEntries(previews.rows.filter(row => row.family).map(row => [row.family, row.type_label]));
  const other = previews.rows.find(row => !row.family).type_label;
  const kinds = new Map();
  for (const { extension, files, bytes } of byExtension) {
    const kind = families[extension] ?? 'other';
    const now = kinds.get(kind) ?? { kind, label: labels[kind] ?? other, files: 0, bytes: 0 };
    now.files += files;
    now.bytes += bytes;
    kinds.set(kind, now);
  }
  return { files: summary.files, bytes: summary.bytes, kinds: [...kinds.values()].sort((a, b) => b.bytes - a.bytes) };
}

export async function handleWorkCloudSpace(request, { person }) {
  if (request.method !== 'GET') return Response.json({ error: 'Not found' }, { status: 404 });
  const [summary, byExtension] = await Promise.all([person.namespaceSummary(), person.namespaceByExtension()]);
  return Response.json(cloudKinds(summary, byExtension));
}
