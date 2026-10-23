import { Link, router, useFocusEffect } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState, type ComponentProps } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { describeRelease, Release } from '@/constants/release';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { miniApps, type Activity, type MiniApp, type Shortcut } from '@/miniapps/registry';
import { Card, Meter, StatusColors } from '@/miniapps/server/components';
import { usePolling } from '@/miniapps/server/use-polling';

const SEEN_UPDATE_KEY = 'homebase.seenUpdate';
const ORDER_KEY = 'launcher.order';
const ACTIVITY_POLL_MS = 10_000;
const TILE_MIN_WIDTH = 104;
const TILE_GAP = Spacing.three;

export default function Launcher() {
  const theme = useTheme();
  const gutter = useGutter();
  const { width } = useWindowDimensions();
  const shortcuts = useShortcuts();
  const [apps, moveToStart, ordered] = useAppOrder();
  // Waits for the saved order, so the first Now list isn't thrown away when the order arrives.
  const activity = usePolling(() => loadActivity(apps), ACTIVITY_POLL_MS, 'launcher', { enabled: ordered });
  useWhatsNewOnce();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      style={{ backgroundColor: theme.background }}>
      {activity.data?.length ? <NowList items={activity.data} /> : null}
      <View style={[styles.grid, gutter]}>
        {/* Not drawn until the saved order is known, or the tiles would jump into place. */}
        {!ordered ? null : apps.map((app, i) => (
          <View key={app.id} style={{ width: tileWidth(width - gutter.paddingLeft - gutter.paddingRight) }}>
            <AppTile
              app={app}
              shortcuts={shortcuts[app.id] ?? []}
              onMoveToStart={i > 0 ? () => moveToStart(app.id) : undefined}
            />
          </View>
        ))}
      </View>
      <Pressable onPress={() => router.push('/whats-new')} style={[styles.footer, gutter]}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.footerText}>
          {describeRelease(Release.version, Release.update?.createdAt)}
        </ThemedText>
      </Pressable>
    </ScrollView>
  );
}

/**
 * Tiles sit in fixed columns that fill the row. Link wraps each tile in a native view whose size
 * we don't control, so the column box, not the tile, sets the layout and keeps rows lined up.
 */
function tileWidth(available: number) {
  const columns = Math.max(1, Math.floor((available + TILE_GAP) / (TILE_MIN_WIDTH + TILE_GAP)));
  return Math.floor((available - TILE_GAP * (columns - 1)) / columns);
}

type LiveActivity = Activity & { app: MiniApp };

/** Every app's activity, in launcher order. An app that can't answer just stays quiet. */
async function loadActivity(apps: MiniApp[]): Promise<LiveActivity[]> {
  const lists = await Promise.all(
    apps.map(async (app) => ((await app.activity?.().catch(() => [])) ?? []).map((a) => ({ ...a, app }))),
  );
  return lists.flat();
}

function NowList({ items }: { items: LiveActivity[] }) {
  const gutter = useGutter();
  return (
    <View style={[styles.now, gutter]}>
      <ThemedText type="smallBold" themeColor="textSecondary">
        Now
      </ThemedText>
      <Card>
        {items.map((item, i) => (
          <ActivityRow key={`${item.app.id}:${item.key}`} item={item} first={i === 0} />
        ))}
      </Card>
    </View>
  );
}

function ActivityRow({ item, first }: { item: LiveActivity; first: boolean }) {
  const theme = useTheme();
  const color = item.tone === 'bad' ? theme.danger : item.tone === 'warn' ? StatusColors.warn : StatusColors.good;
  return (
    <Pressable
      onPress={() => router.push(item.href)}
      style={({ pressed }) => [
        styles.activity,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      <View style={[styles.badge, { backgroundColor: item.app.color }]}>
        <ThemedText style={styles.badgeGlyph}>{item.app.glyph}</ThemedText>
      </View>
      <View style={styles.activityText}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {item.title}
        </ThemedText>
        {item.fraction !== undefined ? <Meter fraction={item.fraction} color={color} /> : null}
        {item.caption ? (
          <ThemedText
            type="small"
            themeColor="textSecondary"
            numberOfLines={1}
            style={[styles.caption, item.tone === 'warn' || item.tone === 'bad' ? { color } : undefined]}>
            {item.caption}
          </ThemedText>
        ) : null}
      </View>
    </Pressable>
  );
}

/** A tap opens the mini-app; a long press shows its shortcuts and lets it move to the front. */
function AppTile({ app, shortcuts, onMoveToStart }: { app: MiniApp; shortcuts: Shortcut[]; onMoveToStart?: () => void }) {
  return (
    <Link href={app.href} asChild>
      <Link.Trigger>
        <TilePressable>
          <View style={[styles.icon, { backgroundColor: app.color }]}>
            <ThemedText style={styles.glyph}>{app.glyph}</ThemedText>
          </View>
          <ThemedText type="smallBold" numberOfLines={1}>
            {app.name}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={2} style={styles.desc}>
            {app.description}
          </ThemedText>
        </TilePressable>
      </Link.Trigger>
      {shortcuts.length || onMoveToStart ? (
        <Link.Menu>
          {shortcuts.map((s) => (
            <Link.MenuAction key={s.title} icon={s.icon} subtitle={s.subtitle} onPress={() => router.push(s.href)}>
              {s.title}
            </Link.MenuAction>
          ))}
          {onMoveToStart ? (
            <Link.MenuAction icon="arrow.up.left" onPress={onMoveToStart}>
              Move to start
            </Link.MenuAction>
          ) : null}
        </Link.Menu>
      ) : null}
    </Link>
  );
}

/**
 * Link passes its props through Slot, which flattens `style` and would drop a Pressable style
 * function (and with it the tile width), so track the pressed state here instead.
 */
function TilePressable({ style, onPressIn, onPressOut, ...props }: ComponentProps<typeof Pressable>) {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      {...props}
      onPressIn={(e: GestureResponderEvent) => {
        setPressed(true);
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        setPressed(false);
        onPressOut?.(e);
      }}
      style={[style as object, styles.tile, { opacity: pressed ? 0.6 : 1 }]}
    />
  );
}

/** Each mini-app's shortcuts, refreshed whenever the launcher comes back into view. */
function useShortcuts() {
  const [shortcuts, setShortcuts] = useState<Record<string, Shortcut[]>>({});
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      Promise.all(
        miniApps.map(async (app) => [app.id, (await app.shortcuts?.().catch(() => [])) ?? []] as const),
      ).then((entries) => !cancelled && setShortcuts(Object.fromEntries(entries)));
      return () => {
        cancelled = true;
      };
    }, []),
  );
  return shortcuts;
}

/** The mini-apps in the order the user arranged them; new ones go at the end. */
function useAppOrder() {
  const [order, setOrder] = useState<string[]>([]);
  const [ordered, setOrdered] = useState(false);
  useEffect(() => {
    SecureStore.getItemAsync(ORDER_KEY)
      .then((raw) => raw && setOrder(JSON.parse(raw)))
      .catch(() => undefined)
      .finally(() => setOrdered(true));
  }, []);
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length + miniApps.findIndex((a) => a.id === id) : i;
  };
  const apps = [...miniApps].sort((a, b) => rank(a.id) - rank(b.id));
  const moveToStart = (id: string) => {
    const next = [id, ...apps.map((a) => a.id).filter((a) => a !== id)];
    setOrder(next);
    SecureStore.setItemAsync(ORDER_KEY, JSON.stringify(next)).catch(() => undefined);
  };
  return [apps, moveToStart, ordered] as const;
}

/** Show "What's new" the first time the app starts on a newly downloaded update. */
function useWhatsNewOnce() {
  useEffect(() => {
    const { update, notes } = Release;
    if (!update) return;
    SecureStore.getItemAsync(SEEN_UPDATE_KEY)
      .then(async (seen) => {
        if (seen === update.id) return;
        await SecureStore.setItemAsync(SEEN_UPDATE_KEY, update.id);
        if (notes.length) router.push('/whats-new');
      })
      .catch(() => undefined);
  }, []);
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingVertical: Spacing.three,
  },
  now: {
    gap: Spacing.two,
    marginBottom: Spacing.four,
  },
  activity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two + Spacing.one,
  },
  activityText: {
    flex: 1,
    gap: Spacing.one,
  },
  badge: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeGlyph: {
    color: '#fff',
    fontSize: 16,
    lineHeight: 20,
  },
  caption: {
    fontSize: 13,
    lineHeight: 17,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: TILE_GAP,
  },
  tile: {
    width: '100%',
    alignItems: 'center',
    gap: Spacing.one,
  },
  icon: {
    width: 80,
    height: 80,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: {
    color: '#fff',
    fontSize: 34,
    lineHeight: 40,
  },
  desc: {
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 17,
  },
  footer: {
    marginTop: 'auto',
    paddingTop: Spacing.five,
  },
  footerText: {
    textAlign: 'center',
    fontSize: 13,
  },
});
