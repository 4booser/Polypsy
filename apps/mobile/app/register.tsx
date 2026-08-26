import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/auth/AuthContext";
import { useLang } from "@/lang";
import { Body, Button, Card, Chip, ErrorText, Field, Row, Title } from "@/components/ui";
import { radius, spacing, useColors } from "@/theme";

export default function RegisterScreen() {
  const c = useColors();
  const router = useRouter();
  const { register } = useAuth();
  const { ut, lang } = useLang();

  const [anonymous, setAnonymous] = useState(false);
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [sex, setSex] = useState<"male" | "female" | null>(null);
  const [birthDate, setBirthDate] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      await register({
        anonymous,
        ...(anonymous
          ? {}
          : {
              lastName: lastName.trim(),
              firstName: firstName.trim(),
              middleName: middleName.trim() || null,
            }),
        sex,
        birthDate: birthDate.trim() || null,
        email: email.trim(),
        password,
        inviteCode: inviteCode.trim() || null,
      });
      // пациент проходит через экран согласия; тот сам пропустит, если принято
      router.replace("/consent");
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("join.registerFailed"));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    email.trim() && password.length >= 8 && (anonymous || (lastName.trim() && firstName.trim()));

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: c.bg }}
    >
      <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }}>
        <View style={{ gap: spacing.xs }}>
          <Title>{ut("auth.registerTitle")}</Title>
          <Body muted>{lang === "uk" ? "Реєстрація створює обліковий запис пацієнта" : "Регистрация создаёт учётную запись пациента"}</Body>
        </View>

        {/* выбор типа аккаунта — первым, потому что от него зависит остальная форма */}
        <View style={{ gap: spacing.sm }}>
          <Text style={{ color: c.muted, fontSize: 13 }}>Тип учётной записи</Text>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            {[
              { value: false, label: "Обычная", hint: "С фамилией и именем" },
              { value: true, label: "Без имени", hint: "Вместо ФИО — код" },
            ].map((opt) => {
              const on = anonymous === opt.value;
              return (
                <Pressable
                  key={String(opt.value)}
                  onPress={() => setAnonymous(opt.value)}
                  style={{
                    flex: 1,
                    padding: spacing.md,
                    borderRadius: radius.sm,
                    borderWidth: 1,
                    borderColor: on ? c.primary : c.border,
                    backgroundColor: on ? `${c.primary}1a` : c.card,
                    gap: 2,
                  }}
                >
                  <Text style={{ color: c.text, fontWeight: "600", fontSize: 15 }}>{opt.label}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{opt.hint}</Text>
                </Pressable>
              );
            })}
          </View>
          {anonymous ? (
            <Card>
              <Body muted>
                Фамилия и имя не сохраняются — вместо них система выдаст код вида
                «Респондент А-4821». Email всё равно хранится: по нему выполняется вход,
                поэтому это не полная анонимность.
              </Body>
            </Card>
          ) : null}
        </View>

        {!anonymous ? (
          <>
            <Field label={ut("person.lastName")} value={lastName} onChangeText={setLastName} />
            <Field label={ut("person.firstName")} value={firstName} onChangeText={setFirstName} />
            <Field label={ut("person.middleName")} value={middleName} onChangeText={setMiddleName} />
          </>
        ) : null}

        {/* пол и возраст нужны в обоих режимах: без них не применить нормы методик */}
        <View style={{ gap: spacing.xs }}>
          <Text style={{ color: c.muted, fontSize: 13 }}>Пол</Text>
          <Row gap={spacing.xs}>
            <Chip label={ut("person.sex.male")} selected={sex === "male"} onPress={() => setSex("male")} />
            <Chip label={ut("person.sex.female")} selected={sex === "female"} onPress={() => setSex("female")} />
          </Row>
        </View>
        <Field
          label={`${ut("person.birthDate")} (ГГГГ-ММ-ДД)`}
          value={birthDate}
          onChangeText={setBirthDate}
          placeholder="1994-03-12"
          keyboardType="numbers-and-punctuation"
        />
        {!sex || !birthDate.trim() ? (
          <Body muted>
            Пол и дата рождения не обязательны, но часть методик считает нормы по ним —
            без этих полей результат будет без нормирования.
          </Body>
        ) : null}

        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />
        <Field
          label={ut("person.password8")}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />
        <Field
          label={ut("auth.inviteCode")}
          value={inviteCode}
          onChangeText={setInviteCode}
          autoCapitalize="characters"
          placeholder="XXXX-XXXX"
        />
        <Body muted>
          Код открывает назначенное обследование сразу после входа. Если развёрнута закрытая
          регистрация — без кода войти не получится.
        </Body>

        <ErrorText>{error}</ErrorText>

        <Button title={ut("auth.register")} onPress={onSubmit} loading={busy} disabled={!ready} />
        <Button
          title={lang === "uk" ? "Назад до входу" : "Назад ко входу"}
          variant="secondary"
          onPress={() => router.back()}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
