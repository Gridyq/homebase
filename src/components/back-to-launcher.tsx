import { router, Stack } from 'expo-router';

/**
 * Each mini-app's way back to the launcher, for its first screen. A native toolbar button renders
 * as a round Liquid Glass icon; a custom headerLeft view gets stretched into a pill around its
 * text. An element, not a component: Stack.Screen only picks up a Stack.Toolbar that is its direct
 * child.
 */
export const backToLauncher = (
  <Stack.Toolbar placement="left">
    <Stack.Toolbar.Button icon="chevron.left" onPress={() => router.dismissTo('/')}>
      Apps
    </Stack.Toolbar.Button>
  </Stack.Toolbar>
);
