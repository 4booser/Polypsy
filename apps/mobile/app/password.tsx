import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { passwordActions, passwordForm } from "@/auth/passwordGate";
import { Body, Button, ErrorText, Field, Loader, Title } from "@/components/ui";
import { useLang } from "@/lang";
import { spacing, useColors } from "@/theme";

/**
 * Смена временного пароля — до всего остального.
 *
 * Пароль выдан администратором (заведение или сброс в техпанели), и сервер с
 * ним не отдаёт ничего, кроме профиля и самой смены (auth/passwordGate.ts).
 * Сюда ведут признак mustChangePassword после входа и код
 * password_change_required из любого запроса.
 *
 * Выход из учётной записи — всегда на экране: не помнит временного пароля,
 * взял чужой телефон, передумал — уйти можно, не убивая приложение.
 *
 * Смена обрывает все сессии, включая эту (routes/auth.ts, POST /password).
 * Поэтому после неё экран сам входит новым паролем — человек его только что
 * набрал. Не вышло (второй фактор, обрыв сети) — на экран входа: пароль уже
 * сменён, и войти им можно обычным путём.
 */
export default function PasswordScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { ut } = useLang();
  const { user, loading, login, logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = passwordForm({ current, next, repeat });
  const can = passwordActions({ ready: form.ready, busy });

  if (loading) return <Loader />;
  // сменить пароль некому — к входу, а не пустой экран без выхода
  if (!user) return <Redirect href="/login" />;

  async function change() {
    if (!can.change || !user) return;
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("common.error"));
      setBusy(false);
      return;
    }
    try {
      const challenge = await login(user.email, next);
      if (!challenge) {
        // дальше — обычный путь после входа: согласие, потом приложение
        router.replace("/consent");
        return;
      }
    } catch {
      /* вход не удался — ниже на экран входа, пароль уже новый */
    }
    await logout();
    router.replace("/login");
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: c.bg }}>
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
          <Title>{ut("ops.force.title")}</Title>
          <Body muted>{ut("ops.force.sub")}</Body>
          {user?.email ? <Body>{user.email}</Body> : null}
        </View>

        <Field
          label={ut("ops.force.temp")}
          value={current}
          onChangeText={setCurrent}
          secureTextEntry
          autoComplete="current-password"
          autoFocus
        />
        <Field label={ut("acct.newPassword")} value={next} onChangeText={setNext} secureTextEntry autoComplete="new-password" />
        {form.tooShort ? <ErrorText>{ut("ops.force.short")}</ErrorText> : null}
        <Field label={ut("ops.force.repeat")} value={repeat} onChangeText={setRepeat} secureTextEntry autoComplete="new-password" />
        {form.mismatch ? <ErrorText>{ut("ops.force.mismatch")}</ErrorText> : null}

        <ErrorText>{error}</ErrorText>

        <Button title={ut("acct.changePassword")} onPress={() => void change()} loading={busy} disabled={!can.change} />
        {/* запасной путь — всегда, в том числе пока идёт смена */}
        <Button
          title={ut("consent.signOut")}
          variant="secondary"
          onPress={async () => {
            await logout();
            router.replace("/login");
          }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
