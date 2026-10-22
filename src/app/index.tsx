import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { UpdateBanner } from '@/components/update-banner';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { miniApps } from '@/miniapps/registry';

export default function Launcher() {
  const theme = useTheme();
  const gutter = useGutter();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.grid, gutter]}
      style={{ backgroundColor: theme.background }}>
      <UpdateBanner />
      {miniApps.map((app) => (
        <Link key={app.id} href={app.href} asChild>
          <Pressable style={({ pressed }) => [styles.tile, { opacity: pressed ? 0.6 : 1 }]}>
            <View style={[styles.icon, { backgroundColor: app.color }]}>
              <ThemedText style={styles.glyph}>{app.glyph}</ThemedText>
            </View>
            <ThemedText type="smallBold" numberOfLines={1}>
              {app.name}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={2} style={styles.desc}>
              {app.description}
            </ThemedText>
          </Pressable>
        </Link>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingVertical: Spacing.three,
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
});
