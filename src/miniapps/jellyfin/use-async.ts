import { useCallback, useEffect, useMemo, useState } from 'react';

type AsyncState<T> = {
  /** Last loaded value; kept while reloading so pull-to-refresh doesn't blank the screen. */
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
};

type Result<T> = { request: object; data?: T; error?: Error };

/** Run an async loader whenever `key` changes; stale results are dropped. */
export function useAsync<T>(load: () => Promise<T>, key: string): AsyncState<T> {
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<Result<T>>();

  // A fresh object per request, so we can tell whether the result belongs to it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const request = useMemo(() => ({}), [key, nonce]);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => !cancelled && setResult({ request, data }),
      (e: unknown) =>
        !cancelled &&
        setResult((prev) => ({ request, data: prev?.data, error: e instanceof Error ? e : new Error(String(e)) })),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const current = result?.request === request;
  return {
    data: result?.data,
    error: current ? result?.error : undefined,
    loading: !current,
    reload,
  };
}
