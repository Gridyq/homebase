import { Link, router, useFocusEffect } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState, type ComponentProps } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { describeRelease, Release } from '@/constants/release';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { miniApps, type MiniApp, type Shortcut } from '@/miniapps/registry';

const SEEN_UPDATE_KEY = 'homebase.seenUpdate';

export default function Launcher() {
  const theme = useTheme();
  const gutter = useGutter();
  const shortcuts = useShortcuts();
  useWhatsNewOnce();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      style={{ backgroundColor: theme.background }}>
      <View style={[styles.grid, gutter]}>
        {miniApps.map((app) => (
          <AppTile key={app.id} app={app} shortcuts={shortcuts[app.id] ?? []} />
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

/** A tap opens the mini-app; a long press shows its shortcuts. */
function AppTile({ app, shortcuts }: { app: MiniApp; shortcuts: Shortcut[] }) {
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
      {shortcuts.length ? (
        <Link.Menu>
          {shortcuts.map((s) => (
            <Link.MenuAction key={s.title} icon={s.icon} subtitle={s.subtitle} onPress={() => router.push(s.href)}>
              {s.title}
            </Link.MenuAction>
          ))}
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
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three,
  },
  tile: {
    width: 110,
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
