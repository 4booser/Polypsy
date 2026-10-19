import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/auth/AuthContext";
import { useLang } from "@/lang";
import { useExit } from "@/nav/useExit";
import { ErrorText } from "@/components/ui";
import { FormFoot, FormGroup, FormRow } from "@/components/patient/Forms";
import { Hero } from "@/components/patient/Hero";
import { useColors, useIsDark } from "@/theme";
import { ActionBar, Btn } from "@/ui/Button";
import { BackButton, HelpPill, NavBar } from "@/ui/NavBar";
import { Callout, SectionHead } from "@/ui/Panel";
import { Segmented } from "@/ui/Segmented";
import { T } from "@/ui/Text";

/**
 * Регистрация пациента: тип записи (с именем или под кодом), данные для
 * норм, связь и вход. Дальше — согласие на обследование.
 */
export default function RegisterScreen() {
  const c = useColors();
  const router = useRouter();
  const exit = useExit();
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
  const ready = email.trim() && phone.trim() && password.length >= 8 && (anonymous || (lastName.trim() && firstName.trim()));

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: c.ground }}>
      {/* открыта по ссылке первой — «назад» вёл бы в никуда; тогда ко входу заменой */}
      <NavBar flush left={<BackButton label={ut("auth.login")} onPress={exit} />} right={<HelpPill />} />
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        <Hero title={ut("auth.registerTitle")} lead={ut("mpt.rg.lead")} />

        {/* выбор типа аккаунта — первым, потому что от него зависит остальная форма */}
        <View style={{ marginTop: 16, marginHorizontal: 16, gap: 8 }}>
          <T v="body" size={15} weight={700} tone="text2" style={{ paddingLeft: 4 }}>
            {ut("mr.accountType")}
          </T>
          <View accessibilityRole="radiogroup" accessibilityLabel={ut("mr.accountType")} style={{ flexDirection: "row", gap: 8 }}>
            <TypeTile on={!anonymous} title={ut("mr.regular")} hint={ut("mr.withName")} onPress={() => setAnonymous(false)} />
            <TypeTile on={anonymous} title={ut("mr.noName")} hint={ut("mr.codeInstead")} onPress={() => setAnonymous(true)} />
          </View>
          {/*
            Оговорка стоит на экране регистрации, а не в правилах.
            Телефон обязателен и здесь, и это меняет смысл слова «анонимно»:
            запись анонимна ДЛЯ СПЕЦИАЛИСТА — он видит код, а не имя, — но не
            для учреждения. Обещать полную анонимность и при этом хранить
            телефон было бы обманом, а обман здесь — это человек, который
            рассказал лишнее, считая, что его не найдут.
          */}
          {anonymous ? <Callout kind="info" icon="info" text={ut("reg.codedMeaning")} /> : null}
        </View>

        {/* пол и возраст нужны в обоих режимах: без них не применить нормы методик */}
        <SectionHead title={ut("mpt.rg.about")} />
        <FormGroup label={ut("mpt.rg.about")}>
          {anonymous ? null : (
            <>
              <FormRow first label={ut("person.lastName")} value={lastName} onChangeText={setLastName} autoComplete="family-name" />
              <FormRow label={ut("person.firstName")} value={firstName} onChangeText={setFirstName} autoComplete="given-name" />
              <FormRow label={ut("person.middleName")} value={middleName} onChangeText={setMiddleName} />
            </>
          )}
          <FormRow
            first={anonymous}
            label={ut("reg.sex")}
            control={
              <View style={{ flex: 1 }}>
                <Segmented
                  value={sex ?? "none"}
                  onChange={(v) => setSex(v === "none" ? null : v)}
                  accessibilityLabel={ut("reg.sex")}
                  options={[
                    { value: "male", label: ut("person.sex.male") },
                    { value: "female", label: ut("person.sex.female") },
                  ]}
                />
              </View>
            }
          />
          <FormRow
            label={ut("person.birthDate")}
            value={birthDate}
            onChangeText={setBirthDate}
            placeholder={ut("qi.datePattern")}
            keyboardType="numbers-and-punctuation"
          />
        </FormGroup>
        {!sex || !birthDate.trim() ? <FormFoot>{ut("reg.normsHint")}</FormFoot> : null}

        {/*
          Телефон стоит рядом с почтой, а не в конце формы: он такое же
          обязательное поле, и прятать его ниже кнопки «зарегистрироваться»
          значило бы делать вид, что он необязателен.
        */}
        <SectionHead title={ut("mpt.rg.contact")} />
        <FormGroup label={ut("mpt.rg.contact")}>
          <FormRow first label={ut("reg.phone")} value={phone} onChangeText={setPhone} autoCapitalize="none" keyboardType="phone-pad" placeholder="+380 50 111 22 33" autoComplete="tel" />
          <FormRow label={ut("person.email")} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
          <FormRow
            label={ut("person.password")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="new-password"
            placeholder={ut("mpt.rg.passwordMin")}
          />
          <FormRow label={ut("mpt.rg.invite")} value={inviteCode} onChangeText={setInviteCode} autoCapitalize="characters" placeholder="XXXX-XXXX" />
        </FormGroup>
        <FormFoot>{`${ut("reg.phoneWhy")}. ${ut("reg.inviteHint")}.`}</FormFoot>

        {error ? (
          <View style={{ marginTop: 16, marginHorizontal: 16 }}>
            <ErrorText>{error}</ErrorText>
          </View>
        ) : null}
      </ScrollView>
      <ActionBar>
        <Btn title={ut("auth.register")} kind="primary" size="l" flex={1} loading={busy} disabled={!ready} onPress={() => void onSubmit()} />
      </ActionBar>
    </KeyboardAvoidingView>
  );
}

/** Тип учётной записи: плитка с кружком выбора, жирным названием и пояснением */
function TypeTile({ on, title, hint, onPress }: { on: boolean; title: string; hint: string; onPress: () => void }) {
  const c = useColors();
  const dark = useIsDark();
  const ring = dark ? c.vink : c.v;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      accessibilityLabel={`${title}. ${hint}`}
      style={({ pressed }) => ({
        flex: 1,
        flexDirection: "row",
        gap: 10,
        minHeight: 64,
        paddingTop: 12,
        paddingHorizontal: 12,
        paddingBottom: 13,
        borderRadius: 14,
        backgroundColor: on ? c.vtint : pressed ? c.sunk2 : c.sunk,
        borderWidth: on ? 2 : 0,
        borderColor: ring,
      })}
    >
      <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: on ? 6.5 : 2, borderColor: on ? ring : c.ctl, backgroundColor: c.panel }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T v="headline" color={on ? c.vink : c.text}>
          {title}
        </T>
        <T v="sub">{hint}</T>
      </View>
    </Pressable>
  );
}
