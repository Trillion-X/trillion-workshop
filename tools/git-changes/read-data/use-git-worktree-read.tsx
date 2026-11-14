import * as React from 'react';

export interface GitWorktreeReadState<T> {
  data: T;
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
}

export function useGitWorktreeRead<T>(
  read: (signal?: AbortSignal) => Promise<T>,
  empty: T,
): GitWorktreeReadState<T> {
  const [state, setState] = React.useState<GitWorktreeReadState<T>>({
    data: empty,
    loading: true,
    error: null,
    reload: async () => undefined,
  });

  const reload = React.useCallback(async (signal?: AbortSignal) => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await read(signal);
      if (!signal?.aborted) {
        setState((current) => ({ ...current, data, loading: false, error: null }));
      }
    } catch (error: unknown) {
      if (!signal?.aborted) {
        setState((current) => ({
          ...current,
          data: empty,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      }
    }
  }, [empty, read]);

  React.useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  return { ...state, reload };
}
