import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
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

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import {
  ask,
  assistantState,
  canAddPhotos,
  deleteChat,
  getChat,
  photoSource,
  PHOTOS_PER_QUESTION,
  pickPhotos,
  stopAnswer,
  uploadPhoto,
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

/** A photo waiting to go with the next question; `id` arrives once it's on the server. */
type Attachment = { key: string; uri: string; id?: string };

export default function ChatScreen() {
  const { connection } = useServerConnection();
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!connection) return <NotConnected />;
  return <ChatView key={`${connection.url}|${id}`} conn={connection} id={id} />;
}

/** Reached from a link with no server set up; same as the Assistant home in that case. */
function NotConnected() {
  const theme = useTheme();
  const gutter = useGutter();
  return (
    <View style={[styles.notConnected, gutter, { backgroundColor: theme.background }]}>
      <ThemedText type="smallBold">Not connected</ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
        The assistant runs on the home server. Connect the Server app first.
      </ThemedText>
      <Button title="Set up connection" onPress={() => router.push('/server/connect')} />
    </View>
  );
}

function ChatView({ conn, id }: { conn: Connection; id: string }) {
  const theme = useTheme();
  const gutter = useGutter();
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardOpen();
  const [chat, setChat] = useState<Chat>();
  const [loaded, setLoaded] = useState(false);
  const [models, setModels] = useState<AssistantModel[]>([]);
  const [modelsError, setModelsError] = useState<Error>();
  const [modelId, setModelId] = useState<string>();
  const [think, setThink] = useState(false);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<string>();
  const [streaming, setStreaming] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [viewing, setViewing] = useState<string>();
  const [openError, setOpenError] = useState<Error>();
  const scroll = useRef<ScrollViewInstance>(null);
  const following = useRef(true);
  // Stops reading the answer when leaving the chat; the server finishes it either way.
  const leaving = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    leaving.current = controller;
    return () => controller.abort();
  }, []);

  const model = models.find((m) => m.id === (modelId ?? chat?.model)) ?? models[0];
  const answering = streaming || !!chat?.messages.at(-1)?.pending;
  const uploading = attachments.some((a) => !a.id);
  const canSend = (!!text.trim() || attachments.length > 0) && !uploading;

  const load = useCallback(async () => {
    const next = await getChat(conn, id);
    setChat(next);
    setLoaded(true);
    return next;
  }, [conn, id]);

  // Without the list the photo, thinking and model buttons have nothing to go on, so say so.
  const loadModels = () =>
    assistantState(conn).then(
      (s) => {
        setModels(s.models);
        setModelsError(undefined);
      },
      (e: Error) => setModelsError(e),
    );

  const open = useCallback(() => {
    getChat(conn, id).then(
      (c) => {
        setChat(c);
        setLoaded(true);
      },
      // Showing an empty chat here would look like a new one, and a question would land at the end
      // of history the screen isn't showing.
      (e: Error) => setOpenError(e),
    );
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, id]);
  useEffect(open, [open]);

  // An answer the server is still writing (it went on while the app was closed): follow it.
  const catchingUp = !streaming && !!chat?.messages.at(-1)?.pending;
  useEffect(() => {
    if (!catchingUp) return;
    // Each look waits for the last, so a slow answer can't land after a newer one.
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await load().catch(() => undefined);
      if (!stopped) timer = setTimeout(tick, CATCH_UP_MS);
    };
    timer = setTimeout(tick, CATCH_UP_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [catchingUp, load]);

  const updateLast = (change: (m: ChatMessage) => ChatMessage) =>
    setChat((c) => c && { ...c, messages: [...c.messages.slice(0, -1), change(c.messages.at(-1)!)] });

  const send = async () => {
    const question = text.trim();
    const images = attachments.flatMap((a) => (a.id ? [a.id] : []));
    if (!canSend || answering) return;
    const now = Date.now();
    const unsent = attachments;
    const before = chat;
    setText('');
    setAttachments([]);
    following.current = true;
    setChat((c) => ({
      id,
      title: c?.title ?? (question.split('\n')[0] || 'Photo'),
      model: model?.id,
      createdAt: c?.createdAt ?? now,
      updatedAt: now,
      messages: [
        ...(c?.messages ?? []),
        { role: 'user', content: question, images, at: now },
        { role: 'assistant', content: '', reasoning: '', at: now, pending: true },
      ],
    }));
    setStreaming(true);
    try {
      await ask(conn, id, { text: question, images, model: model?.id, think: think && !!model?.thinking }, (event) => {
        if (event.type === 'status') setStatus(event.text);
        else if (event.type === 'reasoning') updateLast((m) => ({ ...m, reasoning: (m.reasoning ?? '') + event.text }));
        else if (event.type === 'content') {
          setStatus(undefined);
          updateLast((m) => ({ ...m, content: m.content + event.text }));
        } else if (event.type === 'done') updateLast(() => event.message);
        else if (event.type === 'error') updateLast((m) => ({ ...m, pending: undefined, error: event.error }));
      }, leaving.current.signal);
    } catch (e) {
      if (leaving.current.signal.aborted) return;
      // Refused before it started (the message wasn't added), or the connection dropped while the
      // server kept writing: either way the server's copy is the truth.
      const saved = await load().catch(() => undefined);
      if (!saved?.messages.some((m) => m.at === now && m.role === 'user')) {
        // Take the question back out of the list, or its empty answer would wait there forever.
        if (!saved) setChat(before);
        setText(question);
        setAttachments(unsent);
        Alert.alert('Couldn’t ask', e instanceof Error ? e.message : String(e));
      }
    } finally {
      setStatus(undefined);
      setStreaming(false);
    }
  };

  const stop = () =>
    stopAnswer(conn, id).catch((e: Error) => Alert.alert('Couldn’t stop the answer', e.message));

  const addPhotos = (from: 'library' | 'camera') =>
    pickPhotos(from, PHOTOS_PER_QUESTION - attachments.length).then(
      (uris) => {
        const added = uris.map((uri, i) => ({ key: `${Date.now()}-${i}`, uri }));
        setAttachments((list) => [...list, ...added]);
        for (const a of added) {
          uploadPhoto(conn, a.uri).then(
            (photoId) => setAttachments((list) => list.map((x) => (x.key === a.key ? { ...x, id: photoId } : x))),
            (e: Error) => {
              setAttachments((list) => list.filter((x) => x.key !== a.key));
              if (!leaving.current.signal.aborted) Alert.alert('Couldn’t add the photo', e.message);
            },
          );
        }
      },
      (e: Error) => Alert.alert('Couldn’t add a photo', e.message),
    );

  const choosePhotoSource = () => {
    if (attachments.length >= PHOTOS_PER_QUESTION) {
      Alert.alert(`Up to ${PHOTOS_PER_QUESTION} photos at a time`);
      return;
    }
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ['Take Photo', 'Choose Photos', 'Cancel'], cancelButtonIndex: 2 },
      (i) => {
        if (i === 0) addPhotos('camera');
        if (i === 1) addPhotos('library');
      },
    );
  };

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

  const messageActions = useCallback((message: ChatMessage) => {
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
  }, [conn]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    following.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - FOLLOW_SLACK;
  };

  if (!loaded) {
    const retry = () => {
      setOpenError(undefined);
      open();
    };
    return <Centered loading={!openError} error={openError} onRetry={retry} />;
  }

  const messages = chat?.messages ?? [];
  return (
    // The header is see-through and the screen runs under it, so the keyboard needs no offset.
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: theme.background }}>
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
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.messages, gutter]}
        keyboardDismissMode="interactive"
        onScroll={onScroll}
        scrollEventThrottle={100}
        onContentSizeChange={() => following.current && scroll.current?.scrollToEnd({ animated: false })}>
        {messages.length ? (
          messages.map((m, i) => (
            <MessageView
              key={`${m.at}-${i}`}
              conn={conn}
              message={m}
              status={i === messages.length - 1 ? status : undefined}
              onActions={messageActions}
              onOpenPhoto={setViewing}
            />
          ))
        ) : (
          <ThemedText themeColor="textSecondary" style={styles.hint}>
            {model ? `${model.name} on the home PC.` : ''}
            {model?.state === 'stopped' ? ' It takes a few seconds to start on the first question.' : ''}
            {modelsError && !models.length ? (
              <>
                {`Couldn’t load the models. ${modelsError.message} `}
                <ThemedText style={{ color: theme.accent }} onPress={loadModels}>
                  Try again
                </ThemedText>
              </>
            ) : null}
          </ThemedText>
        )}
      </ScrollView>
      {attachments.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.attachments, gutter]} style={styles.attachmentBar}>
          {attachments.map((a) => (
            <View key={a.key} style={[styles.attachment, { backgroundColor: theme.backgroundElement }]}>
              <Image source={a.uri} style={StyleSheet.absoluteFill} contentFit="cover" />
              {a.id ? null : (
                <View style={styles.attachmentBusy}>
                  <ActivityIndicator color="#fff" />
                </View>
              )}
              <Pressable
                onPress={() => setAttachments((list) => list.filter((x) => x.key !== a.key))}
                accessibilityLabel="Remove photo"
                hitSlop={8}
                style={styles.attachmentRemove}>
                <SymbolView name="xmark.circle.fill" size={20} tintColor="#fff" />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}
      <View style={[styles.composer, gutter, { paddingBottom: keyboardOpen ? Spacing.two : Math.max(insets.bottom, Spacing.two) }]}>
        {model?.vision && canAddPhotos() ? (
          <Pressable
            onPress={choosePhotoSource}
            accessibilityLabel="Add photo"
            style={[styles.think, { backgroundColor: theme.backgroundElement }]}>
            <SymbolView name="photo" size={18} tintColor={theme.textSecondary} />
          </Pressable>
        ) : null}
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
          placeholder={attachments.length ? 'Ask about the photo' : think ? 'Ask, and it thinks it through' : 'Ask anything'}
          placeholderTextColor={theme.textSecondary}
          multiline
        />
        <Pressable
          onPress={answering ? stop : send}
          disabled={!answering && !canSend}
          accessibilityLabel={answering ? 'Stop' : 'Send'}
          style={({ pressed }) => [
            styles.send,
            { backgroundColor: theme.accent, opacity: !answering && !canSend ? 0.4 : pressed ? 0.7 : 1 },
          ]}>
          <SymbolView name={answering ? 'stop.fill' : 'arrow.up'} size={18} weight="bold" tintColor="#fff" />
        </Pressable>
      </View>
      <Modal visible={!!viewing} animationType="fade" onRequestClose={() => setViewing(undefined)}>
        <Pressable style={styles.viewer} onPress={() => setViewing(undefined)} accessibilityLabel="Close photo">
          {viewing ? <Image source={photoSource(conn, viewing)} style={styles.flex} contentFit="contain" /> : null}
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

/** Whether the keyboard is up; the composer then sits on it instead of above the home indicator. */
function useKeyboardOpen() {
  const [open, setOpen] = useState(Keyboard.isVisible());
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setOpen(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return open;
}

// Memoized so a streamed word only redraws the answer it belongs to, not the whole chat.
const MessageView = memo(function MessageView({
  conn,
  message,
  status,
  onActions,
  onOpenPhoto,
}: {
  conn: Connection;
  message: ChatMessage;
  status?: string;
  /** Share or send a message to the PC. */
  onActions: (message: ChatMessage) => void;
  onOpenPhoto: (id: string) => void;
}) {
  const theme = useTheme();
  const [showThinking, setShowThinking] = useState(false);

  if (message.role === 'user') {
    return (
      <View style={styles.question}>
        {message.images?.length ? (
          <View style={styles.photos}>
            {message.images.map((photo) => (
              <Pressable key={photo} onPress={() => onOpenPhoto(photo)} accessibilityLabel="Show photo">
                <Image
                  source={photoSource(conn, photo)}
                  style={[styles.photo, { backgroundColor: theme.backgroundElement }]}
                  contentFit="cover"
                />
              </Pressable>
            ))}
          </View>
        ) : null}
        {message.content ? (
          <Pressable onLongPress={() => onActions(message)} style={[styles.user, { backgroundColor: theme.backgroundSelected }]}>
            <ThemedText style={styles.userText}>{message.content}</ThemedText>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const thinkingNow = message.pending && !!message.reasoning && !message.content;
  const notes = [
    message.stopped ? 'Stopped' : undefined,
    message.cutOff ? 'Stopped at the length limit' : undefined,
  ].filter(Boolean);
  return (
    // Not a long-press like questions: the answer's text is selectable, and a long press there
    // starts a selection.
    <View style={styles.answer}>
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
      {notes.length || (message.content && !message.pending) ? (
        <View style={styles.answerFooter}>
          <ThemedText type="small" themeColor="textSecondary" style={[styles.caption, styles.flex]}>
            {notes.join(' · ')}
          </ThemedText>
          {message.content && !message.pending ? (
            <Pressable onPress={() => onActions(message)} hitSlop={12} accessibilityLabel="Share answer">
              <SymbolView name="square.and.arrow.up" size={17} tintColor={theme.textSecondary} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  center: {
    textAlign: 'center',
  },
  notConnected: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  messages: {
    paddingVertical: Spacing.three,
    gap: Spacing.four,
  },
  hint: {
    textAlign: 'center',
    paddingTop: Spacing.five,
  },
  question: {
    alignItems: 'flex-end',
    gap: Spacing.two,
  },
  photos: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: Spacing.two,
    maxWidth: '85%',
  },
  photo: {
    width: 120,
    height: 120,
    borderRadius: 14,
  },
  attachmentBar: {
    flexGrow: 0,
  },
  attachments: {
    gap: Spacing.two,
    paddingTop: Spacing.two,
  },
  attachment: {
    width: 64,
    height: 64,
    borderRadius: 10,
    overflow: 'hidden',
  },
  attachmentBusy: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachmentRemove: {
    position: 'absolute',
    top: 2,
    right: 2,
  },
  viewer: {
    flex: 1,
    backgroundColor: '#000',
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
  answerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
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
