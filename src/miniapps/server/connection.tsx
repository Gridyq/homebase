import * as SecureStore from 'expo-secure-store';
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { Connection } from './api';

const CONNECTION_KEY = 'server.connection';

type ConnectionState = {
  loading: boolean;
  connection: Connection | null;
  save: (connection: Connection) => Promise<void>;
  forget: () => Promise<void>;
};

const ConnectionContext = createContext<ConnectionState | null>(null);

export function ServerConnectionProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    SecureStore.getItemAsync(CONNECTION_KEY)
      .then((raw) => raw && setConnection(JSON.parse(raw)))
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
