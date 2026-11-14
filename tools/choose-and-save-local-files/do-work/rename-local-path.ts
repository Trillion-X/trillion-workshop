//
// Renames/moves a local path through the native device-files capability.

import { invokeLocalFilesTarget } from '../read-data/invoke-local-files-target.ts';

export async function renameLocalPath(oldPath: string, newPath: string): Promise<void> {
  await invokeLocalFilesTarget({
    operation: 'rename',
    source_path: oldPath,
    destination_path: newPath,
  });
}
