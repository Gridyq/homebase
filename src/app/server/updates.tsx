import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import {
  changeContainerUpdates,
  fetchContainerUpdates,
  type ContainerChange,
  type ContainerUpdateInfo,
  type ContainerUpdates,
  type ImageBuild,
} from '@/miniapps/server/api';
import { Card, formatWhen, Section, StatusColors, usePullToRefresh } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';

const POLL_MS = 30_000;
const BUSY_POLL_MS = 2_000;
const NAMES: Record<string, string> = { qbittorrent: 'qBittorrent', ntfy: 'ntfy', llama: 'Assistant model' };

const displayName = (name: string) => NAMES[name] ?? name.charAt(0).toUpperCase() + name.slice(1);

/** "4.0.20.3014-ls1", or for an image without a version label, when it was built. */
function buildName(b: ImageBuild) {
  if (b.version) return b.version;
  if (b.created) return `build of ${new Date(b.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  return b.id.slice(0, 12);
}

/** The containers kept on their image's latest build: what's new, going back, and holding. */
export default function UpdatesScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  // What the last action answered, until the next poll, so the screen shows the run starting.
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<ContainerUpdates>();
  const [pollMs, setPollMs] = useState(POLL_MS);
  const { data: polled, error, stale, refresh } = usePolling(
    async () => {
      const next = await fetchContainerUpdates(conn);
      setAnswer(undefined);
      setPollMs(next.running ? BUSY_POLL_MS : POLL_MS);
      return next;
    },
    pollMs,
    conn.url,
    { keepPrevious: true },
  );
  const refreshControl = usePullToRefresh(refresh);
  const data = answer ?? polled;

  if (!data) return <Centered loading={!error} error={error} onRetry={refresh} />;

  const act = async (body: Parameters<typeof changeContainerUpdates>[1]) => {
    setBusy(true);
    try {
      const next = await changeContainerUpdates(conn, body);
      setAnswer(next);
      setPollMs(BUSY_POLL_MS);
    } catch (e) {
      Alert.alert("Couldn't do that", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = data.containers.filter((c) => c.available && !c.held);
  const working = !!data.running || busy;

  const openContainer = (c: ContainerUpdateInfo) => {
    const options: string[] = [];
    options.push(c.available ? 'Update now' : 'Check for a new build and update');
    if (c.previous) options.push(`Go back to ${buildName(c.previous)}`);
    options.push(c.held ? 'Stop holding' : 'Hold on this build');
    if (c.changelog) options.push('Release notes');
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: displayName(c.name),
        message: c.held
          ? `${c.held.reason} ${formatWhen(c.held.at)}. The nightly update skips it.`
          : c.previous
            ? 'Going back holds it there, so the nightly update leaves it alone.'
            : undefined,
        options: [...options, 'Cancel'],
        cancelButtonIndex: options.length,
      },
      (index) => {
        const option = options[index];
        if (!option || option === 'Cancel') return;
        if (option === 'Release notes') WebBrowser.openBrowserAsync(c.changelog!);
        else if (option.startsWith('Go back')) act({ revert: c.name });
        else if (option === 'Stop holding') act({ hold: c.name, held: false });
        else if (option === 'Hold on this build') act({ hold: c.name, held: true });
        else act({ update: true, name: c.name });
      },
    );
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter, stale && styles.stale]}
      refreshControl={refreshControl}>
      {error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {error.message} Showing the last reading.
        </ThemedText>
      ) : null}

      <Card>
        <View style={styles.status}>
          {working ? <ActivityIndicator /> : null}
          <View style={styles.flex}>
            <ThemedText type="smallBold">
              {data.running
                ? data.running.what
                : ready.length
                  ? `${ready.length} update${ready.length === 1 ? '' : 's'} available`
                  : 'Everything is up to date'}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
              {data.running
                ? data.running.step
                : [
                    data.gameMode ? 'Waiting for game mode to end' : `Updates every night after ${data.runHour}:00`,
                    data.checkedAt ? `checked ${formatWhen(data.checkedAt)}` : 'not checked yet',
                  ].join(' · ')}
            </ThemedText>
          </View>
        </View>
        {data.errors.map((e) => (
          <ThemedText key={e} type="small" style={[styles.caption, styles.error, { color: theme.danger }]}>
            {e}
          </ThemedText>
        ))}
      </Card>

      <View style={styles.buttons}>
        {ready.length ? (
          <Button title={`Update ${ready.length === 1 ? displayName(ready[0].name) : `all ${ready.length}`}`} disabled={working || data.gameMode} onPress={() => act({ update: true })} />
        ) : null}
        <Button title="Check now" variant="secondary" disabled={working} onPress={() => act({ check: true })} />
      </View>

      <Section title="Containers">
        <Card>
          {data.containers.map((c, i) => (
            <ContainerRow key={c.id} container={c} first={i === 0} onPress={() => openContainer(c)} />
          ))}
        </Card>
        <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
          A container that doesn&apos;t come back healthy on a new build goes back to the old one by itself. Jellyfin
          waits until nobody&apos;s watching.
        </ThemedText>
      </Section>

      <Section title="History">
        <Card>
          {data.history.length ? (
            data.history.map((h, i) => <ChangeRow key={`${h.at}-${h.name}`} change={h} first={i === 0} />)
          ) : (
            <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
              Nothing yet. Updates show up here from the first nightly run.
            </ThemedText>
          )}
        </Card>
      </Section>
    </ScrollView>
  );
}

function ContainerRow({ container: c, first, onPress }: { container: ContainerUpdateInfo; first: boolean; onPress: () => void }) {
  const theme = useTheme();
  const [color, note] = c.waiting
    ? [StatusColors.warn, "Restarts on the new build once nobody's watching"]
    : c.held
      ? [StatusColors.idle, c.available ? 'Held · newer build available' : 'Held']
      : c.available
        ? [theme.accent, 'Update available']
        : [StatusColors.good, c.running ? 'Up to date' : 'Up to date · not running'];
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <View style={styles.flex}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {displayName(c.name)}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.caption} numberOfLines={2}>
          {buildName(c.current)} · {note}
        </ThemedText>
      </View>
      <ThemedText themeColor="textSecondary" style={styles.chevron}>
        ›
      </ThemedText>
    </Pressable>
  );
}

function ChangeRow({ change: h, first }: { change: ContainerChange; first: boolean }) {
  const theme = useTheme();
  const [color, verb] =
    h.outcome === 'rolledBack'
      ? [theme.danger, 'failed, went back']
      : h.outcome === 'reverted'
        ? [StatusColors.warn, 'gone back']
        : [StatusColors.good, 'updated'];
  return (
    <View style={[styles.row, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <View style={styles.flex}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {displayName(h.name)} {verb}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
          {buildName(h.from)} → {buildName(h.to)} · {formatWhen(h.at)}
          {h.detail ? `\n${h.detail}` : ''}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  stale: {
    opacity: 0.5,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  buttons: {
    gap: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  flex: {
    flex: 1,
  },
  caption: {
    fontSize: 13,
    lineHeight: 18,
  },
  error: {
    paddingBottom: Spacing.two,
  },
  chevron: {
    fontSize: 20,
  },
  empty: {
    paddingVertical: Spacing.two,
  },
});
