// Keep direct task interactions mounted while their child screens open and close.
// The caller supplies licensed screen mounts and canonical addresses; this owner creates inert hosts only.
export function focusedSurfaceHost(root, { mount, changed = () => {}, onError = () => {} }) {
  const kept = new Map();
  const history = [];
  let disposed = false;
  const keyOf = screen => typeof screen.address === 'string' && screen.address ? screen.address : screen.id;
  const paint = () => {
    const current = history.at(-1);
    for (const [key, value] of kept) value.element.hidden = key !== current;
    changed({ current: kept.get(current)?.screen ?? null, canBack: history.length > 1 });
  };
  const start = value => {
    try {
      value.stop = mount(value.element, value.screen);
      value.failed = false;
    } catch (error) {
      value.failed = true;
      onError(error, value.screen, value.element);
    }
  };
  const failUpdate = (value, error) => {
    // A rejected update must leave the active editor and recording mounted.
    onError(error, value.screen, value.element, { updating: true, stop: value.stop });
  };
  return {
    open(screen) {
      if (disposed) return;
      const key = keyOf(screen);
      let value = kept.get(key);
      if (value) {
        value.screen = screen;
        // The mount's shared input-preservation contract owns acceptance. Never remount an editor to update it.
        if (value.failed) start(value);
        else {
          try { void Promise.resolve(value.stop?.update?.({ surfaceInput: screen.input ?? {} })).catch(error => failUpdate(value, error)); }
          catch (error) { failUpdate(value, error); }
        }
      } else {
        const element = root.ownerDocument.createElement('div');
        element.className = 'trillion-focused-surface';
        root.append(element);
        value = { element, screen, stop: null, failed: false };
        kept.set(key, value);
        start(value);
      }
      if (history.at(-1) !== key) history.push(key);
      paint();
    },
    back() {
      if (disposed || history.length < 2) return false;
      history.pop();
      paint();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const value of kept.values()) {
        try { value.stop?.(); } catch { /* continue releasing the remaining mounted screens */ }
        value.element.remove();
      }
      kept.clear(); history.length = 0;
    },
  };
}
