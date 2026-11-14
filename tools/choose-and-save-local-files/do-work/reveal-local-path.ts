//
// Reveals a local path through the native device-files capability.

import { invokeLocalFilesTarget } from '../read-data/invoke-local-files-target.ts';

export async function revealLocalPath(path: string): Promise<void> {
  await invokeLocalFilesTarget({
    operation: 'reveal',
    path,
  });
}
