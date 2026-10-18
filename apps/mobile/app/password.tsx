import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { api } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { MIN_PASSWORD, passwordActions, passwordForm } from "@/auth/passwordGate";
import { ErrorText, Loader } from "@/components/ui";
import { Avatar } from "@/components/patient/Avatar";
import { SecretField } from "@/components/patient/Forms";
import { Hero } from "@/components/patient/Hero";
import { useLang } from "@/lang";
import { useColors } from "@/theme";
import { ActionBar, Btn } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { HelpPill, NavBar } from "@/ui/NavBar";
import { Callout, Panel } from "@/ui/Panel";
import { T } from "@/ui/Text";

/**
 * Смена пароля.
 *
 * Временный пароль (заведение или сброс в техпанели) — до всего остального:
 * сервер с ним не отдаёт ничего, кроме профиля и самой смены
 * (auth/passwordGate.ts). Сюда ведут признак mustChangePassword после входа
 * и код password_change_required из любого запроса. Тот же экран открывают
 * из профиля, чтобы сменить свой пароль по желанию: тогда слева «Назад», а
 * не выход.
 *
 * Выход из учётной записи — всегда на экране временного пароля: не помнит
 * пароля, взял чужой телефон, передумал — уйти можно, не убивая приложение.
 *
 * Смена обрывает все сессии, включая эту (routes/auth.ts, POST /password).
 * Поэтому после неё экран сам входит новым паролем — человек его только что
 * набрал. Не вышло (второй фактор, обрыв сети) — на экран входа: пароль уже
 * сменён, и войти им можно обычным путём.
 */
export default function PasswordScreen() {
  const c = useColors();
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
  const forced = !!user.mustChangePassword;

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

  const longEnough = next.length >= MIN_PASSWORD;
  const differs = next.length > 0 && next !== current;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: c.ground }}>
      <NavBar flush right={<HelpPill />} />
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        <Hero
          title={forced ? ut("ops.force.title") : ut("acct.changePassword")}
          mark={
            <View
              style={{
                width: 48,
                height: 48,
                borderRadius: 15,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: c.bcard,
                borderWidth: 1,
                borderColor: c.bcardline,
              }}
            >
              <Icon name="key-round" size={24} color={c.vink} />
            </View>
          }
          lead={forced ? ut("ops.force.sub") : ut("mpt.pw.lead")}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              alignSelf: "flex-start",
              gap: 8,
              height: 40,
              marginTop: 12,
              paddingLeft: 6,
              paddingRight: 14,
              borderRadius: 20,
              backgroundColor: c.panel,
              borderWidth: 1,
              borderColor: c.border,
            }}
          >
            <Avatar name={user.fullName} size={28} />
            <T v="body" size={15} weight={700} numberOfLines={1}>
              {user.email}
            </T>
          </View>
        </Hero>

        <Panel style={{ marginTop: 16, marginHorizontal: 16 }}>
          <View style={{ gap: 16 }}>
            <SecretField
              label={forced ? ut("ops.force.temp") : ut("acct.currentPassword")}
              value={current}
              onChangeText={setCurrent}
              autoComplete="current-password"
              autoFocus
            />
            <View style={{ gap: 8 }}>
              <SecretField label={ut("acct.newPassword")} icon="key-round" value={next} onChangeText={setNext} autoComplete="new-password" />
              <View accessibilityLabel={ut("mpt.pw.rules")} style={{ gap: 4 }}>
                <Rule ok={longEnough} text={ut("ops.force.short")} />
                <Rule ok={differs} text={forced ? ut("mpt.pw.notTemp") : ut("mpt.pw.notCurrent")} />
              </View>
            </View>
            <SecretField
              label={ut("ops.force.repeat")}
              icon="key-round"
              value={repeat}
              onChangeText={setRepeat}
              autoComplete="new-password"
              error={form.mismatch ? ut("ops.force.mismatch") : null}
              status={
                // совпадение — зелёной галочкой у поля: подпись рядом с «показать» не помещается на 390
                repeat.length > 0 && !form.mismatch ? (
                  <View accessible accessibilityLabel={ut("mpt.pw.match")}>
                    <Icon name="circle-check" size={20} color={c.good} />
                  </View>
                ) : undefined
              }
            />
          </View>
          <ErrorText>{error}</ErrorText>
        </Panel>
        <View style={{ marginTop: 16, marginHorizontal: 16 }}>
          <Callout kind="info" icon="info" text={ut("mpt.pw.endsSessions")} />
        </View>
      </ScrollView>
      <ActionBar>
        {forced ? (
          /* запасной путь — всегда, в том числе пока идёт смена */
          <Btn
            title={ut("ms.exit")}
            icon="log-out"
            size="l"
            flex={1}
            onPress={async () => {
              await logout();
              router.replace("/login");
            }}
          />
        ) : (
          <Btn title={ut("common.back")} icon="chevron-left" size="l" flex={1} onPress={() => router.back()} />
        )}
        <Btn title={ut("acct.changePassword")} kind="primary" icon="check" size="l" flex={2} loading={busy} disabled={!can.change} onPress={() => void change()} />
      </ActionBar>
    </KeyboardAvoidingView>
  );
}

/** Требование к паролю: зелёная галочка, когда выполнено, серый кружок — пока нет */
function Rule({ ok, text }: { ok: boolean; text: string }) {
  const c = useColors();
  return (
    <View accessible accessibilityState={{ checked: ok }} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name={ok ? "circle-check" : "info"} size={18} color={ok ? c.good : c.muted} />
      <T v="note" weight={600} color={ok ? c.text2 : c.muted}>
        {text}
      </T>
    </View>
  );
}
