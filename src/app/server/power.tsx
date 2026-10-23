import { useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Centered } from '@/components/centered';
import { Fonts, Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';

import { fetchGpu, fetchHistory, fetchPower, savePower, type PowerSettings } from '@/miniapps/server/api';
import { Card, Section, Segmented, StatTile, StatusColors, usePullToRefresh, useSeriesColors } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { useEventMarkers } from '@/miniapps/server/events';
import { HistoryNote, LONG_RANGES, rangeName, TrendCard } from '@/miniapps/server/trends';
import { usePolling, useRangedPolling } from '@/miniapps/server/use-polling';
import { errorText } from '@/utils/error-text';
import { formatEnergy } from '@/utils/format';

const LIVE_POLL_MS = 5000;
const HISTORY_POLL_MS = 60_000;
const HOURS_PER_MONTH = 730;
const formatWatts = (w: number) => `${Math.round(w)} W`;
const formatKwh = (kwh: number) => `${kwh >= 100 ? Math.round(kwh) : kwh.toFixed(1)} kWh`;

/** What the server draws, from its CPU's and graphics card's own meters, and what that costs. */
export default function PowerScreen() {
  const { connection } = useServerConnection();
  const conn = connection!;
  const theme = useTheme();
  const gutter = useGutter();
  const colors = useSeriesColors();
  const power = usePolling(() => fetchPower(conn), LIVE_POLL_MS, conn.url);
  const gpu = usePolling(() => fetchGpu(conn), LIVE_POLL_MS, conn.url);
  const history = useRangedPolling(LONG_RANGES[1].value, (range) => fetchHistory(conn, range), HISTORY_POLL_MS, conn.url);
  const { range, setRange } = history;
  const refreshControl = usePullToRefresh(power.refresh, gpu.refresh, history.refresh);
  const markers = useEventMarkers(history.data?.events);

  const settings = power.data;
  if (!settings) return <Centered loading={!power.error} error={power.error} onRetry={power.refresh} />;

  const gpuWatts = gpu.data?.power?.watts;
  const nowTotal = (settings.cpuWatts ?? 0) + (gpuWatts ?? 0) + settings.otherWatts;
  const series = history.data?.series;
  const cpuAvg = series?.cpuPower.average;
  const gpuAvg = series?.gpuPower.average;
  const averageWatts = (cpuAvg ?? 0) + (gpuAvg ?? 0) + settings.otherWatts;
  const measured = (series?.cpuPower.total ?? 0) + (series?.gpuPower.total ?? 0);
  const price = settings.pricePerKwh;
  const cost = (kwh: number) => (price === undefined ? undefined : `${settings.currency}${(kwh * price).toFixed(2)}`);
  const perDay = (averageWatts * 24) / 1000;
  const perMonth = (averageWatts * HOURS_PER_MONTH) / 1000;

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.content, gutter]}
        keyboardShouldPersistTaps="handled"
        refreshControl={refreshControl}>
        {power.error ? (
          <ThemedText type="small" style={{ color: theme.danger }}>
            {power.error.message} Showing the last reading.
          </ThemedText>
        ) : null}

        <View style={styles.tiles}>
          <StatTile label="Now" value={formatWatts(nowTotal)} caption={settings.otherWatts ? 'with the estimate' : 'measured'} />
          <StatTile label="CPU" value={settings.cpuWatts === undefined ? '–' : formatWatts(settings.cpuWatts)} caption="package" />
          <StatTile label="Graphics card" value={gpuWatts === undefined ? '–' : formatWatts(gpuWatts)} caption="board" />
        </View>

        {settings.cpuPowerError === 'permission' ? (
          <Card>
            <View style={styles.body}>
              <ThemedText type="smallBold">CPU power needs a one-time setup</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                Only root can read the CPU&apos;s energy meter. On the server, run{' '}
                <ThemedText type="small" style={styles.code}>
                  sudo bash ~/rapl.sh
                </ThemedText>{' '}
                once to let the status server read it. Until then only the graphics card is counted.
              </ThemedText>
            </View>
          </Card>
        ) : null}

        <Section title="Use and cost">
          <Segmented value={range} onChange={setRange} options={LONG_RANGES} />
          {series ? (
            <View style={[styles.stack, history.stale && styles.stale]}>
              <Card>
                <View style={styles.body}>
                  <Row label="Average draw" value={formatWatts(averageWatts)} />
                  <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
                    {[
                      cpuAvg !== undefined && `CPU ${formatWatts(cpuAvg)}`,
                      gpuAvg !== undefined && `graphics card ${formatWatts(gpuAvg)}`,
                      settings.otherWatts && `rest of the PC ${formatWatts(settings.otherWatts)} (estimate)`,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </ThemedText>
                  <Row label="Per day" value={[formatKwh(perDay), cost(perDay)].filter(Boolean).join(' · ')} />
                  <Row label="Per month" value={[formatKwh(perMonth), cost(perMonth)].filter(Boolean).join(' · ')} />
                  <Row label={`Measured in ${rangeName(range)}`} value={formatEnergy(measured)} />
                </View>
              </Card>
              <HistoryNote history={history.data!} />
              {series.cpuPower.average !== undefined ? (
                <TrendCard title="CPU" series={series.cpuPower} history={history.data!} format={formatWatts} color={colors[1]} markers={markers} />
              ) : null}
              <TrendCard title="Graphics card" series={series.gpuPower} history={history.data!} format={formatWatts} color={colors[0]} markers={markers} />
            </View>
          ) : (
            <Centered loading={!history.error} error={history.error} onRetry={history.refresh} />
          )}
        </Section>

        <PriceForm key={`${settings.pricePerKwh}|${settings.currency}|${settings.otherWatts}`} settings={settings} onSaved={power.refresh} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.flex}>
        {label}
      </ThemedText>
      <ThemedText type="smallBold" style={styles.tabular}>
        {value}
      </ThemedText>
    </View>
  );
}

function PriceForm({ settings, onSaved }: { settings: PowerSettings; onSaved: () => Promise<void> }) {
  const { connection } = useServerConnection();
  const theme = useTheme();
  const [price, setPrice] = useState(settings.pricePerKwh?.toString() ?? '');
  const [currency, setCurrency] = useState(settings.currency);
  const [other, setOther] = useState(String(settings.otherWatts));
  const [busy, setBusy] = useState(false);
  const inputStyle = [styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text }];

  const save = async () => {
    const number = (s: string) => Number(s.replace(',', '.'));
    if (price.trim() && Number.isNaN(number(price))) return Alert.alert('The price should be a number, like 0.25');
    if (Number.isNaN(number(other || '0'))) return Alert.alert('The estimate should be a number of watts, like 40');
    setBusy(true);
    try {
      await savePower(connection!, {
        pricePerKwh: price.trim() ? number(price) : null,
        currency: currency.trim() || '$',
        otherWatts: number(other || '0'),
      });
      await onSaved();
    } catch (e) {
      Alert.alert("Couldn't save", errorText(e));
    }
    setBusy(false);
  };

  return (
    <Section title="Settings">
      <Card>
        <View style={styles.body}>
          <View style={styles.fields}>
            <View style={styles.field}>
              <ThemedText type="small" themeColor="textSecondary">
                Price per kWh
              </ThemedText>
              <TextInput style={inputStyle} value={price} onChangeText={setPrice} placeholder="0.25" placeholderTextColor={theme.textSecondary} keyboardType="decimal-pad" />
            </View>
            <View style={styles.currency}>
              <ThemedText type="small" themeColor="textSecondary">
                Currency
              </ThemedText>
              <TextInput style={inputStyle} value={currency} onChangeText={setCurrency} maxLength={4} autoCorrect={false} />
            </View>
          </View>
          <View style={styles.field}>
            <ThemedText type="small" themeColor="textSecondary">
              Rest of the PC, in watts
            </ThemedText>
            <TextInput style={inputStyle} value={other} onChangeText={setOther} placeholder="0" placeholderTextColor={theme.textSecondary} keyboardType="number-pad" />
          </View>
          <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
            Only the CPU and graphics card measure their own power. Drives, the motherboard, memory, fans
            and the power supply&apos;s losses usually add 30–60 W more on a desktop; a plug-in meter at
            the wall tells you exactly.
          </ThemedText>
          {price.trim() === '' ? (
            <ThemedText type="small" style={{ color: StatusColors.warn }}>
              Set the price to see what it costs.
            </ThemedText>
          ) : null}
          <Button title={busy ? 'Saving…' : 'Save'} disabled={busy} onPress={save} />
        </View>
      </Card>
    </Section>
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
  stack: {
    gap: Spacing.two,
  },
  stale: {
    opacity: 0.5,
  },
  body: {
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.two,
  },
  flex: {
    flex: 1,
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
  },
  code: {
    fontFamily: Fonts.mono,
  },
  fields: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  field: {
    flex: 1,
    gap: Spacing.one,
  },
  currency: {
    width: 90,
    gap: Spacing.one,
  },
  input: {
    borderRadius: 10,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
});
