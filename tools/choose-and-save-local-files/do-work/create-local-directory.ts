//
// Creates a local directory through the native device-files capability.

import { invokeLocalFilesTarget } from '../read-data/invoke-local-files-target.ts';

export async function createLocalDirectory(path: string): Promise<void> {
  await invokeLocalFilesTarget({
    operation: 'create_directory',
    path,
  });
}
