import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { fetchTailscale, type TailscaleDevice } from '@/miniapps/server/api';
import { Card, formatBytes, formatDuration, formatWhen, Section, StatusColors, usePullToRefresh } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';

const POLL_MS = 5000;
/** Warn this long before a device's key runs out and it drops off the tailnet. */
const KEY_WARN_MS = 14 * 86_400_000;

const OS_NAMES: Record<string, string> = { linux: 'Linux', windows: 'Windows', macOS: 'Mac', iOS: 'iPhone', android: 'Android' };

/** Every device on the tailnet, as the server sees it. */
export default function TailscaleScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const { data, error, refresh } = usePolling(() => fetchTailscale(conn), POLL_MS, conn.url);
  const refreshControl = usePullToRefresh(refresh);

  if (!data) return <Centered loading={!error} error={error} onRetry={refresh} />;

  const [self, ...peers] = data.devices;
  const online = peers.filter((d) => d.online).length;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter]}
      refreshControl={refreshControl}>
      <ThemedText type="small" themeColor="textSecondary">
        {[data.tailnet, data.state === 'Running' ? 'Connected' : data.state, data.version && `Tailscale ${data.version}`]
          .filter(Boolean)
          .join(' · ')}
      </ThemedText>
      {error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {error.message} Showing the last reading.
        </ThemedText>
      ) : null}

      {data.health.length ? (
        <Card>
          {data.health.map((h) => (
            <ThemedText key={h} type="small" style={styles.health}>
              {h}
            </ThemedText>
          ))}
        </Card>
      ) : null}

      <Section title="This server">
        <Card>
          <DeviceRow device={self} now={data.at} first />
        </Card>
      </Section>

      <Section title={`Devices · ${online} of ${peers.length} online`}>
        <Card>
          {peers.map((d, i) => (
            <DeviceRow key={d.id} device={d} now={data.at} first={i === 0} />
          ))}
        </Card>
      </Section>

      <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
        Direct means the device and the server found each other; relayed traffic goes through
        Tailscale&apos;s servers and is slower. ↑ is what the server sent a device and ↓ what it got
        back, since Tailscale last started on the server. Tap a device for its addresses.
      </ThemedText>
    </ScrollView>
  );
}

function DeviceRow({ device: d, now, first }: { device: TailscaleDevice; now: number; first?: boolean }) {
  const theme = useTheme();
  const expiresSoon = d.keyExpiry !== undefined && d.keyExpiry - now < KEY_WARN_MS;

  let caption: string;
  if (d.self) caption = d.ips[0] ?? '';
  else if (!d.online) caption = d.lastSeen ? `Last seen ${formatDuration(now - d.lastSeen)} ago` : 'Offline';
  else if (d.direct) caption = `Direct${d.active ? ' · in use' : ''}`;
  else caption = d.relay ? `Relayed through ${d.relay}${d.active ? ' · in use' : ''}` : 'Online';

  const details = () =>
    Alert.alert(
      d.name,
      [
        OS_NAMES[d.os] ?? d.os,
        ...d.ips,
        d.direct && `Reached at ${d.direct}`,
        d.relay && `Nearest relay: ${d.relay}`,
        d.keyExpiry && `Key expires ${formatWhen(d.keyExpiry)}`,
        d.exitNode && 'The server sends its traffic through this device',
        d.offersExitNode && 'Offers itself as an exit node',
      ]
        .filter(Boolean)
        .join('\n'),
    );

  return (
    <Pressable
      onPress={details}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      <View style={[styles.dot, { backgroundColor: d.online ? StatusColors.good : StatusColors.idle }]} />
      <View style={styles.flex}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {d.name}
          <ThemedText type="small" themeColor="textSecondary">
            {`  ${OS_NAMES[d.os] ?? d.os}`}
          </ThemedText>
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.caption}>
          {caption}
        </ThemedText>
        {expiresSoon ? (
          <ThemedText type="small" style={[styles.caption, { color: theme.danger }]}>
            Key expires {formatWhen(d.keyExpiry!)}. Sign in again in Tailscale on it.
          </ThemedText>
        ) : null}
      </View>
      {!d.self && (d.rxBytes || d.txBytes) ? (
        <View style={styles.values}>
          <ThemedText type="small" style={[styles.caption, styles.tabular]}>
            ↑ {formatBytes(d.txBytes)}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={[styles.caption, styles.tabular]}>
            ↓ {formatBytes(d.rxBytes)}
          </ThemedText>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  health: {
    paddingVertical: Spacing.two,
    color: StatusColors.warn,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two + Spacing.one,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  flex: {
    flex: 1,
  },
  values: {
    alignItems: 'flex-end',
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
  caption: {
    fontSize: 13,
    lineHeight: 17,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
  },
});
