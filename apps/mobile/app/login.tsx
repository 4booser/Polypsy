import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { LANGS, LANG_NAMES } from "@quizzy/shared";
import { useAuth } from "@/auth/AuthContext";
import { ErrorText } from "@/components/ui";
import { CrisisStrip } from "@/components/patient/Crisis";
import { SecretField } from "@/components/patient/Forms";
import { Hero } from "@/components/patient/Hero";
import { LogoTile } from "@/components/patient/Logo";
import { useColors, useIsDark, useShadows } from "@/theme";
import { useLang } from "@/lang";
import { Btn } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { BackButton, HelpPill, NavBar } from "@/ui/NavBar";
import { Panel, Squircle } from "@/ui/Panel";
import { Segmented } from "@/ui/Segmented";
import { T } from "@/ui/Text";

const CODE_LENGTH = 6;

/**
 * Вход. Почта и пароль; второй шаг — код из приложения, если у учётной
 * записи включён второй фактор (people2): тот же экран, шесть клеток или
 * код восстановления, различает их сервер.
 *
 * Язык — до входа, своими именами (LANG_NAMES): тот, кто не читает текущий,
 * находит свой. Телефон доверия — внизу и без входа: он не требует учётной
 * записи.
 */
export default function LoginScreen() {
  const c = useColors();
  const router = useRouter();
  const { login, completeMfa } = useAuth();
  const { ut, lang, setLang } = useLang();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState<{ token: string; email: string } | null>(null);
  const [code, setCode] = useState("");
  /** Код восстановления вместо шести цифр: телефона с приложением нет под рукой */
  const [recovery, setRecovery] = useState(false);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      if (mfa) {
        await completeMfa(mfa.token, code.trim());
      } else {
        const challenge = await login(email.trim(), password);
        if (challenge) {
          setMfa({ token: challenge.mfaToken, email: email.trim() });
          setCode("");
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

  const back = () => {
    setMfa(null);
    setCode("");
    setRecovery(false);
    setError(null);
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: c.ground }}>
      <NavBar
        flush
        left={
          mfa ? (
            <BackButton label={ut("auth.login")} onPress={back} />
          ) : (
            <View accessible accessibilityRole="header" accessibilityLabel={ut("shell.brand")} style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingLeft: 8 }}>
              <LogoTile />
              <T v="headline" size={18} scale={false}>
                {ut("shell.brand")}
              </T>
            </View>
          )
        }
        right={<HelpPill />}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 28 }} keyboardShouldPersistTaps="handled">
        {mfa ? (
          <>
            <Hero title={ut("lg.mfa.title")} lead={ut("mpt.lg.codeLead").replace("{email}", mfa.email)} />
            <Panel style={{ marginTop: 16, marginHorizontal: 16 }}>
              {recovery ? (
                <Field
                  label={ut("mpt.lg.recoveryCode")}
                  value={code}
                  onChangeText={setCode}
                  icon="key-round"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                />
              ) : (
                <CodeBoxes value={code} onChange={setCode} label={ut("mpt.lg.codeOf").replace("{n}", String(code.length))} />
              )}
              <ErrorText>{error}</ErrorText>
              <Btn
                title={ut("auth.login")}
                kind="primary"
                size="l"
                full
                loading={busy}
                disabled={recovery ? !code.trim() : code.length < CODE_LENGTH}
                onPress={() => void onSubmit()}
                style={{ marginTop: 8 }}
              />
              {recovery ? null : (
                <T v="sub" center>
                  {ut("mpt.lg.codeHint")}
                </T>
              )}
            </Panel>
            {recovery ? null : (
              <Panel style={{ marginTop: 16, marginHorizontal: 16 }}>
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <Squircle icon="key-round" />
                  <View style={{ flex: 1 }}>
                    <T v="headline">{ut("mpt.lg.noPhone")}</T>
                    <T v="note" style={{ marginTop: 2 }}>
                      {ut("mpt.lg.noPhoneText")}
                    </T>
                  </View>
                </View>
                <Btn
                  title={ut("mpt.lg.useRecovery")}
                  kind="outline"
                  icon="key-round"
                  full
                  onPress={() => {
                    setRecovery(true);
                    setCode("");
                  }}
                  style={{ marginTop: 4 }}
                />
              </Panel>
            )}
            <View style={{ marginTop: 12, marginHorizontal: 16 }}>
              <Btn title={ut("lg.mfa.back")} kind="ghost" size="l" icon="arrow-left-right" full onPress={back} />
            </View>
          </>
        ) : (
          <>
            <Hero title={ut("auth.login")} lead={ut("mpt.lg.lead")} />
            <Panel style={{ marginTop: 16, marginHorizontal: 16 }}>
              <View style={{ gap: 16 }}>
                <Field
                  label={ut("person.email")}
                  value={email}
                  onChangeText={setEmail}
                  icon="at-sign"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoComplete="email"
                  textContentType="username"
                />
                <SecretField
                  label={ut("person.password")}
                  value={password}
                  onChangeText={setPassword}
                  autoComplete="current-password"
                  textContentType="password"
                  hint={ut("mpt.lg.forgot")}
                  onSubmitEditing={() => void onSubmit()}
                />
              </View>
              <ErrorText>{error}</ErrorText>
              <Btn title={ut("auth.login")} kind="primary" size="l" full loading={busy} onPress={() => void onSubmit()} style={{ marginTop: 8 }} />
            </Panel>
            <View style={{ marginTop: 12, marginHorizontal: 16 }}>
              <Btn title={ut("ml.createAccount")} size="l" icon="user-round-plus" full onPress={() => router.push("/register")} />
            </View>
            {/*
              Языки — перечнем и их собственными именами из общей записи: здесь
              стояли литералы «УКР» и «РУС», и третий язык пришлось бы
              вписывать в разметку. Подпись на своём языке — чтобы тот, кто не
              читает текущий, нашёл свой (см. LANG_NAMES).
            */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 14, marginHorizontal: 20 }}>
              <T v="body" size={15} weight={700} tone="text2">
                {ut("mpt.lg.lang")}
              </T>
              <View style={{ flex: 1 }}>
                <Segmented
                  value={lang}
                  onChange={setLang}
                  accessibilityLabel={ut("profile.language")}
                  options={LANGS.map((code) => ({ value: code, label: LANG_NAMES[code].full }))}
                />
              </View>
            </View>
          </>
        )}
        <CrisisStrip note={ut("mpt.crisisNoLogin")} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * Шесть клеток кода. Ввод — одно скрытое поле поверх клеток: цифры
 * набираются подряд, вставка из буфера и автозаполнение кода из СМС
 * работают как в обычном поле, а клетки только показывают набранное.
 */
function CodeBoxes({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const c = useColors();
  const sh = useShadows();
  const dark = useIsDark();
  const input = useRef<TextInput>(null);
  const [focus, setFocus] = useState(true);
  const ring = dark ? c.vink : c.v;
  return (
    <View style={{ gap: 6 }}>
      <T v="sub" size={15} weight={700} tone="text2">
        {label}
      </T>
      <Pressable onPress={() => input.current?.focus()} accessible={false}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {Array.from({ length: CODE_LENGTH }, (_, i) => {
            const on = focus && i === Math.min(value.length, CODE_LENGTH - 1);
            return (
              <View
                key={i}
                style={{
                  flex: 1,
                  height: 60,
                  borderRadius: radiusCode,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: c.panel,
                  borderWidth: on ? 2 : 1,
                  borderColor: on ? ring : c.ctl,
                  boxShadow: on ? `0px 0px 0px 4px ${c.vtint}` : sh.panel,
                }}
              >
                <T v="number" size={26} num scale={false}>
                  {value[i] ?? ""}
                </T>
              </View>
            );
          })}
        </View>
        <TextInput
          ref={input}
          value={value}
          onChangeText={(t) => onChange(t.replace(/\D/g, "").slice(0, CODE_LENGTH))}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          maxLength={CODE_LENGTH}
          autoFocus
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          accessibilityLabel={label}
          caretHidden
          style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, opacity: 0.02, color: "transparent" }}
        />
      </Pressable>
    </View>
  );
}

const radiusCode = 14;
