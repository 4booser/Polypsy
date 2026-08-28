import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/auth/AuthContext";
import { Body, Button, ErrorText, Field, Title } from "@/components/ui";
import { spacing, useColors } from "@/theme";
import { useLang } from "@/lang";

export default function LoginScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { login } = useAuth();
  const { ut, lang, setLang } = useLang();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      // пациент проходит через экран согласия; тот сам пропустит, если принято
      router.replace("/consent");
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("auth.loginFailed"));
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
          <Body muted>{ut("ml.subtitle")}</Body>
        </View>

        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
        />
        <Field label={ut("person.password")} value={password} onChangeText={setPassword} secureTextEntry />

        <ErrorText>{error}</ErrorText>

        <Button title={ut("auth.login")} onPress={onSubmit} loading={busy} />

        <Button
          title={ut("ml.createAccount")}
          onPress={() => router.push("/register")}
          variant="secondary"
        />
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "center" }}>
          <Button title="УКР" variant={lang === "uk" ? "primary" : "secondary"} onPress={() => setLang("uk")} />
          <Button title="РУС" variant={lang === "ru" ? "primary" : "secondary"} onPress={() => setLang("ru")} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
