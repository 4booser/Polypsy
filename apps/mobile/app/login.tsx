import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/auth/AuthContext";
import { Body, Button, ErrorText, Field, Title } from "@/components/ui";
import { spacing, useColors } from "@/theme";
import { useLang } from "@/lang";
import { LANGS, LANG_NAMES } from "@quizzy/shared";

export default function LoginScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { login, completeMfa } = useAuth();
  const { ut, lang, setLang } = useLang();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Второй шаг — код из приложения (people2): пароль верный, у учётки включён
   * второй фактор. Тот же экран, одно поле вместо двух: шесть цифр или код
   * восстановления, различает их сервер.
   */
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      if (mfaToken) {
        await completeMfa(mfaToken, code.trim());
      } else {
        const challenge = await login(email.trim(), password);
        if (challenge) {
          setMfaToken(challenge.mfaToken);
          return;
        }
      }
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

        {mfaToken ? (
          <>
            <Body muted>{ut("lg.mfa.hint")}</Body>
            <Field
              label={ut("lg.mfa.title")}
              value={code}
              onChangeText={setCode}
              autoCapitalize="none"
              autoComplete="one-time-code"
              autoFocus
            />
          </>
        ) : (
          <>
            <Field
              label={ut("person.email")}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
            />
            <Field label={ut("person.password")} value={password} onChangeText={setPassword} secureTextEntry />
          </>
        )}

        <ErrorText>{error}</ErrorText>

        <Button title={ut("auth.login")} onPress={onSubmit} loading={busy} />
        {mfaToken ? (
          <Button
            title={ut("lg.mfa.back")}
            variant="secondary"
            onPress={() => {
              setMfaToken(null);
              setCode("");
              setError(null);
            }}
          />
        ) : null}

        <Button
          title={ut("ml.createAccount")}
          onPress={() => router.push("/register")}
          variant="secondary"
        />
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "center" }}>
          {/*
            Языки — перечнем и их собственными именами из общей записи: здесь
            стояли литералы «УКР» и «РУС», и третий язык пришлось бы
            вписывать в разметку. Подпись на своём языке — чтобы тот, кто не
            читает текущий, нашёл свой (см. LANG_NAMES).
          */}
          {LANGS.map((code) => (
            <Button
              key={code}
              title={LANG_NAMES[code].short}
              variant={lang === code ? "primary" : "secondary"}
              onPress={() => setLang(code)}
            />
          ))}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
