import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from 'react';

import { createClient, signIn as apiSignIn, type JellyfinClient, type Session } from './api';
import { clearLastPlayed } from './last-played';
import { useAsync } from './use-async';

export const SESSION_KEY = 'jellyfin.session';
const DEVICE_ID_KEY = 'jellyfin.deviceId';

type SessionState = {
  loading: boolean;
  client: JellyfinClient | null;
  signIn: (serverUrl: string, username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

async function getDeviceId(): Promise<string> {
  let id = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
  }
  return id;
}

export function JellyfinSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    SecureStore.getItemAsync(SESSION_KEY)
      .then((raw) => raw && setSession(JSON.parse(raw)))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const client = useMemo(() => (session ? createClient(session) : null), [session]);

  const value = useMemo<SessionState>(
    () => ({
      loading,
      client,
      signIn: async (serverUrl, username, password) => {
        const next = await apiSignIn(serverUrl, username, password, await getDeviceId());
        await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(next));
        setSession(next);
      },
      signOut: async () => {
        await client?.signOut();
        await SecureStore.deleteItemAsync(SESSION_KEY);
        clearLastPlayed();
        setSession(null);
      },
    }),
    [loading, client],
  );

  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useJellyfinSession() {
  const ctx = use(SessionContext);
  if (!ctx) throw new Error('useJellyfinSession must be used inside JellyfinSessionProvider');
  return ctx;
}

/** False until the server confirms the signed-in user is an admin. */
export function useIsAdmin(): boolean {
  const client = useJellyfin();
  const { data } = useAsync(() => client.isAdmin(), `admin:${client.session.userId}`);
  return data === true;
}

/** For screens that are only reachable while signed in. */
export function useJellyfin(): JellyfinClient {
  const { client } = useJellyfinSession();
  if (!client) throw new Error('Not signed in to Jellyfin');
  return client;
}
