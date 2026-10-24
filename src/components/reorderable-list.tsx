import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useTheme } from '@/hooks/use-theme';

/** How long a row is held before it lifts and can be dragged. */
const LIFT_MS = 300;
const SHIFT_MS = 150;

type Drag = {
  /** Each row's height, by index. */
  heights: SharedValue<number[]>;
  /** The row being dragged, or -1. */
  active: SharedValue<number>;
  /** Where it would land if let go now. */
  target: SharedValue<number>;
  /** How far it's been dragged. */
  offset: SharedValue<number>;
  /** The last index it can be dropped at. */
  last: SharedValue<number>;
};

/**
 * Rows that can be held and dragged into a new order. Only the first `movable` rows move, and only
 * among themselves; the rest stay put below them. `onMove` gets the row's old and new index.
 */
export function ReorderableList<T>({
  items,
  keyOf,
  movable,
  renderItem,
  onMove,
  onDragging,
}: {
  items: T[];
  keyOf: (item: T) => string;
  movable: number;
  renderItem: (item: T, index: number) => ReactNode;
  onMove: (from: number, to: number) => void;
  /** While a row is lifted, so the screen can stop scrolling under it. */
  onDragging?: (dragging: boolean) => void;
}) {
  const drag: Drag = {
    heights: useSharedValue<number[]>([]),
    active: useSharedValue(-1),
    target: useSharedValue(-1),
    offset: useSharedValue(0),
    last: useSharedValue(movable - 1),
  };
  const heights = useRef<number[]>([]);
  const order = items.map(keyOf).join('\n');

  useLayoutEffect(() => {
    drag.last.set(movable - 1);
  }, [drag.last, movable]);
  // Once the rows come back in their new order, drop the drag's shifts without animating them.
  useLayoutEffect(() => {
    drag.active.set(-1);
    drag.target.set(-1);
    drag.offset.set(0);
  }, [order, drag.active, drag.target, drag.offset]);

  return (
    <View>
      {items.map((item, i) => (
        <Row
          key={keyOf(item)}
          index={i}
          drag={drag}
          enabled={i < movable && movable > 1}
          onMove={onMove}
          onDragging={onDragging}
          onHeight={(h) => {
            heights.current[i] = h;
            drag.heights.set(heights.current.slice(0, items.length));
          }}>
          {renderItem(item, i)}
        </Row>
      ))}
    </View>
  );
}

function Row({
  index,
  drag,
  enabled,
  onMove,
  onDragging,
  onHeight,
  children,
}: {
  index: number;
  drag: Drag;
  enabled: boolean;
  onMove: (from: number, to: number) => void;
  onDragging?: (dragging: boolean) => void;
  onHeight: (height: number) => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  const { heights, active, target, offset, last } = drag;
  const dragging = (on: boolean) => onDragging?.(on);

  const pan = usePanGesture({
    enabled,
    activateAfterLongPress: LIFT_MS,
    onActivate: () => {
      'worklet';
      active.set(index);
      target.set(index);
      offset.set(0);
      scheduleOnRN(dragging, true);
    },
    onUpdate: (e) => {
      'worklet';
      offset.set(e.translationY);
      // The slot the middle of the dragged row is over, by where the rows sit before the drag.
      const h = heights.get();
      let top = 0;
      for (let j = 0; j < index; j++) top += h[j] ?? 0;
      const middle = top + (h[index] ?? 0) / 2 + e.translationY;
      let slot = 0;
      let edge = 0;
      for (let j = 0; j <= last.get(); j++) {
        edge += h[j] ?? 0;
        slot = j;
        if (middle < edge) break;
      }
      target.set(Math.max(0, Math.min(last.get(), slot)));
    },
    onDeactivate: () => {
      'worklet';
      const from = active.get();
      const to = target.get();
      if (from < 0) return;
      if (from === to) {
        offset.set(
          withTiming(0, { duration: SHIFT_MS }, () => {
            active.set(-1);
          }),
        );
      } else {
        // Settle into the new slot; the shifts are dropped when the rows come back reordered.
        const h = heights.get();
        let settle = 0;
        if (to > from) for (let j = from + 1; j <= to; j++) settle += h[j] ?? 0;
        else for (let j = to; j < from; j++) settle -= h[j] ?? 0;
        offset.set(withTiming(settle, { duration: SHIFT_MS }));
        scheduleOnRN(onMove, from, to);
      }
    },
    onFinalize: () => {
      'worklet';
      scheduleOnRN(dragging, false);
    },
  });

  const style = useAnimatedStyle(() => {
    const from = active.get();
    if (from === index) {
      return {
        zIndex: 1,
        transform: [{ translateY: offset.get() }, { scale: withTiming(1.02, { duration: SHIFT_MS }) }],
        shadowOpacity: withTiming(0.2, { duration: SHIFT_MS }),
      };
    }
    const to = target.get();
    const lifted = from >= 0 ? (heights.get()[from] ?? 0) : 0;
    const shift =
      from >= 0 && index > from && index <= to ? -lifted : from >= 0 && index < from && index >= to ? lifted : 0;
    return {
      zIndex: 0,
      transform: [{ translateY: from >= 0 ? withTiming(shift, { duration: SHIFT_MS }) : shift }, { scale: 1 }],
      shadowOpacity: 0,
    };
  });

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        onLayout={(e) => onHeight(e.nativeEvent.layout.height)}
        style={[
          {
            backgroundColor: theme.backgroundElement,
            shadowColor: '#000',
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 4 },
          },
          style,
        ]}>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}
