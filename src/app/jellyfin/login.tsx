import * as SecureStore from 'expo-secure-store';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, TextInput } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGutter } from '@/hooks/use-gutter';
import { useTheme } from '@/hooks/use-theme';
import { normalizeServerUrl } from '@/miniapps/jellyfin/api';
import { LAST_LOGIN_KEY, useJellyfinSession } from '@/miniapps/jellyfin/session';
import { errorText } from '@/utils/error-text';
import { homeServerHttps } from '@/utils/home-server-https';

export default function Login() {
  const theme = useTheme();
  const gutter = useGutter();
  const { signIn } = useJellyfinSession();
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const usernameInput = useRef<ComponentRef<typeof TextInput>>(null);
  const passwordInput = useRef<ComponentRef<typeof TextInput>>(null);

  // After a sign-out or an expired session, only the password is left to type.
  useEffect(() => {
    SecureStore.getItemAsync(LAST_LOGIN_KEY)
      .then((raw) => {
        if (!raw) return;
        const last: { server?: string; username?: string } = JSON.parse(raw);
        setServer((s) => s || homeServerHttps(last.server ?? ''));
        setUsername((u) => u || (last.username ?? ''));
      })
      .catch(() => undefined);
  }, []);

  const submit = async () => {
    if (busy) return;
    if (!server.trim()) return setError('Enter your server address.');
    if (!username.trim()) return setError('Enter your username.');
    setBusy(true);
    setError(undefined);
    try {
      // On success the layout's guard swaps this screen for the home screen.
      await signIn(normalizeServerUrl(server), username.trim(), password);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const inputStyle = [styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }];

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.form, gutter]}
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
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => usernameInput.current?.focus()}
        />
        <ThemedText type="small" themeColor="textSecondary">
          Username
        </ThemedText>
        <TextInput
          ref={usernameInput}
          style={inputStyle}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="username"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => passwordInput.current?.focus()}
        />
        <ThemedText type="small" themeColor="textSecondary">
          Password
        </ThemedText>
        <TextInput
          ref={passwordInput}
          style={inputStyle}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="password"
          returnKeyType="go"
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
    paddingVertical: Spacing.four,
    gap: Spacing.two,
  },
  input: {
    borderRadius: 10,
    paddingHorizontal: Spacing.three,
    paddingVertical: 14,
    fontSize: 17,
    marginBottom: Spacing.two,
  },
});
