import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function Button({
  title,
  onPress,
  disabled,
  variant = 'primary',
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
}) {
  const theme = useTheme();
  const primary = variant === 'primary';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? theme.accent : theme.backgroundElement,
          opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
        },
      ]}>
      <ThemedText style={[styles.buttonText, { color: primary ? '#fff' : theme.text }]}>{title}</ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingVertical: 14,
    paddingHorizontal: Spacing.four,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonText: {
    fontWeight: 600,
  },
});
