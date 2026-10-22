import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, TextInput } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { normalizeServerUrl } from '@/miniapps/jellyfin/api';
import { Button } from '@/miniapps/jellyfin/components';
import { useJellyfinSession } from '@/miniapps/jellyfin/session';

export default function Login() {
  const theme = useTheme();
  const { signIn } = useJellyfinSession();
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    if (!server.trim()) return setError('Enter your server address.');
    if (!username.trim()) return setError('Enter your username.');
    setBusy(true);
    setError(undefined);
    try {
      // On success the layout's guard swaps this screen for the home screen.
      await signIn(normalizeServerUrl(server), username.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const inputStyle = [styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }];

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.form}
        keyboardShouldPersistTaps="handled">
        <ThemedText type="small" themeColor="textSecondary">
          Server address
        </ThemedText>
        <TextInput
          style={inputStyle}
          value={server}
          onChangeText={setServer}
          placeholder="192.168.1.10:8096"
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
        />
        <ThemedText type="small" themeColor="textSecondary">
          Username
        </ThemedText>
        <TextInput
          style={inputStyle}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="username"
        />
        <ThemedText type="small" themeColor="textSecondary">
          Password
        </ThemedText>
        <TextInput
          style={inputStyle}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="password"
          onSubmitEditing={submit}
        />
        {error ? <ThemedText style={{ color: theme.danger }}>{error}</ThemedText> : null}
        <Button title={busy ? 'Signing in…' : 'Sign in'} onPress={submit} disabled={busy} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  form: {
    padding: Spacing.four,
    gap: Spacing.two,
  },
  input: {
    borderRadius: 10,
    paddingHorizontal: Spacing.three,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: Spacing.two,
  },
});
