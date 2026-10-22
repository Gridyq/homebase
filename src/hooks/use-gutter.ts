import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Spacing } from '@/constants/theme';

/**
 * Side padding for screen content: the usual margin plus the safe area, which in landscape
 * keeps content clear of the Dynamic Island and rounded corners.
 */
export function useGutter() {
  const insets = useSafeAreaInsets();
  return { paddingLeft: insets.left + Spacing.three, paddingRight: insets.right + Spacing.three };
}
