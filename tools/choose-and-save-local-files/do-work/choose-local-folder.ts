//
// Opens the operating system folder picker through the native files target and returns
// the chosen folder path. This is navigation-only; it does not own filesystem
// state or know which package will render a selected path.

import { invokeLocalFilesTarget } from '../read-data/invoke-local-files-target.ts';

const DEFAULT_FOLDER_PICKER_PROMPT = 'Choose a folder';

export interface ChooseLocalFolderOptions {
  prompt?: string;
}

export async function chooseLocalFolder(options: ChooseLocalFolderOptions = {}): Promise<string | null> {
  const result = await invokeLocalFilesTarget({
    operation: 'choose_folder',
    prompt: options.prompt ?? DEFAULT_FOLDER_PICKER_PROMPT,
  });
  if (result.cancelled) return null;
  return result.path ?? null;
}
