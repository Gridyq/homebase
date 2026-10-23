import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { PixelRatio, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { Centered, itemHref } from '@/miniapps/jellyfin/components';
import { useJellyfinSession } from '@/miniapps/jellyfin/session';
import { useAsync } from '@/miniapps/jellyfin/use-async';
import {
  favoriteTimeOfDay,
  formatWatchTime,
  loadHistory,
  type History,
  type Period,
  type RecentPlay,
  type Title,
} from '@/miniapps/history/stats';
import { Card, formatWhen, Meter, Section, Segmented, StatTile, TimeChart } from '@/miniapps/server/components';

const PERIODS: { value: Period; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All time' },
];

const EMPTY_MESSAGE: Record<Period, string> = {
  week: 'Nothing watched in the last week.',
  month: 'Nothing watched in the last 30 days.',
  year: 'Nothing watched in the last year.',
  all: 'Nothing watched yet. Plays are recorded from when watch history was turned on.',
};

const POSTER_HEIGHT = 60;

export default function HistoryHome() {
  const { client } = useJellyfinSession();
  const theme = useTheme();
  const gutter = useGutter();
  const [period, setPeriod] = useState<Period>('month');
  const { data, error, loading, reload } = useAsync(
    () => (client ? loadHistory(client, period) : Promise.resolve(undefined)),
    `${client?.session.userId}:${period}`,
  );

  if (!client) {
    return (
      <View style={[styles.empty, gutter, { backgroundColor: theme.background }]}>
        <ThemedText type="smallBold">Not signed in</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
          Watch history comes from Jellyfin. Sign in there first.
        </ThemedText>
        <Button title="Open Jellyfin" onPress={() => router.push('/jellyfin')} />
      </View>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter]}
      // Only for a reload: another period starts blank and shows its own spinner.
      refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}>
      <Segmented options={PERIODS} value={period} onChange={setPeriod} />
      {data && error ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          Couldn&apos;t refresh. {error.message}
        </ThemedText>
      ) : null}
      {data ? (
        <Stats history={data} period={period} />
      ) : error ? (
        <Centered error={error} onRetry={reload} />
      ) : loading ? (
        <Centered loading />
      ) : null}
    </ScrollView>
  );
}

function Stats({ history: h, period }: { history: History; period: Period }) {
  const theme = useTheme();
  if (!h.seconds) {
    return (
      <ThemedText themeColor="textSecondary" style={[styles.center, styles.emptyText]}>
        {EMPTY_MESSAGE[period]}
      </ThemedText>
    );
  }

  const when = favoriteTimeOfDay(h.hours);
  const first = h.buckets[0]?.start ?? h.at;
  const bucketLabel = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, h.monthly ? { month: 'short', year: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' });
  const topShow = h.topShows[0]?.seconds ?? 1;
  const topMovie = h.topMovies[0]?.seconds ?? 1;

  return (
    <>
      <View style={styles.tiles}>
        <StatTile
          label="Watched"
          value={formatWatchTime(h.seconds)}
          caption={h.periodDays > 1 ? `${formatWatchTime(h.seconds / h.periodDays)} a day` : undefined}
        />
        <StatTile
          label="Days watching"
          value={String(h.daysWatched)}
          caption={h.longestStreak > 1 ? `Best streak ${h.longestStreak} days` : `of ${h.periodDays}`}
        />
        <StatTile
          label="Episodes"
          value={String(h.episodes)}
          caption={h.shows ? `From ${h.shows} ${h.shows === 1 ? 'show' : 'shows'}` : undefined}
        />
        <StatTile label="Movies" value={String(h.movies)} />
      </View>

      {h.buckets.length > 1 ? (
        <Section title={h.monthly ? 'By month' : 'By day'}>
          <Card>
            <View style={styles.chart}>
              <TimeChart
                values={h.buckets.map((b) => b.seconds)}
                start={first}
                end={h.at}
                format={formatWatchTime}
                color={theme.accent}
                label={(i) => bucketLabel(h.buckets[i].start)}
                startLabel={bucketLabel(first)}
                endLabel={h.monthly ? 'This month' : 'Today'}
              />
            </View>
          </Card>
        </Section>
      ) : null}

      <Section title="Time of day">
        <Card>
          <View style={styles.chart}>
            {when ? (
              <ThemedText type="small" themeColor="textSecondary">
                You mostly watch {when}.
              </ThemedText>
            ) : null}
            <TimeChart
              values={h.hours}
              start={0}
              end={24}
              format={formatWatchTime}
              color={theme.accent}
              height={80}
              label={(i) => `${hourLabel(i)}–${hourLabel(i + 1)}`}
              startLabel="Midnight"
              endLabel="11 PM"
            />
          </View>
        </Card>
      </Section>

      {h.topShows.length ? (
        <Section title="Top shows">
          <Card>
            {h.topShows.map((t, i) => (
              <TitleRow
                key={t.key}
                title={t}
                first={i === 0}
                fraction={t.seconds / topShow}
                caption={[t.episodes && `${t.episodes} ${t.episodes === 1 ? 'episode' : 'episodes'}`, formatWatchTime(t.seconds)]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ))}
          </Card>
        </Section>
      ) : null}

      {h.topMovies.length ? (
        <Section title="Top movies">
          <Card>
            {h.topMovies.map((t, i) => (
              <TitleRow key={t.key} title={t} first={i === 0} fraction={t.seconds / topMovie} caption={formatWatchTime(t.seconds)} />
            ))}
          </Card>
        </Section>
      ) : null}

      {h.rewatched.length ? (
        <Section title="Rewatched">
          <Card>
            {h.rewatched.map((t, i) => (
              <TitleRow key={t.key} title={t} first={i === 0} caption={`Watched on ${t.days} different days`} />
            ))}
          </Card>
        </Section>
      ) : null}

      {h.recent.length ? (
        <Section title="Recently watched">
          <Card>
            {h.recent.map((p, i) => (
              <RecentRow key={p.key} play={p} first={i === 0} />
            ))}
          </Card>
        </Section>
      ) : null}
    </>
  );
}

function hourLabel(hour: number) {
  const h = hour % 24;
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function Poster({ item, name }: { item?: Title['item']; name: string }) {
  const { client } = useJellyfinSession();
  const theme = useTheme();
  const uri = item && client?.imageUrl(item, { height: PixelRatio.getPixelSizeForLayoutSize(POSTER_HEIGHT) });
  return (
    <View style={[styles.poster, { backgroundColor: theme.backgroundSelected }]}>
      {uri ? (
        <Image source={uri} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
      ) : (
        <ThemedText type="smallBold" themeColor="textSecondary">
          {name.slice(0, 1)}
        </ThemedText>
      )}
    </View>
  );
}

function Row({
  item,
  name,
  first,
  children,
}: {
  item?: Title['item'];
  name: string;
  first: boolean;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={item ? () => router.push(itemHref(item)) : undefined}
      disabled={!item}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      <Poster item={item} name={name} />
      <View style={styles.rowText}>{children}</View>
    </Pressable>
  );
}

function TitleRow({ title, first, fraction, caption }: { title: Title; first: boolean; fraction?: number; caption: string }) {
  const theme = useTheme();
  return (
    <Row item={title.item} name={title.name} first={first}>
      <ThemedText type="smallBold" numberOfLines={1}>
        {title.name}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.caption}>
        {caption}
      </ThemedText>
      {fraction !== undefined ? <Meter fraction={fraction} color={theme.accent} /> : null}
    </Row>
  );
}

function RecentRow({ play, first }: { play: RecentPlay; first: boolean }) {
  return (
    <Row item={play.item} name={play.title} first={first}>
      <ThemedText type="smallBold" numberOfLines={1}>
        {play.title}
      </ThemedText>
      {play.subtitle ? (
        <ThemedText type="small" numberOfLines={1} style={styles.caption}>
          {play.subtitle}
        </ThemedText>
      ) : null}
      <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.caption}>
        {formatWhen(play.at)} · {formatWatchTime(play.seconds)}
      </ThemedText>
    </Row>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: Spacing.two,
    paddingBottom: Spacing.five,
    gap: Spacing.three,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  emptyText: {
    marginTop: Spacing.four,
  },
  center: {
    textAlign: 'center',
  },
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chart: {
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
  },
  rowText: {
    flex: 1,
    gap: Spacing.half,
  },
  poster: {
    width: POSTER_HEIGHT * (2 / 3),
    height: POSTER_HEIGHT,
    borderRadius: 6,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  caption: {
    fontSize: 13,
    lineHeight: 17,
  },
});
