//
// Creates an empty local file through the native device-files capability.

import { invokeLocalFilesTarget } from '../read-data/invoke-local-files-target.ts';

export async function createLocalEmptyFile(path: string): Promise<void> {
  await invokeLocalFilesTarget({
    operation: 'create_file',
    path,
  });
}
