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
  const { ut } = useLang();

  const [anonymous, setAnonymous] = useState(false);
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [sex, setSex] = useState<"male" | "female" | null>(null);
  const [birthDate, setBirthDate] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
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
        phone: phone.trim(),
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

  /*
   * Телефон в условии готовности наравне с почтой и паролем: он обязателен в
   * обоих режимах, и «анонимный» аккаунт здесь не исключение — иначе человек
   * дошёл бы до кнопки и получил отказ сервера, не поняв, за что.
   */
  const ready =
    email.trim() &&
    phone.trim() &&
    password.length >= 8 &&
    (anonymous || (lastName.trim() && firstName.trim()));

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: c.bg }}
    >
      <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }}>
        <View style={{ gap: spacing.xs }}>
          <Title>{ut("auth.registerTitle")}</Title>
          <Body muted>{ut("mr.createsPatient")}</Body>
        </View>

        {/* выбор типа аккаунта — первым, потому что от него зависит остальная форма */}
        <View style={{ gap: spacing.sm }}>
          <Text style={{ color: c.muted, fontSize: 13 }}>{ut("mr.accountType")}</Text>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            {[
              { value: false, label: ut("mr.regular"), hint: ut("mr.withName") },
              { value: true, label: ut("mr.noName"), hint: ut("mr.codeInstead") },
            ].map((opt) => {
              const on = anonymous === opt.value;
              return (
                <Pressable
                  key={String(opt.value)}
                  onPress={() => setAnonymous(opt.value)}
                  accessibilityRole="radio"
                  accessibilityLabel={`${opt.label}. ${opt.hint}`}
                  accessibilityState={{ checked: on }}
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
          {/*
            Оговорка стоит на экране регистрации, а не в правилах.
            Телефон обязателен и здесь, и это меняет смысл слова «анонимно»:
            запись анонимна ДЛЯ СПЕЦИАЛИСТА — он видит код, а не имя, — но не
            для учреждения. Обещать полную анонимность и при этом хранить
            телефон было бы обманом, а обман здесь — это человек, который
            рассказал лишнее, считая, что его не найдут.
          */}
          {anonymous ? (
            <Card>
              <Body muted>{ut("reg.codedMeaning")}</Body>
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
          <Text style={{ color: c.muted, fontSize: 13 }}>{ut("reg.sex")}</Text>
          <Row gap={spacing.xs}>
            <Chip label={ut("person.sex.male")} selected={sex === "male"} onPress={() => setSex("male")} />
            <Chip label={ut("person.sex.female")} selected={sex === "female"} onPress={() => setSex("female")} />
          </Row>
        </View>
        <Field
          label={`${ut("person.birthDate")} (${ut("qi.datePattern")})`}
          value={birthDate}
          onChangeText={setBirthDate}
          placeholder="1994-03-12"
          keyboardType="numbers-and-punctuation"
        />
        {!sex || !birthDate.trim() ? (
          <Body muted>{ut("reg.normsHint")}</Body>
        ) : null}

        {/*
          Телефон стоит рядом с почтой, а не в конце формы: он такое же
          обязательное поле, и прятать его ниже кнопки «зарегистрироваться»
          значило бы делать вид, что он необязателен.
        */}
        <Field
          label={ut("reg.phone")}
          value={phone}
          onChangeText={setPhone}
          autoCapitalize="none"
          keyboardType="phone-pad"
          placeholder="+380 50 111 22 33"
        />
        <Body muted>{ut("reg.phoneWhy")}</Body>

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
        <Body muted>{ut("reg.inviteHint")}</Body>

        <ErrorText>{error}</ErrorText>

        <Button title={ut("auth.register")} onPress={onSubmit} loading={busy} disabled={!ready} />
        <Button
          title={ut("mr.backToLogin")}
          variant="secondary"
          onPress={() => router.back()}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
