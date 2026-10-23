import { File } from 'expo-file-system';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActionSheetIOS, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import {
  canPickPhotos,
  deleteDropFile,
  downloadFile,
  listDrop,
  pickFiles,
  pickPhotos,
  sendText,
  uploadFile,
  type DropFile,
  type Picked,
} from '@/miniapps/drop/api';
import { type Connection } from '@/miniapps/server/api';
import { Card, formatBytes, formatWhen, Meter, PollStatus, Section, StatusColors } from '@/miniapps/server/components';
import { useServerConnection } from '@/miniapps/server/connection';
import { usePolling } from '@/miniapps/server/use-polling';

const FOLDER_POLL_MS = 10_000;

/** `picked` is kept on an upload so a failed one can be tried again. */
type Transfer = { id: string; name: string; progress: number; error?: string; picked?: Picked };

export default function DropHome() {
  const { connection } = useServerConnection();
  const theme = useTheme();
  const gutter = useGutter();

  if (!connection) {
    return (
      <View style={[styles.empty, gutter, { backgroundColor: theme.background }]}>
        <ThemedText type="smallBold">Not connected</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
          Drop goes through the home server. Connect the Server app first.
        </ThemedText>
        <Button title="Set up connection" onPress={() => router.push('/server/connect')} />
      </View>
    );
  }
  return <Drop key={`${connection.url}|${connection.token}`} conn={connection} />;
}

function Drop({ conn }: { conn: Connection }) {
  const theme = useTheme();
  const gutter = useGutter();
  const folder = usePolling(() => listDrop(conn), FOLDER_POLL_MS, conn.url);
  const [pulled, setPulled] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploads, setUploads] = useState<Transfer[]>([]);
  // The file being fetched for opening, and how far along it is.
  const [opening, setOpening] = useState<Transfer>();
  // Set straight away, so a second tap can't start another download before the first re-renders.
  const openingNow = useRef(false);

  const updateUpload = (id: string, change: Partial<Transfer>) =>
    setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...change } : u)));

  const send = async () => {
    setSending(true);
    try {
      const { action } = await sendText(conn, text);
      setText('');
      Alert.alert(action === 'opened' ? 'Opened on the PC' : 'Copied to the PC’s clipboard');
    } catch (e) {
      Alert.alert('Couldn’t send', e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  // One at a time, so a big video doesn't hold up the photos picked with it for long.
  const upload = async (picked: Picked[]) => {
    const batch = picked.map((p, i) => ({ ...p, id: `${Date.now()}-${i}` }));
    setUploads((list) => [...list, ...batch.map(({ id, name, file }) => ({ id, name, progress: 0, picked: { file, name } }))]);
    for (const { id, file, name } of batch) {
      try {
        await uploadFile(conn, file, name, (progress) => updateUpload(id, { progress }));
        setUploads((list) => list.filter((u) => u.id !== id));
      } catch (e) {
        updateUpload(id, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    folder.refresh();
  };

  const choose = async (pick: () => Promise<Picked[]>) => {
    try {
      const picked = await pick();
      if (picked.length) await upload(picked);
    } catch (e) {
      Alert.alert('Couldn’t pick', e instanceof Error ? e.message : String(e));
    }
  };

  const choosePhotos = () => {
    if (!canPickPhotos()) {
      Alert.alert('Needs the new build', 'Picking photos needs a newer Homebase build. Files works until then.');
      return;
    }
    choose(pickPhotos);
  };

  const failedUpload = (u: Transfer) =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: u.name,
        message: u.error,
        options: [...(u.picked ? ['Try again'] : []), 'Dismiss', 'Cancel'],
        cancelButtonIndex: u.picked ? 2 : 1,
      },
      (i) => {
        const choice = (u.picked ? ['retry', 'dismiss'] : ['dismiss'])[i];
        if (!choice) return;
        setUploads((list) => list.filter((x) => x.id !== u.id));
        if (choice === 'retry' && u.picked) upload([u.picked]);
      },
    );

  const open = async (file: DropFile) => {
    if (openingNow.current) return;
    openingNow.current = true;
    setOpening({ id: file.name, name: file.name, progress: 0 });
    try {
      const local = await downloadFile(conn, file.name, (progress) =>
        setOpening((o) => (o ? { ...o, progress } : o)),
      );
      if (!(await File.canPreview(local))) {
        Alert.alert('Can’t open this kind of file', `${file.name} downloaded, but iPhone has no viewer for it.`);
        return;
      }
      // The viewer's share button saves it to Photos or Files.
      await File.preview(local, { title: file.name });
    } catch (e) {
      Alert.alert('Couldn’t open', e instanceof Error ? e.message : String(e));
    } finally {
      openingNow.current = false;
      setOpening(undefined);
    }
  };

  const showActions = (file: DropFile) => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: file.name,
        message: formatBytes(file.size),
        options: ['Open', 'Delete from PC', 'Cancel'],
        destructiveButtonIndex: 1,
        cancelButtonIndex: 2,
      },
      (index) => {
        if (index === 0) open(file);
        if (index === 1) {
          deleteDropFile(conn, file.name).then(folder.refresh, (e: Error) =>
            Alert.alert('Couldn’t delete', e.message),
          );
        }
      },
    );
  };

  const files = folder.data?.files;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[styles.content, gutter]}
      refreshControl={
        <RefreshControl
          refreshing={pulled}
          onRefresh={async () => {
            setPulled(true);
            await folder.refresh();
            setPulled(false);
          }}
        />
      }>
      <Section title="Send to PC">
        <TextInput
          style={[styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }]}
          value={text}
          onChangeText={setText}
          placeholder="Text or a link"
          placeholderTextColor={theme.textSecondary}
          multiline
        />
        <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
          A link opens in the PC’s browser. Anything else goes on its clipboard.
        </ThemedText>
        <Button title={sending ? 'Sending…' : 'Send'} onPress={send} disabled={sending || !text.trim()} />
        <View style={styles.buttons}>
          <View style={styles.flex}>
            <Button title="Photos" variant="secondary" onPress={choosePhotos} />
          </View>
          <View style={styles.flex}>
            <Button title="Files" variant="secondary" onPress={() => choose(pickFiles)} />
          </View>
        </View>
        {uploads.length ? (
          <Card>
            {uploads.map((u, i) => (
              <TransferRow
                key={u.id}
                transfer={u}
                first={i === 0}
                onPress={u.error ? () => failedUpload(u) : undefined}
              />
            ))}
          </Card>
        ) : null}
      </Section>

      <Section title="On the PC">
        <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
          {folder.data?.folder ?? '~/Downloads/Homebase'}. Put files there to get them on the phone.
        </ThemedText>
        {opening ? (
          <Card>
            <TransferRow transfer={opening} first />
          </Card>
        ) : null}
        <PollStatus error={folder.error} loaded={!!files} onRetry={folder.refresh} />
        {!files ? null : files.length ? (
          <Card>
            {files.map((f, i) => (
              <FileRow key={f.name} file={f} first={i === 0} onPress={() => showActions(f)} />
            ))}
          </Card>
        ) : (
          <ThemedText themeColor="textSecondary">Nothing there yet.</ThemedText>
        )}
      </Section>
    </ScrollView>
  );
}

function FileRow({ file, first, onPress }: { file: DropFile; first: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      <ThemedText type="smallBold" numberOfLines={1} style={styles.flex}>
        {file.name}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
        {formatBytes(file.size)} · {formatWhen(file.modified)}
      </ThemedText>
    </Pressable>
  );
}

/** An upload or a download in progress; a failed upload shows why and goes away when tapped. */
function TransferRow({ transfer, first, onPress }: { transfer: Transfer; first: boolean; onPress?: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={[
        styles.transfer,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
      ]}>
      <ThemedText type="smallBold" numberOfLines={1}>
        {transfer.name}
      </ThemedText>
      {transfer.error ? (
        <ThemedText type="small" style={[styles.caption, { color: theme.danger }]}>
          {transfer.error} Tap for options.
        </ThemedText>
      ) : (
        <Meter fraction={transfer.progress} color={StatusColors.good} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: Spacing.three,
    gap: Spacing.four,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.three,
  },
  center: {
    textAlign: 'center',
  },
  input: {
    borderRadius: 10,
    paddingHorizontal: Spacing.three,
    paddingTop: 14,
    paddingBottom: 14,
    fontSize: 17,
    minHeight: 88,
    textAlignVertical: 'top',
  },
  caption: {
    fontSize: 13,
    lineHeight: 17,
  },
  buttons: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  flex: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two + Spacing.one,
  },
  transfer: {
    gap: Spacing.one,
    paddingVertical: Spacing.two + Spacing.one,
  },
});
