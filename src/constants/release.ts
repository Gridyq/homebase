import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

type ReleaseExtra = { homebase?: { commit?: string; notes?: string[] } };

const extra = Constants.expoConfig?.extra as ReleaseExtra | undefined;

/** What's running: the build's own JavaScript, or an over-the-air update published on top of it. */
export const Release = {
  version: Constants.expoConfig?.version ?? '',
  /** Set when running a downloaded update rather than the JavaScript bundled in the build. */
  update:
    Updates.isEnabled && !Updates.isEmbeddedLaunch && Updates.updateId
      ? { id: Updates.updateId, createdAt: Updates.createdAt }
      : undefined,
  /** Commit subjects since the previous update, written by scripts/publish-update.mjs. */
  notes: extra?.homebase?.notes ?? [],
};

/** "Version 1.1.0 · updated Oct 22, 2:05 PM", or just the version for the build's own JavaScript. */
export function describeRelease(version: string, updatedAt: Date | null | undefined) {
  const parts = [`Version ${version}`];
  if (updatedAt) {
    parts.push(
      `updated ${updatedAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
    );
  }
  return parts.join(' · ');
}
