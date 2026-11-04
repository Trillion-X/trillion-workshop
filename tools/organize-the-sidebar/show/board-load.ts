// A board open may finish after its slow-load warning. Observe the whole open
// without racing away its result; disposal fences an unmounted or replaced open.
export function watchBoardLoad<T>(load: () => Promise<T>, handlers: {
  timeoutMs: number;
  onSlow: () => void;
  onLoaded: (value: T) => void;
  onFailed: (error: unknown) => void;
}): () => void {
  let live = true;
  const timer = setTimeout(() => {
    if (live) handlers.onSlow();
  }, handlers.timeoutMs);
  void Promise.resolve().then(load).then(value => {
    clearTimeout(timer);
    if (live) handlers.onLoaded(value);
  }, error => {
    clearTimeout(timer);
    if (live) handlers.onFailed(error);
  });
  return () => {
    live = false;
    clearTimeout(timer);
  };
}
