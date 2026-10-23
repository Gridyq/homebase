import { router } from 'expo-router';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { describeRelease, Release } from '@/constants/release';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export default function WhatsNew() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { update, notes, version } = Release;

  return (
    // collapsable={false}: otherwise Fabric flattens this view, the ScrollView becomes a direct child of the
    // sheet, and react-native-screens stretches it over the whole sheet from the top-left corner.
    <View collapsable={false} style={[styles.sheet, { paddingBottom: insets.bottom + Spacing.three }]}>
      <View style={styles.heading}>
        <ThemedText type="subtitle">What&apos;s new</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {describeRelease(version, update?.createdAt)}
        </ThemedText>
      </View>
      {/* After a long gap between updates the notes can run past the screen; Done stays in reach. */}
      <ScrollView style={{ maxHeight: height * 0.6 }} contentContainerStyle={styles.notes} bounces={false}>
        {notes.length ? (
          notes.map((note, i) => (
            <View key={i} style={styles.note}>
              <View style={[styles.bullet, { backgroundColor: theme.accent }]} />
              <ThemedText style={styles.noteText}>{note}</ThemedText>
            </View>
          ))
        ) : (
          <ThemedText themeColor="textSecondary">No notes for this version.</ThemedText>
        )}
      </ScrollView>
      <Button title="Done" onPress={() => router.back()} />
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.five,
    gap: Spacing.four,
  },
  heading: {
    gap: Spacing.one,
  },
  notes: {
    gap: Spacing.two,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  bullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 9,
  },
  noteText: {
    flex: 1,
  },
});
