import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered } from '@/miniapps/jellyfin/components';
import { fetchDrives, type Drive } from '@/miniapps/server/api';
import {
  Card,
  formatBytes,
  formatPercent,
  formatWhen,
  Meter,
  NavRow,
  Section,
  StatusColors,
  usePullToRefresh,
} from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { driveHealthColor, driveHealthLabel, driveKindLabel, driveName, formatPowerOn } from '@/miniapps/server/drives';
import { usePolling } from '@/miniapps/server/use-polling';

const POLL_MS = 5000;

/** Each drive's health from SMART, what it's doing and who's using it. */
export default function DrivesScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const { data, error, refresh } = usePolling(() => fetchDrives(conn), POLL_MS, conn.url);
  const refreshControl = usePullToRefresh(refresh);

  if (!data) return <Centered loading={!error} error={error} onRetry={refresh} />;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter]}
      refreshControl={refreshControl}>
      {error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {error.message} Showing the last reading.
        </ThemedText>
      ) : null}
      {data.error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          Couldn&apos;t read the drives: {data.error}
        </ThemedText>
      ) : null}

      {data.drives.map((d) => (
        <DriveCard key={d.id} drive={d} />
      ))}

      <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
        Health comes from each drive&apos;s own SMART self-monitoring, which the server reads every 10
        minutes and sends a notification about when something turns bad. Busy is the share of time the
        drive was working; a hard drive near 100% is the bottleneck.
      </ThemedText>
    </ScrollView>
  );
}

function DriveCard({ drive: d }: { drive: Drive }) {
  const theme = useTheme();
  const s = d.smart;
  const busy = d.activity?.busy;

  const facts: [string, string][] = [];
  if (d.temperature !== undefined) facts.push(['Temperature', `${Math.round(d.temperature)}°C`]);
  if (s?.powerOnHours) facts.push(['Powered on', formatPowerOn(s.powerOnHours)]);
  if (s?.lifeLeft !== undefined) facts.push(['Life left', formatPercent(s.lifeLeft)]);
  if (s?.writtenBytes) facts.push(['Written over its life', formatBytes(s.writtenBytes)]);
  if (s?.readBytes) facts.push(['Read over its life', formatBytes(s.readBytes)]);
  if (s?.badSectors !== undefined) facts.push(['Bad sectors', String(s.badSectors)]);
  if (s?.spare !== undefined) facts.push(['Spare blocks', formatPercent(s.spare)]);
  if (s?.mediaErrors !== undefined) facts.push(['Data errors', String(s.mediaErrors)]);
  if (s?.cableErrors) facts.push(['Cable errors', String(s.cableErrors)]);
  if (s?.unsafeShutdowns !== undefined) facts.push(['Power cuts', String(s.unsafeShutdowns)]);
  if (s?.powerCycles !== undefined) facts.push(['Times switched on', String(s.powerCycles)]);
  if (s?.loadCycles !== undefined) facts.push(['Head parks', String(s.loadCycles)]);
  if (s?.selfTest) facts.push(['Last self-test', s.selfTest === 'success' ? 'Passed' : s.selfTest.replace(/_/g, ' ')]);

  return (
    <Section title={driveName(d)}>
      <Card>
        <View style={styles.body}>
          <View style={styles.line}>
            <View style={[styles.dot, { backgroundColor: driveHealthColor(d.health, theme.danger) }]} />
            <ThemedText type="smallBold" style={styles.flex}>
              {driveHealthLabel(d.health)}
            </ThemedText>
            {d.temperature !== undefined ? (
              <ThemedText type="small" themeColor="textSecondary" style={styles.tabular}>
                {Math.round(d.temperature)}°C
              </ThemedText>
            ) : null}
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            {[d.model, formatBytes(d.sizeBytes), driveKindLabel(d), d.mounts.length ? d.mounts.join(', ') : 'Not mounted']
              .filter(Boolean)
              .join(' · ')}
          </ThemedText>
          {d.issues.map((issue) => (
            <ThemedText
              key={issue.text}
              type="small"
              style={{ color: issue.level === 'failing' ? theme.danger : StatusColors.warn }}>
              {issue.text}
            </ThemedText>
          ))}

          {d.activity ? (
            <View style={styles.activity}>
              <View style={styles.line}>
                <ThemedText type="small" themeColor="textSecondary" style={styles.flex}>
                  Read {formatBytes(d.activity.readPerSec)}/s · write {formatBytes(d.activity.writePerSec)}/s
                </ThemedText>
                <ThemedText type="smallBold" style={styles.tabular}>
                  {formatPercent(busy)} busy
                </ThemedText>
              </View>
              <Meter fraction={busy} color={busy !== undefined && busy >= 0.9 ? theme.danger : busy !== undefined && busy >= 0.6 ? StatusColors.warn : StatusColors.good} />
            </View>
          ) : null}

          {d.users.length ? (
            <View style={styles.users}>
              <ThemedText type="small" themeColor="textSecondary">
                Using it now
              </ThemedText>
              {d.users.map((u) => (
                <View key={u.id ?? u.name} style={styles.line}>
                  <ThemedText
                    type="small"
                    style={[styles.flex, u.id ? { color: theme.accent } : undefined]}
                    numberOfLines={1}
                    onPress={u.id ? () => router.push({ pathname: '/server/service/[id]', params: { id: u.id! } }) : undefined}>
                    {u.name}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary" style={styles.tabular}>
                    {u.readPerSec ? `↓ ${formatBytes(u.readPerSec)}/s` : ''}
                    {u.readPerSec && u.writePerSec ? '  ' : ''}
                    {u.writePerSec ? `↑ ${formatBytes(u.writePerSec)}/s` : ''}
                  </ThemedText>
                </View>
              ))}
            </View>
          ) : null}

          {facts.length ? (
            <View style={styles.facts}>
              {facts.map(([label, value]) => (
                <View key={label} style={styles.line}>
                  <ThemedText type="small" themeColor="textSecondary" style={styles.flex}>
                    {label}
                  </ThemedText>
                  <ThemedText type="small" style={styles.tabular}>
                    {value}
                  </ThemedText>
                </View>
              ))}
              {s?.updated ? (
                <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
                  Checked {formatWhen(s.updated)}
                </ThemedText>
              ) : null}
            </View>
          ) : null}
        </View>
        <NavRow
          title="History"
          caption="Reads, writes, busy time and temperature"
          onPress={() => router.push({ pathname: '/server/drive/[id]', params: { id: d.id, name: driveName(d) } })}
        />
      </Card>
    </Section>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  body: {
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  line: {
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
  tabular: {
    fontVariant: ['tabular-nums'],
  },
  activity: {
    gap: Spacing.one,
    marginTop: Spacing.one,
  },
  users: {
    gap: Spacing.one,
  },
  facts: {
    gap: Spacing.one,
    marginTop: Spacing.one,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
  },
});
