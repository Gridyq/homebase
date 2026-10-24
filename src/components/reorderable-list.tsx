import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { View } from 'react-native';
import { GestureDetector, usePanGesture, type PanGestureConfig } from 'react-native-gesture-handler';
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
  const heights = useSharedValue<number[]>([]);
  const active = useSharedValue(-1);
  const target = useSharedValue(-1);
  const offset = useSharedValue(0);
  const last = useSharedValue(movable - 1);
  const drag: Drag = useMemo(
    () => ({ heights, active, target, offset, last }),
    [heights, active, target, offset, last],
  );
  const keys = items.map(keyOf);
  const order = keys.join('\n');

  // Heights by key, so a row that moves or a row that leaves can't leave another's height behind.
  const sizes = useRef(new Map<string, number>());
  const keysRef = useRef(keys);
  const syncHeights = useCallback(() => {
    heights.set(keysRef.current.map((k) => sizes.current.get(k) ?? 0));
  }, [heights]);
  const onHeight = useCallback(
    (key: string, h: number) => {
      sizes.current.set(key, h);
      syncHeights();
    },
    [syncHeights],
  );

  // The gestures call these through refs, so they keep their handlers from one render to the next.
  const latest = useRef({ onMove, onDragging });
  useLayoutEffect(() => {
    latest.current = { onMove, onDragging };
  });
  const move = useCallback((from: number, to: number) => latest.current.onMove(from, to), []);
  const dragging = useCallback((on: boolean) => latest.current.onDragging?.(on), []);

  useLayoutEffect(() => {
    last.set(movable - 1);
  }, [last, movable]);
  // Once the rows come back in their new order, drop the drag's shifts without animating them.
  useLayoutEffect(() => {
    keysRef.current = order ? order.split('\n') : [];
    syncHeights();
    active.set(-1);
    target.set(-1);
    offset.set(0);
  }, [order, syncHeights, active, target, offset]);

  return (
    <View>
      {items.map((item, i) => (
        <Row
          key={keys[i]}
          id={keys[i]}
          index={i}
          drag={drag}
          enabled={i < movable && movable > 1}
          onMove={move}
          onDragging={dragging}
          onHeight={onHeight}>
          {renderItem(item, i)}
        </Row>
      ))}
    </View>
  );
}

function Row({
  id,
  index,
  drag,
  enabled,
  onMove,
  onDragging,
  onHeight,
  children,
}: {
  id: string;
  index: number;
  drag: Drag;
  enabled: boolean;
  onMove: (from: number, to: number) => void;
  onDragging: (dragging: boolean) => void;
  onHeight: (key: string, height: number) => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  const { heights, active, target, offset, last } = drag;

  // Made once per index, so a screen re-rendering under a drag doesn't reconfigure its gesture.
  const config = useMemo<PanGestureConfig>(
    () => ({
      enabled,
      activateAfterLongPress: LIFT_MS,
      onActivate: () => {
        'worklet';
        active.set(index);
        target.set(index);
        offset.set(0);
        scheduleOnRN(onDragging, true);
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
        scheduleOnRN(onDragging, false);
      },
    }),
    [enabled, index, heights, active, target, offset, last, onMove, onDragging],
  );
  const pan = usePanGesture(config);

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
      transform: [
        {
          translateY: from >= 0 ? withTiming(shift, { duration: SHIFT_MS }) : shift,
        },
        { scale: 1 },
      ],
      shadowOpacity: 0,
    };
  });

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        onLayout={(e) => onHeight(id, e.nativeEvent.layout.height)}
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
