import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { miniApps } from '@/miniapps/registry';

export default function Launcher() {
  const theme = useTheme();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.grid}
      style={{ backgroundColor: theme.background }}>
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
    padding: Spacing.three,
    gap: Spacing.three,
  },
  tile: {
    width: '30%',
    alignItems: 'center',
    gap: Spacing.one,
  },
  icon: {
    width: 72,
    height: 72,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: {
    color: '#fff',
    fontSize: 30,
    lineHeight: 36,
  },
  desc: {
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 14,
  },
});
