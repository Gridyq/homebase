import * as SecureStore from 'expo-secure-store';
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { Connection } from './api';

import { homeServerHttps } from '@/utils/home-server-https';

const CONNECTION_KEY = 'server.connection';

type ConnectionState = {
  loading: boolean;
  connection: Connection | null;
  save: (connection: Connection) => Promise<void>;
  forget: () => Promise<void>;
};

/** The saved connection, for code outside the mini-apps' screens (the launcher). */
export async function loadConnection(): Promise<Connection | null> {
  const raw = await SecureStore.getItemAsync(CONNECTION_KEY);
  if (!raw) return null;
  const saved: Connection = JSON.parse(raw);
  const url = homeServerHttps(saved.url);
  if (url === saved.url) return saved;
  // Saved before the server moved to HTTPS: same token, new address.
  const moved = { ...saved, url };
  await SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(moved)).catch(() => undefined);
  return moved;
}

const ConnectionContext = createContext<ConnectionState | null>(null);

export function ServerConnectionProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadConnection()
      .then(setConnection)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo<ConnectionState>(
    () => ({
      loading,
      connection,
      save: async (next) => {
        await SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(next));
        setConnection(next);
      },
      forget: async () => {
        await SecureStore.deleteItemAsync(CONNECTION_KEY);
        setConnection(null);
      },
    }),
    [loading, connection],
  );

  return <ConnectionContext value={value}>{children}</ConnectionContext>;
}

export function useServerConnection() {
  const ctx = use(ConnectionContext);
  if (!ctx) throw new Error('useServerConnection must be used inside ServerConnectionProvider');
  return ctx;
}
