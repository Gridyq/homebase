import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { ActionSheetIOS, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { assistantState, deleteChat, listChats, newChatId, type ChatSummary } from '@/miniapps/assistant/api';
import { type Connection } from '@/miniapps/server/api';
import { Card, formatWhen, PollStatus } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';

const POLL_MS = 10_000;

export default function AssistantHome() {
  const { connection } = useServerConnection();
  const theme = useTheme();
  const gutter = useGutter();

  if (!connection) {
    return (
      <View style={[styles.empty, gutter, { backgroundColor: theme.background }]}>
        <ThemedText type="smallBold">Not connected</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
          The assistant runs on the home server. Connect the Server app first.
        </ThemedText>
        <Button title="Set up connection" onPress={() => router.push('/server/connect')} />
      </View>
    );
  }
  return <Chats key={`${connection.url}|${connection.token}`} conn={connection} />;
}

function Chats({ conn }: { conn: Connection }) {
  const theme = useTheme();
  const gutter = useGutter();
  const [pulled, setPulled] = useState(false);
  const chats = usePolling(() => listChats(conn), POLL_MS, conn.url);
  const state = usePolling(() => assistantState(conn), POLL_MS, conn.url);
  const model = state.data?.models[0];

  const showActions = (chat: ChatSummary) =>
    ActionSheetIOS.showActionSheetWithOptions(
      { title: chat.title, options: ['Delete chat', 'Cancel'], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
      (index) => {
        if (index !== 0) return;
        deleteChat(conn, chat.id).then(chats.refresh, (e: Error) => Alert.alert('Couldn’t delete the chat', e.message));
      },
    );

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="square.and.pencil" onPress={() => router.push(`/assistant/${newChatId()}`)}>
          New chat
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={[styles.content, gutter]}
        refreshControl={
          <RefreshControl
            refreshing={pulled}
            onRefresh={async () => {
              setPulled(true);
              await Promise.all([chats.refresh(), state.refresh()]);
              setPulled(false);
            }}
          />
        }>
        {state.data ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
            {state.data.gameMode
              ? 'Game mode is on, so the assistant is off until the game closes.'
              : model
                ? `${model.name} · ${describeModel(model.state)}`
                : 'No models are set up on the server.'}
          </ThemedText>
        ) : null}

        <PollStatus error={chats.error} loaded={!!chats.data} onRetry={chats.refresh} />
        {chats.data?.length ? (
          <Card>
            {chats.data.map((chat, i) => (
              <Pressable
                key={chat.id}
                onPress={() => router.push(`/assistant/${chat.id}`)}
                onLongPress={() => showActions(chat)}
                style={({ pressed }) => [
                  styles.row,
                  i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
                  { opacity: pressed ? 0.6 : 1 },
                ]}>
                <View style={styles.rowTop}>
                  <ThemedText type="smallBold" numberOfLines={1} style={styles.title}>
                    {chat.title}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
                    {chat.answering ? 'Answering…' : formatWhen(chat.updatedAt)}
                  </ThemedText>
                </View>
                {chat.preview ? (
                  <ThemedText type="small" themeColor="textSecondary" numberOfLines={2} style={styles.caption}>
                    {chat.preview.replace(/[#*`_>]/g, '').replace(/\s+/g, ' ').trim()}
                  </ThemedText>
                ) : null}
              </Pressable>
            ))}
          </Card>
        ) : chats.data ? (
          <View style={styles.none}>
            <ThemedText themeColor="textSecondary" style={styles.center}>
              Ask anything. Answers come from a model on the home PC, so nothing leaves the house.
            </ThemedText>
            <Button title="New chat" onPress={() => router.push(`/assistant/${newChatId()}`)} />
          </View>
        ) : null}
        {chats.data?.length ? (
          <ThemedText type="small" themeColor="textSecondary" style={[styles.caption, styles.center]}>
            Touch and hold a chat to delete it.
          </ThemedText>
        ) : null}
      </ScrollView>
    </>
  );
}

function describeModel(state: 'running' | 'starting' | 'stopped') {
  if (state === 'running') return 'ready';
  if (state === 'starting') return 'starting';
  return 'starts with your first question';
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.three,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.three,
  },
  none: {
    gap: Spacing.three,
    paddingTop: Spacing.five,
  },
  center: {
    textAlign: 'center',
  },
  caption: {
    fontSize: 13,
    lineHeight: 17,
  },
  row: {
    gap: Spacing.half,
    paddingVertical: Spacing.two + Spacing.one,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.two,
  },
  title: {
    flex: 1,
  },
});
