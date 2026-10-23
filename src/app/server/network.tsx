import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { fetchNetwork } from '@/miniapps/server/api';
import {
  Card,
  formatBytes,
  formatRate,
  formatWhen,
  Section,
  Segmented,
  StackedBar,
  StatTile,
  StatusColors,
  usePullToRefresh,
  useSeriesColors,
} from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { RANGES, rangeName } from '@/miniapps/server/trends';
import { usePolling } from '@/miniapps/server/use-polling';

const POLL_MS = 15_000;

/** Traffic by service and by Tailscale device, now and over a range. */
export default function NetworkScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const colors = useSeriesColors();
  const [range, setRange] = useState(RANGES[2].value);
  const { data, error, stale, refresh } = usePolling(() => fetchNetwork(conn, range), POLL_MS, `${conn.url}|${range}`, {
    keepPrevious: true,
  });
  const refreshControl = usePullToRefresh(refresh);

  const picker = <Segmented value={range} onChange={setRange} options={RANGES} />;
  if (!data) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={[styles.content, gutter]}>
        {picker}
        <Centered loading={!error} error={error} onRetry={refresh} />
      </ScrollView>
    );
  }

  const services = data.services.filter((s) => s.rxBytes + s.txBytes > 0 || (s.rxPerSec ?? 0) + (s.txPerSec ?? 0) > 0);
  const devices = data.devices.filter((d) => d.online || d.rxBytes + d.txBytes > 0);
  const serviceMax = Math.max(1, ...services.map((s) => s.rxBytes + s.txBytes));
  const deviceMax = Math.max(1, ...devices.map((d) => d.rxBytes + d.txBytes));
  const partial = data.oldest && data.oldest > data.start;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter, stale && styles.stale]}
      refreshControl={refreshControl}>
      {picker}
      {error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {error.message} Showing the last reading.
        </ThemedText>
      ) : null}

      <View style={styles.tiles}>
        <StatTile label="Downloaded" value={formatBytes(data.rxBytes)} caption={`now ${formatRate(data.rxPerSec)}`} onPress={() => router.push('/server/trends')} />
        <StatTile label="Uploaded" value={formatBytes(data.txBytes)} caption={`now ${formatRate(data.txPerSec)}`} onPress={() => router.push('/server/trends')} />
      </View>
      <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
        {partial ? `Since ${formatWhen(data.oldest!)}, when the server started keeping these. ` : `In ${rangeName(range)}. `}
        The bars split each total into{' '}
        <ThemedText type="small" style={{ color: colors[0] }}>
          received
        </ThemedText>{' '}
        and{' '}
        <ThemedText type="small" style={{ color: colors[1] }}>
          sent
        </ThemedText>
        .
      </ThemedText>

      <Section title="By service">
        <Card>
          {services.length ? (
            services.map((s, i) => (
              <TrafficRow
                key={s.id}
                first={i === 0}
                title={s.name}
                rx={s.rxBytes}
                tx={s.txBytes}
                rxPerSec={s.rxPerSec}
                txPerSec={s.txPerSec}
                max={serviceMax}
                onPress={() => router.push({ pathname: '/server/service/[id]', params: { id: s.id } })}
              />
            ))
          ) : (
            <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
              No traffic recorded yet.
            </ThemedText>
          )}
        </Card>
        <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
          Containers with a network of their own. Jellyfin&apos;s sent is streaming to your devices;
          qBittorrent is counted with gluetun, whose VPN it uses. Traffic between services counts too.
        </ThemedText>
      </Section>

      <Section title="By Tailscale device">
        <Card>
          {devices.length ? (
            devices.map((d, i) => (
              <TrafficRow
                key={d.name}
                first={i === 0}
                title={d.name}
                online={d.online}
                rx={d.rxBytes}
                tx={d.txBytes}
                rxPerSec={d.rxPerSec}
                txPerSec={d.txPerSec}
                max={deviceMax}
                onPress={() => router.push({ pathname: '/server/device/[name]', params: { name: d.name } })}
              />
            ))
          ) : (
            <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
              No devices.
            </ThemedText>
          )}
        </Card>
        <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
          Received is what the server got from the device, sent what it sent it, such as a stream.
          Only traffic over Tailscale; devices at home on Wi-Fi may reach the server directly.
        </ThemedText>
      </Section>
    </ScrollView>
  );
}

function TrafficRow({
  title,
  rx,
  tx,
  rxPerSec,
  txPerSec,
  max,
  first,
  online,
  onPress,
}: {
  title: string;
  rx: number;
  tx: number;
  rxPerSec?: number;
  txPerSec?: number;
  max: number;
  first?: boolean;
  online?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const colors = useSeriesColors();
  const live = (rxPerSec ?? 0) + (txPerSec ?? 0) > 1000;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      <View style={styles.line}>
        {online !== undefined ? (
          <View style={[styles.dot, { backgroundColor: online ? StatusColors.good : StatusColors.idle }]} />
        ) : null}
        <ThemedText type="smallBold" style={styles.flex} numberOfLines={1}>
          {title}
        </ThemedText>
        <ThemedText type="small" style={styles.tabular}>
          {formatBytes(rx + tx)}
        </ThemedText>
      </View>
      <StackedBar
        total={max}
        parts={[
          { value: rx, color: colors[0] },
          { value: tx, color: colors[1] },
        ]}
      />
      <ThemedText type="small" themeColor="textSecondary" style={[styles.caption, styles.tabular]} numberOfLines={1}>
        ↓ {formatBytes(rx)} · ↑ {formatBytes(tx)}
        {live ? ` · now ↓ ${formatRate(rxPerSec)} ↑ ${formatRate(txPerSec)}` : ''}
      </ThemedText>
    </Pressable>
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
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  row: {
    gap: Spacing.one,
    paddingVertical: Spacing.two,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  flex: {
    flex: 1,
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
  caption: {
    fontSize: 13,
    lineHeight: 18,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
  },
  empty: {
    paddingVertical: Spacing.two,
  },
});
