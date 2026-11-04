// packages/screen-look/do-work/choose-current-screen-look.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Choose the browser's screen look through its declared input. The workspace
// saves the same record the screen reads and tells its subscribers to repaint.
//
// =============================================================================

import { writeInputValue } from '#workspace-records';

export async function chooseCurrentScreenLook(value: string): Promise<unknown> {
  const screenLook = value.trim();
  if (!screenLook) {
    throw new Error('screen-look value is required');
  }

  return writeInputValue('current-screen-look', [{ name: screenLook }]);
}
