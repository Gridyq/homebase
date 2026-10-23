import { useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { conversions, setConversionsPaused, type Conversions } from '@/miniapps/requests/api';
import { displayName, formatEta } from '@/miniapps/requests/components';
import { Card, formatBytes, formatWhen, Meter, Section, StatTile, StatusColors } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';

const POLL_MS = 5000;

/** What Tdarr is converting to HEVC MP4s, what's done, and how much space it saved. */
export default function ConversionsScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const { data, error, refresh } = usePolling(() => conversions(conn), POLL_MS, conn.url);
  const [override, setOverride] = useState<Conversions>();
  const [busy, setBusy] = useState(false);
  const [pulled, setPulled] = useState(false);

  // A pause answers with fresh numbers; keep them until the next poll replaces them.
  const [prevData, setPrevData] = useState(data);
  if (prevData !== data) {
    setPrevData(data);
    setOverride(undefined);
  }
  const shown = override ?? data;
  if (!shown) return <Centered loading={!error} error={error} onRetry={refresh} />;
  const { counts, workers } = shown;

  const togglePause = async () => {
    setBusy(true);
    try {
      setOverride(await setConversionsPaused(conn, !shown.paused));
    } catch (e) {
      Alert.alert(`Couldn't ${shown.paused ? 'resume' : 'pause'}`, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const state = shown.paused
    ? workers.length
      ? 'Pausing after the current file'
      : 'Paused'
    : workers.length
      ? 'Converting'
      : counts.queued
        ? 'Waiting for the next file'
        : 'All caught up';

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter]}
      refreshControl={
        <RefreshControl
          refreshing={pulled}
          onRefresh={async () => {
            setPulled(true);
            await refresh();
            setPulled(false);
          }}
        />
      }>
      {error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {error.message} Showing the last reading.
        </ThemedText>
      ) : null}

      <View style={styles.tiles}>
        <StatTile
          label="Space saved"
          value={formatBytes(shown.savedBytes)}
          caption={`${counts.done} file${counts.done === 1 ? '' : 's'} converted`}
        />
        <StatTile
          label="Queued"
          value={String(counts.queued)}
          caption={[
            counts.skipped && `${counts.skipped} already fine`,
            counts.failed && `${counts.failed} failed`,
          ]
            .filter(Boolean)
            .join(' · ') || state}
        />
      </View>

      <View style={styles.status}>
        <View
          style={[
            styles.dot,
            { backgroundColor: shown.paused ? StatusColors.warn : workers.length ? StatusColors.good : StatusColors.idle },
          ]}
        />
        <ThemedText type="smallBold" style={styles.flex}>
          {state}
        </ThemedText>
      </View>
      <Button
        title={busy ? '…' : shown.paused ? 'Resume converting' : 'Pause converting'}
        variant="secondary"
        disabled={busy}
        onPress={togglePause}
      />

      {workers.length ? (
        <Section title="Now converting">
          {workers.map((w) => (
            <Card key={w.file}>
              <View style={styles.worker}>
                <ThemedText type="smallBold" numberOfLines={2}>
                  {displayName(w.file)}
                </ThemedText>
                <Meter fraction={w.percent / 100} color={StatusColors.good} />
                <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
                  {[`${Math.round(w.percent)}%`, formatEta(w.eta), w.fps ? `${Math.round(w.fps)} fps` : undefined]
                    .filter(Boolean)
                    .join(' · ')}
                </ThemedText>
                {w.oldSize && w.estSize ? (
                  <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
                    {formatBytes(w.oldSize)} → about {formatBytes(w.estSize)}
                  </ThemedText>
                ) : null}
              </View>
            </Card>
          ))}
        </Section>
      ) : null}

      {shown.errors.length ? (
        <Section title="Failed">
          <Card>
            {shown.errors.map((f, i) => (
              <FileRow key={f.file} first={i === 0} title={displayName(f.file)} caption={f.at ? formatWhen(f.at) : undefined} />
            ))}
          </Card>
          <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
            The originals are untouched. Retry them from Tdarr’s web page.
          </ThemedText>
        </Section>
      ) : null}

      {shown.recent.length ? (
        <Section title="Recently converted">
          <Card>
            {shown.recent.map((f, i) => {
              const saved = f.oldSize ? 1 - f.newSize / f.oldSize : 0;
              return (
                <FileRow
                  key={f.file}
                  first={i === 0}
                  title={displayName(f.file)}
                  caption={`${formatBytes(f.oldSize)} → ${formatBytes(f.newSize)}${f.at ? ` · ${formatWhen(f.at)}` : ''}`}
                  value={saved >= 0.01 ? `−${Math.round(saved * 100)}%` : 'Remuxed'}
                />
              );
            })}
          </Card>
        </Section>
      ) : null}
    </ScrollView>
  );
}

function FileRow({ title, caption, value, first }: { title: string; caption?: string; value?: string; first: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
      ]}>
      <View style={styles.flex}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {title}
        </ThemedText>
        {caption ? (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.caption}>
            {caption}
          </ThemedText>
        ) : null}
      </View>
      {value ? (
        <ThemedText type="smallBold" style={styles.tabular}>
          {value}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  flex: {
    flex: 1,
  },
  worker: {
    gap: Spacing.two,
    paddingVertical: Spacing.two + Spacing.one,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two + Spacing.one,
  },
  caption: {
    fontSize: 13,
    lineHeight: 17,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
});
