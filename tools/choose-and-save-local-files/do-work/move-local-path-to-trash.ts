//
// Moves a local path to Trash through the native device-files capability.

import { invokeLocalFilesTarget } from '../read-data/invoke-local-files-target.ts';

export async function moveLocalPathToTrash(path: string): Promise<void> {
  await invokeLocalFilesTarget({
    operation: 'trash',
    path,
  });
}
