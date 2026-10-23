import { requireOptionalNativeModule } from 'expo';
import * as SecureStore from 'expo-secure-store';
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from 'react';

import { MAX_BITRATE } from './api';

const SETTINGS_KEY = 'jellyfin.settings';

export type Settings = {
  /** Highest stream bitrate on Wi-Fi (and anything that isn't cellular), in bits per second. */
  wifiBitrate: number;
  cellularBitrate: number;
};

const DEFAULT_SETTINGS: Settings = {
  wifiBitrate: MAX_BITRATE,
  cellularBitrate: 10_000_000,
};

export const BITRATE_OPTIONS: { label: string; value: number }[] = [
  { label: 'Original', value: MAX_BITRATE },
  { label: '40 Mbps', value: 40_000_000 },
  { label: '20 Mbps', value: 20_000_000 },
  { label: '10 Mbps', value: 10_000_000 },
  { label: '6 Mbps', value: 6_000_000 },
  { label: '3 Mbps', value: 3_000_000 },
  { label: '1.5 Mbps', value: 1_500_000 },
];

type SettingsState = {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
};

const SettingsContext = createContext<SettingsState | null>(null);

export function JellyfinSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync(SETTINGS_KEY)
      .then((raw) => raw && setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) }))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  const value = useMemo<SettingsState>(
    () => ({
      settings,
      update: (patch) => {
        const next = { ...settings, ...patch };
        setSettings(next);
        SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(next)).catch(() => undefined);
      },
    }),
    [settings],
  );

  // The screens wait the moment it takes, or a Resume straight from the launcher would ask for a
  // stream before the cellular limit is known.
  return <SettingsContext value={value}>{loaded ? children : null}</SettingsContext>;
}

export function useJellyfinSettings() {
  const ctx = use(SettingsContext);
  if (!ctx) throw new Error('useJellyfinSettings must be used inside JellyfinSettingsProvider');
  return ctx;
}

// App builds made before expo-network was added don't contain its native code, and importing
// it there throws. Load it lazily so over-the-air updates keep working on those builds; they
// just always get the Wi-Fi limit. Check for the native module first rather than catching:
// Metro reports a module that throws while loading as a fatal error (crashing a release
// build) instead of letting the caller's try/catch see it.
let network: typeof import('expo-network') | null | undefined;
function loadNetwork() {
  if (network === undefined) {
    network = requireOptionalNativeModule('ExpoNetwork')
      ? // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require('expo-network') as typeof import('expo-network'))
      : null;
  }
  return network;
}

/** The bitrate limit for the connection the phone is on right now. */
export async function currentMaxBitrate(settings: Settings): Promise<number> {
  const net = loadNetwork();
  if (!net) return settings.wifiBitrate;
  try {
    const state = await net.getNetworkStateAsync();
    return state.type === net.NetworkStateType.CELLULAR ? settings.cellularBitrate : settings.wifiBitrate;
  } catch {
    return settings.wifiBitrate;
  }
}
