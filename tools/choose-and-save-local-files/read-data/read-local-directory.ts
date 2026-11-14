//
// Reads one user-authorized local directory through the native files target.

import { invokeLocalFilesTarget } from './invoke-local-files-target.ts';

export interface LocalFileEntry {
  path: string;
  name: string;
  isDir: boolean;
}

export interface ListLocalDirectoryOptions {
  showHidden?: boolean;
}

export async function listLocalDirectory(
  path: string,
  options: ListLocalDirectoryOptions = {},
): Promise<LocalFileEntry[]> {
  const result = await invokeLocalFilesTarget({
    operation: 'list_directory',
    path,
  });
  return (result.entries ?? [])
    .map((entry) => ({
      path: entry.path,
      name: entry.name,
      isDir: entry.is_dir,
    }))
    .filter((entry) => options.showHidden || !entry.name.startsWith('.'))
    .sort((left, right) => {
      if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}
