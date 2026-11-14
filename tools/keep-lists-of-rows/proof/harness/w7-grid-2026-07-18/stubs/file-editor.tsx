// Harness stub: the CodeMirror-backed FileEditor is never opened in the
// render matrix; stubbing it keeps the offline bundle CodeMirror-free.
import React from 'react';
export function FileEditor(): React.ReactElement {
  return React.createElement('div');
}
