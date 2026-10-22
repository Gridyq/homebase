import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, TextInput } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { DEFAULT_URL, fetchStatus, normalizeUrl, redeemPairingCode } from '@/miniapps/server/api';
import { useServerConnection } from '@/miniapps/server/connection';

/**
 * Also opened by the pairing link `homebase://server/connect?url=…&code=…`. The code is traded
 * for the token on Save, so the token itself never travels through ntfy.
 */
export default function Connect() {
  const theme = useTheme();
  const gutter = useGutter();
  const params = useLocalSearchParams<{ url?: string; code?: string }>();
  const { connection, save, forget } = useServerConnection();
  const [url, setUrl] = useState(params.url ?? connection?.url ?? DEFAULT_URL);
  const [token, setToken] = useState(params.code ? '' : (connection?.token ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    if (!url.trim()) return setError('Enter the server address.');
    if (!token.trim() && !params.code) return setError('Enter the token.');
    setBusy(true);
    setError(undefined);
    try {
      const next = { url: normalizeUrl(url), token: token.trim() };
      if (!next.token && params.code) next.token = await redeemPairingCode(next.url, params.code);
      // Check it works before replacing a connection that might be fine.
      await fetchStatus(next);
      await save(next);
      router.dismissTo('/server');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        {params.code ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
            From the pairing link. Check the address is your server, then tap Save to connect.
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
          placeholder={params.code ? 'Comes from the pairing link' : 'From status-server/token'}
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
