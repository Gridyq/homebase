import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import {
  ask,
  assistantState,
  deleteChat,
  getChat,
  stopAnswer,
  type AssistantModel,
  type Chat,
  type ChatMessage,
} from '@/miniapps/assistant/api';
import { Markdown } from '@/miniapps/assistant/markdown';
import { sendText } from '@/miniapps/drop/api';
import { Centered } from '@/miniapps/jellyfin/components';
import { type Connection } from '@/miniapps/server/api';
import { useServerConnection } from '@/miniapps/server/connection';

/** How often to look again while the server writes an answer this screen isn't streaming. */
const CATCH_UP_MS = 1000;
/** Within this distance of the bottom, new text keeps the view scrolled to the end. */
const FOLLOW_SLACK = 80;

export default function ChatScreen() {
  const { connection } = useServerConnection();
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!connection) return <Centered error={new Error('The assistant runs on the home server. Connect the Server app first.')} />;
  return <ChatView key={`${connection.url}|${id}`} conn={connection} id={id} />;
}

function ChatView({ conn, id }: { conn: Connection; id: string }) {
  const theme = useTheme();
  const gutter = useGutter();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const [chat, setChat] = useState<Chat>();
  const [loaded, setLoaded] = useState(false);
  const [models, setModels] = useState<AssistantModel[]>([]);
  const [modelId, setModelId] = useState<string>();
  const [think, setThink] = useState(false);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<string>();
  const [streaming, setStreaming] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const following = useRef(true);

  const model = models.find((m) => m.id === (modelId ?? chat?.model)) ?? models[0];
  const answering = streaming || !!chat?.messages.at(-1)?.pending;

  const load = useCallback(async () => {
    const next = await getChat(conn, id);
    setChat(next);
    setLoaded(true);
    return next;
  }, [conn, id]);

  useEffect(() => {
    getChat(conn, id).then(
      (c) => {
        setChat(c);
        setLoaded(true);
      },
      (e: Error) => {
        setLoaded(true);
        Alert.alert('Couldn’t open the chat', e.message);
      },
    );
    assistantState(conn)
      .then((s) => setModels(s.models))
      .catch(() => undefined);
  }, [conn, id]);

  // An answer the server is still writing (it went on while the app was closed): follow it.
  const catchingUp = !streaming && !!chat?.messages.at(-1)?.pending;
  useEffect(() => {
    if (!catchingUp) return;
    const timer = setInterval(() => load().catch(() => undefined), CATCH_UP_MS);
    return () => clearInterval(timer);
  }, [catchingUp, load]);

  const updateLast = (change: (m: ChatMessage) => ChatMessage) =>
    setChat((c) => c && { ...c, messages: [...c.messages.slice(0, -1), change(c.messages.at(-1)!)] });

  const send = async () => {
    const question = text.trim();
    if (!question || answering) return;
    const now = Date.now();
    setText('');
    following.current = true;
    setChat((c) => ({
      id,
      title: c?.title ?? question.split('\n')[0],
      model: model?.id,
      createdAt: c?.createdAt ?? now,
      updatedAt: now,
      messages: [
        ...(c?.messages ?? []),
        { role: 'user', content: question, at: now },
        { role: 'assistant', content: '', reasoning: '', at: now, pending: true },
      ],
    }));
    setStreaming(true);
    try {
      await ask(conn, id, { text: question, model: model?.id, think: think && !!model?.thinking }, (event) => {
        if (event.type === 'status') setStatus(event.text);
        else if (event.type === 'reasoning') updateLast((m) => ({ ...m, reasoning: (m.reasoning ?? '') + event.text }));
        else if (event.type === 'content') {
          setStatus(undefined);
          updateLast((m) => ({ ...m, content: m.content + event.text }));
        } else if (event.type === 'done') updateLast(() => event.message);
        else if (event.type === 'error') updateLast((m) => ({ ...m, pending: undefined, error: event.error }));
      });
    } catch (e) {
      // Refused before it started (the message wasn't added), or the connection dropped while the
      // server kept writing: either way the server's copy is the truth.
      const saved = await load().catch(() => undefined);
      if (!saved?.messages.some((m) => m.at === now && m.role === 'user')) {
        setText(question);
        Alert.alert('Couldn’t ask', e instanceof Error ? e.message : String(e));
      }
    } finally {
      setStatus(undefined);
      setStreaming(false);
    }
  };

  const stop = () => stopAnswer(conn, id).catch(() => undefined);

  const chooseModel = () => {
    const names = models.map((m) => m.name);
    ActionSheetIOS.showActionSheetWithOptions(
      { title: 'Model', options: [...names, 'Cancel'], cancelButtonIndex: names.length },
      (i) => i < models.length && setModelId(models[i].id),
    );
  };

  const remove = () =>
    Alert.alert('Delete this chat?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          deleteChat(conn, id).then(
            () => router.back(),
            (e: Error) => Alert.alert('Couldn’t delete the chat', e.message),
          ),
      },
    ]);

  const messageActions = (message: ChatMessage) => {
    if (!message.content) return;
    const options = ['Share…', 'Send to PC clipboard', 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: 2 }, (i) => {
      if (i === 0) Share.share({ message: message.content });
      if (i === 1) {
        sendText(conn, message.content).then(
          () => Alert.alert('Sent', 'It’s on the PC’s clipboard.'),
          (e: Error) => Alert.alert('Couldn’t send it', e.message),
        );
      }
    });
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    following.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - FOLLOW_SLACK;
  };

  if (!loaded) return <Centered loading />;

  const messages = chat?.messages ?? [];
  return (
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
      style={{ flex: 1, backgroundColor: theme.background }}>
      <Stack.Screen options={{ title: chat?.title ?? 'New chat' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis">
          {models.length > 1 ? (
            <Stack.Toolbar.MenuAction icon="cpu" onPress={chooseModel}>
              {`Model: ${model?.name ?? ''}`}
            </Stack.Toolbar.MenuAction>
          ) : null}
          {chat ? (
            <Stack.Toolbar.MenuAction icon="trash" destructive onPress={remove}>
              Delete chat
            </Stack.Toolbar.MenuAction>
          ) : null}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <ScrollView
        ref={scroll}
        style={styles.flex}
        contentContainerStyle={[styles.messages, gutter]}
        keyboardDismissMode="interactive"
        onScroll={onScroll}
        scrollEventThrottle={100}
        onContentSizeChange={() => following.current && scroll.current?.scrollToEnd({ animated: false })}>
        {messages.length ? (
          messages.map((m, i) => (
            <MessageView key={`${m.at}-${i}`} message={m} status={i === messages.length - 1 ? status : undefined} onLongPress={() => messageActions(m)} />
          ))
        ) : (
          <ThemedText themeColor="textSecondary" style={styles.hint}>
            {model ? `${model.name} on the home PC.` : ''}
            {model?.state === 'stopped' ? ' It takes a few seconds to start on the first question.' : ''}
          </ThemedText>
        )}
      </ScrollView>
      <View style={[styles.composer, gutter, { paddingBottom: Math.max(insets.bottom, Spacing.two) }]}>
        {model?.thinking ? (
          <Pressable
            onPress={() => setThink((t) => !t)}
            accessibilityRole="switch"
            accessibilityState={{ checked: think }}
            accessibilityLabel="Think before answering"
            style={[styles.think, { backgroundColor: think ? theme.accent : theme.backgroundElement }]}>
            <SymbolView name="lightbulb" size={18} tintColor={think ? '#fff' : theme.textSecondary} />
          </Pressable>
        ) : null}
        <TextInput
          style={[styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }]}
          value={text}
          onChangeText={setText}
          placeholder={think ? 'Ask, and it thinks it through' : 'Ask anything'}
          placeholderTextColor={theme.textSecondary}
          multiline
        />
        <Pressable
          onPress={answering ? stop : send}
          disabled={!answering && !text.trim()}
          accessibilityLabel={answering ? 'Stop' : 'Send'}
          style={({ pressed }) => [
            styles.send,
            { backgroundColor: theme.accent, opacity: !answering && !text.trim() ? 0.4 : pressed ? 0.7 : 1 },
          ]}>
          <SymbolView name={answering ? 'stop.fill' : 'arrow.up'} size={18} weight="bold" tintColor="#fff" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageView({ message, status, onLongPress }: { message: ChatMessage; status?: string; onLongPress: () => void }) {
  const theme = useTheme();
  const [showThinking, setShowThinking] = useState(false);

  if (message.role === 'user') {
    return (
      <Pressable onLongPress={onLongPress} style={[styles.user, { backgroundColor: theme.backgroundSelected }]}>
        <ThemedText style={styles.userText}>{message.content}</ThemedText>
      </Pressable>
    );
  }

  const thinkingNow = message.pending && !!message.reasoning && !message.content;
  const notes = [
    message.stopped ? 'Stopped' : undefined,
    message.cutOff ? 'Stopped at the length limit' : undefined,
  ].filter(Boolean);
  return (
    <Pressable onLongPress={onLongPress} style={styles.answer}>
      {message.reasoning ? (
        <Pressable onPress={() => setShowThinking((s) => !s)} style={styles.thinkingRow}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
            {thinkingNow ? 'Thinking…' : 'Thought it through'} {showThinking ? '▾' : '▸'}
          </ThemedText>
        </Pressable>
      ) : null}
      {showThinking && message.reasoning ? (
        <View style={[styles.reasoning, { borderLeftColor: theme.backgroundSelected }]}>
          <ThemedText selectable type="small" themeColor="textSecondary" style={styles.caption}>
            {message.reasoning.trim()}
          </ThemedText>
        </View>
      ) : null}
      {message.content ? <Markdown text={message.content} /> : null}
      {message.pending && !message.content && !thinkingNow ? (
        <ThemedText themeColor="textSecondary">{status ?? '…'}</ThemedText>
      ) : null}
      {message.error ? <ThemedText style={{ color: theme.danger }}>{message.error}</ThemedText> : null}
      {notes.length ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
          {notes.join(' · ')}
        </ThemedText>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  messages: {
    paddingVertical: Spacing.three,
    gap: Spacing.four,
  },
  hint: {
    textAlign: 'center',
    paddingTop: Spacing.five,
  },
  user: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    borderRadius: 18,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.one,
  },
  userText: {
    fontWeight: 400,
  },
  answer: {
    gap: Spacing.two,
  },
  thinkingRow: {
    alignSelf: 'flex-start',
  },
  reasoning: {
    borderLeftWidth: 3,
    paddingLeft: Spacing.three,
  },
  caption: {
    fontSize: 13,
    lineHeight: 17,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
    paddingTop: Spacing.two,
  },
  think: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    borderRadius: 20,
    paddingHorizontal: Spacing.three,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 17,
  },
  send: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
