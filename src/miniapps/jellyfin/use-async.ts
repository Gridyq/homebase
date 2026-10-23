import { useCallback, useEffect, useMemo, useState } from 'react';

type AsyncState<T> = {
  /**
   * Last loaded value for this `key`; kept while reloading so pull-to-refresh doesn't blank the
   * screen, but dropped when `key` changes so one key's data never shows under another.
   */
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
};

type Result<T> = { request: object; key: string; data?: T; error?: Error };

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
      (data) => !cancelled && setResult({ request, key, data }),
      (e: unknown) =>
        !cancelled &&
        setResult((prev) => ({
          request,
          key,
          data: prev?.key === key ? prev.data : undefined,
          error: e instanceof Error ? e : new Error(String(e)),
        })),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const current = result?.request === request;
  return {
    data: result?.key === key ? result.data : undefined,
    error: current ? result?.error : undefined,
    loading: !current,
    reload,
  };
}
