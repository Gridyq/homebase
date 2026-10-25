import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, TextInput } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { DEFAULT_URL, fetchStatus, isTailnetUrl, normalizeUrl, redeemPairingCode } from '@/miniapps/server/api';
import { useServerConnection } from '@/miniapps/server/connection';
import { errorText } from '@/utils/error-text';

/**
 * Also opened by the pairing link `homebase://server/connect?url=…&code=…`. The code is traded
 * for the token on Save, so the token itself never travels through ntfy.
 */
export default function Connect() {
  const theme = useTheme();
  const gutter = useGutter();
  const params = useLocalSearchParams<{ url?: string; code?: string }>();
  const { connection, save, forget } = useServerConnection();
  // Anyone can make a link, so one naming a server off the tailnet is ignored, code and all:
  // pairing with it would send Drop files and Assistant chats to whoever runs it.
  const linkUrl = params.url != null && isTailnetUrl(params.url) ? params.url : undefined;
  const ignoredLink = params.url != null && linkUrl == null;
  const code = linkUrl != null ? params.code : undefined;
  // The saved token is only filled in for the saved server; otherwise Save would send it to
  // whatever address the link named.
  const otherServer = linkUrl != null && normalizeUrl(linkUrl) !== connection?.url;
  const [url, setUrl] = useState(linkUrl ?? connection?.url ?? DEFAULT_URL);
  const [token, setToken] = useState(code || otherServer ? '' : (connection?.token ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    if (busy) return;
    if (!url.trim()) return setError('Enter the server address.');
    if (!token.trim() && !code) return setError('Enter the token.');
    setBusy(true);
    setError(undefined);
    try {
      const next = { url: normalizeUrl(url), token: token.trim() };
      if (!next.token && code) {
        next.token = await redeemPairingCode(next.url, code);
        // The code only works once; keep the token in case the check below fails and they retry.
        setToken(next.token);
      }
      // Check it works before replacing a connection that might be fine.
      await fetchStatus(next);
      await save(next);
      router.dismissTo('/server');
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const confirmForget = () =>
    Alert.alert('Forget this server?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget',
        style: 'destructive',
        onPress: async () => {
          await forget();
          router.dismissTo('/server');
        },
      },
    ]);

  const inputStyle = [styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }];

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.form, gutter]}
        keyboardShouldPersistTaps="handled">
        {ignoredLink ? (
          <ThemedText type="small" style={[styles.note, { color: theme.danger }]}>
            Ignored a link to a server that isn’t on your tailnet. If you didn’t make it, someone
            may be trying to get you to connect to theirs.
          </ThemedText>
        ) : linkUrl != null ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
            {code
              ? 'From the pairing link. Check the address is your server, then tap Save to connect.'
              : 'From a link. Check the address is your server before entering its token.'}
          </ThemedText>
        ) : null}
        <ThemedText type="small" themeColor="textSecondary">
          Status server address
        </ThemedText>
        <TextInput
          style={inputStyle}
          value={url}
          onChangeText={setUrl}
          placeholder={DEFAULT_URL}
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
        />
        <ThemedText type="small" themeColor="textSecondary">
          Token
        </ThemedText>
        <TextInput
          style={inputStyle}
          value={token}
          onChangeText={setToken}
          placeholder={code ? 'Comes from the pairing link' : 'From status-server/token'}
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          onSubmitEditing={submit}
        />
        {error ? <ThemedText style={{ color: theme.danger }}>{error}</ThemedText> : null}
        <Button title={busy ? 'Connecting…' : 'Save'} onPress={submit} disabled={busy} />
        {connection ? <Button title="Forget server" variant="secondary" onPress={confirmForget} /> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  form: {
    paddingVertical: Spacing.four,
    gap: Spacing.two,
  },
  note: {
    marginBottom: Spacing.two,
  },
  input: {
    borderRadius: 10,
    paddingHorizontal: Spacing.three,
    paddingVertical: 14,
    fontSize: 17,
    marginBottom: Spacing.two,
  },
});
