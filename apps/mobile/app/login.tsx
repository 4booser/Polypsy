import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/auth/AuthContext";
import { Body, Button, ErrorText, Field, Title } from "@/components/ui";
import { spacing, useColors } from "@/theme";

export default function LoginScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      router.replace("/(app)/surveys");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: c.bg }}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          padding: spacing.xl,
          paddingTop: insets.top + spacing.xl,
          gap: spacing.lg,
        }}
      >
        <View style={{ gap: spacing.xs }}>
          <Title>Quizzy</Title>
          <Body muted>Вход для пациентов и специалистов</Body>
        </View>

        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
        />
        <Field label="Пароль" value={password} onChangeText={setPassword} secureTextEntry />

        <ErrorText>{error}</ErrorText>

        <Button title="Войти" onPress={onSubmit} loading={busy} />

        <Button title="Создать аккаунт" onPress={() => router.push("/register")} variant="secondary" />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
