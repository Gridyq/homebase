import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { FlatList, Share, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { fetchServiceLogs, type LogLine, type LogReport } from '@/miniapps/server/api';
import { Segmented, StatusColors } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';

const POLL_MS = 3000;
/** Older lines drop off the top past this, so a chatty service doesn't grow the list forever. */
const KEPT = 1500;

type Filter = 'all' | 'problems';

// Containers write everything at the same priority, so the text is what tells an error apart.
const ERROR_TEXT = /\b(error|fatal|exception|crit(ical)?|panic|traceback)\b|\[(err|eror|ftl|fatal)\]/i;
const WARN_TEXT = /\bwarn(ing)?\b|\[wrn\]/i;

function level(line: LogLine) {
  if (line.priority <= 3 || ERROR_TEXT.test(line.text)) return 'error';
  if (line.priority === 4 || WARN_TEXT.test(line.text)) return 'warn';
  return undefined;
}

const formatClock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** A service's journal, newest at the bottom, following along as it writes. */
export default function LogsScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const [filter, setFilter] = useState<Filter>('all');
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [cursor, setCursor] = useState<string>();

  const key = `${conn.url}|${id}|${filter}`;
  const { data, error, refresh } = usePolling(
    () => fetchServiceLogs(conn, id, { after: cursor, errors: filter === 'problems' }),
    POLL_MS,
    key,
    { enabled: !paused },
  );

  // Switching filters starts over from the last few hundred lines.
  const [prevKey, setPrevKey] = useState(key);
  const [seen, setSeen] = useState<LogReport>();
  if (prevKey !== key) {
    setPrevKey(key);
    setLines([]);
    setCursor(undefined);
    setSeen(undefined);
  } else if (data && data !== seen) {
    setSeen(data);
    if (data.lines.length) setLines((prev) => [...prev, ...data.lines].slice(-KEPT));
    if (data.cursor) setCursor(data.cursor);
  }

  const share = () =>
    Share.share({
      message: lines.map((l) => `${new Date(l.at).toISOString()} ${l.text}`).join('\n'),
    });

  const header = (
    <>
      <Stack.Screen options={{ title: name ? `${name} logs` : 'Logs' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon={paused ? 'play.fill' : 'pause.fill'} onPress={() => setPaused((p) => !p)}>
          {paused ? 'Follow' : 'Pause'}
        </Stack.Toolbar.Button>
        <Stack.Toolbar.Button icon="square.and.arrow.up" disabled={!lines.length} onPress={share}>
          Share
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
    </>
  );

  const top = (
    <View style={[styles.top, gutter]}>
      <Segmented
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'Everything' },
          { value: 'problems', label: 'Problems' },
        ]}
      />
      <ThemedText type="small" style={{ color: error ? theme.danger : theme.textSecondary }}>
        {error
          ? `${error.message} Showing what came in before.`
          : paused
            ? 'Paused. New lines show up again when you tap play.'
            : filter === 'problems'
              ? 'Lines that mention an error, failure or warning. New ones appear at the bottom.'
              : 'New lines appear at the bottom as the service writes them. Touch and hold a line to copy it.'}
      </ThemedText>
    </View>
  );

  if (!seen && !lines.length) {
    return (
      <>
        {header}
        {top}
        <Centered loading={!error} error={error} onRetry={refresh} />
      </>
    );
  }

  return (
    <>
      {header}
      <FlatList
        // Inverted so it opens at the newest line and stays there as more arrive.
        inverted
        data={[...lines].reverse()}
        keyExtractor={(l, i) => `${l.at}-${lines.length - i}`}
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={[styles.content, gutter]}
        maintainVisibleContentPosition={{ minIndexForVisible: 1, autoscrollToTopThreshold: 48 }}
        ListFooterComponent={top}
        ListEmptyComponent={
          <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
            {filter === 'problems' ? 'Nothing that looks like a problem lately.' : 'This service hasn’t written anything yet.'}
          </ThemedText>
        }
        renderItem={({ item }) => {
          const l = level(item);
          return (
            <View
              style={[
                styles.line,
                l && { borderLeftColor: l === 'error' ? theme.danger : StatusColors.warn, borderLeftWidth: 3 },
              ]}>
              <ThemedText themeColor="textSecondary" style={styles.time}>
                {formatClock(item.at)}
              </ThemedText>
              <ThemedText selectable style={[styles.text, l === 'error' && { color: theme.danger }]}>
                {item.text}
              </ThemedText>
            </View>
          );
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  top: {
    gap: Spacing.two,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
  content: {
    paddingBottom: Spacing.four,
  },
  line: {
    paddingVertical: Spacing.one,
    paddingLeft: Spacing.two,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  time: {
    fontSize: 11,
    lineHeight: 14,
    fontVariant: ['tabular-nums'],
  },
  text: {
    fontFamily: Fonts?.mono,
    fontSize: 12,
    lineHeight: 16,
  },
  empty: {
    textAlign: 'center',
    paddingVertical: Spacing.four,
  },
});
