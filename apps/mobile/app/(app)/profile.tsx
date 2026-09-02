import { useEffect, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { LANG_NAMES, ageAt, type MyDynamics } from "@quizzy/shared";
import { api } from "@/api/client";
import { authenticate, isAvailable, isEnabled, setEnabled as setBiometrics } from "@/auth/biometrics";
import { useAuth } from "@/auth/AuthContext";
import { API_URL } from "@/config";
import { Body, Button, Card, Chip, Divider, ErrorText, Field, Row, Title } from "@/components/ui";
import { LineChart } from "@/components/viz/LineChart";
import { severityColor, spacing, useColors, useTheme } from "@/theme";
import { useLang } from "@/lang";

// ключи, а не подписи: карта вне компонента, язык — при отрисовке
const ROLE_KEY = {
  superadmin: "mp.roleSuper",
  admin: "mp.roleAdmin",
  user: "mp.rolePatient",
} as const;

export default function AccountScreen() {
  const c = useColors();
  const router = useRouter();
  const { user, logout, refresh } = useAuth();
  const { lang, setLang, ut } = useLang();
  const { choice, setChoice } = useTheme();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    lastName: user?.lastName ?? "",
    firstName: user?.firstName ?? "",
    middleName: user?.middleName ?? "",
    birthDate: user?.birthDate ?? "",
    unit: user?.unit ?? "",
    position: user?.position ?? "",
    specialty: user?.specialty ?? "",
    rank: user?.rank ?? "",
  });
  const [sex, setSex] = useState(user?.sex ?? null);
  const [myDynamics, setMyDynamics] = useState<MyDynamics | null>(null);

  useEffect(() => {
    // динамика приходит только по методикам, где психолог включил показ;
    // пустой ответ — обычное состояние, а не ошибка
    api.myDynamics().then(setMyDynamics).catch(() => setMyDynamics({ surveys: [] }));
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateProfile({
        lastName: form.lastName.trim(),
        firstName: form.firstName.trim(),
        middleName: form.middleName.trim() || null,
        sex,
        birthDate: form.birthDate.trim() || null,
        unit: form.unit.trim() || null,
        position: form.position.trim() || null,
        specialty: form.specialty.trim() || null,
        rank: form.rank.trim() || null,
      });
      await refresh();
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("mp.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const [queueLeft, setQueueLeft] = useState(0);
  useEffect(() => {
    const update = () => setQueueLeft(api.pendingCount());
    update();
    const timer = setInterval(update, 5_000);
    return () => clearInterval(timer);
  }, []);

  async function onLogout() {
    // непустая очередь = несданные ответы; выход стёр бы контекст их отправки
    if (api.pendingCount() > 0) {
      // строка уже есть в словаре на обоих языках; ветвление по языку в
      // разметке означало два текста, из которых правят обычно один
      setError(ut("mp.unsentAnswers"));
      return;
    }
    await logout();
    router.replace("/login");
  }

  return (
    <ScrollView
      style={{ backgroundColor: c.bg }}
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
    >
      <Title>{ut("profile.title")}</Title>

      {/*
        Раскрытие — первым блоком, а не в конце настроек.
        Человек под кодом упирается в него в единственный момент: когда ему
        понадобилась справка и он услышал «нужно имя». Искать эту кнопку под
        выбором темы он не будет.
      */}
      <RevealCard />

      <Card>
        <Body>{ut("profile.language")}</Body>
        <Row>
          {(["uk", "ru"] as const).map((code) => (
            <Chip
              key={code}
              label={LANG_NAMES[code].full}
              selected={lang === code}
              onPress={() => setLang(code)}
            />
          ))}
        </Row>
      </Card>

      {/*
        Тема выбирается явно: приложение открывают и в казарме после отбоя, и
        в кабинете при дневном свете, а системная настройка телефона об этом
        не знает.
      */}
      <Card>
        <Body>{ut("mp.theme")}</Body>
        <Row>
          <Chip label={ut("mp.themeSystem")} selected={choice === "system"} onPress={() => setChoice("system")} />
          <Chip label={ut("mp.themeDark")} selected={choice === "dark"} onPress={() => setChoice("dark")} />
          <Chip label={ut("mp.themeLight")} selected={choice === "light"} onPress={() => setChoice("light")} />
          <Chip label={ut("mp.themeNight")} selected={choice === "night"} onPress={() => setChoice("night")} />
        </Row>
        {choice === "night" ? <Body muted>{ut("mp.themeNightHint")}</Body> : null}
      </Card>

      <BiometricsCard />

      {queueLeft > 0 ? (
        <Card style={{ borderColor: severityColor.mild, borderWidth: 1 }}>
          <Body>
            {ut("mp.queueLeft").replace("{n}", String(queueLeft))}
          </Body>
          <Button
            title={ut("mq.tryNow")}
            variant="secondary"
            onPress={async () => {
              await api.flushQueue().catch(() => {});
              setQueueLeft(api.pendingCount());
            }}
          />
        </Card>
      ) : null}

      {myDynamics?.surveys.length ? (
        <Card>
          <Text style={{ color: c.text, fontSize: 16, fontWeight: "700" }}>
            {ut("mp.myDynamics")}
          </Text>
          <Body muted>
            {ut("mp.dynamicsHint")}
          </Body>
          {myDynamics.surveys.map((sv) => (
            <View key={sv.surveyId} style={{ gap: spacing.sm, marginTop: spacing.sm }}>
              <Body>{sv.title}</Body>
              {sv.scales.map((sc) => (
                <View key={sc.code}>
                  <Text style={{ color: c.muted, fontSize: 12, marginBottom: 4 }}>{sc.title}</Text>
                  <LineChart
                    height={120}
                    series={[{
                      label: sc.title,
                      points: sc.points.map((pt) => ({
                        x: pt.submittedAt.slice(5, 10),
                        y: pt.value,
                        tone: pt.severity ?? undefined,
                      })),
                    }]}
                  />
                </View>
              ))}
            </View>
          ))}
        </Card>
      ) : null}

      <Card>
        <Text style={{ color: c.text, fontSize: 20, fontWeight: "700" }}>{user?.fullName}</Text>
        <Body muted>{user?.email}</Body>
        <View style={{ marginTop: spacing.xs }}>
          <Chip label={ut(ROLE_KEY[(user?.role ?? "user") as keyof typeof ROLE_KEY] ?? "mp.rolePatient")} />
        </View>

        <Divider />
        {editing ? (
          <>
            <Field label={ut("person.lastName")} value={form.lastName} onChangeText={(t) => setForm({ ...form, lastName: t })} />
            <Field label={ut("person.firstName")} value={form.firstName} onChangeText={(t) => setForm({ ...form, firstName: t })} />
            <Field label={ut("person.middleName")} value={form.middleName} onChangeText={(t) => setForm({ ...form, middleName: t })} />
            <View style={{ gap: spacing.xs }}>
              <Text style={{ color: c.muted, fontSize: 13 }}>{ut("person.sex")}</Text>
              <Row gap={spacing.xs}>
                <Chip label={ut("mp.male")} selected={sex === "male"} onPress={() => setSex("male")} />
                <Chip label={ut("mp.female")} selected={sex === "female"} onPress={() => setSex("female")} />
              </Row>
            </View>
            <Field
              label={`${ut("person.birthDate")} (${ut("mp.dateFormat")})`}
              value={form.birthDate}
              onChangeText={(t) => setForm({ ...form, birthDate: t })}
              placeholder="1994-03-12"
            />
            <Field label={ut("person.unit")} value={form.unit} onChangeText={(t) => setForm({ ...form, unit: t })} />
            <Field label={ut("mp.position")} value={form.position} onChangeText={(t) => setForm({ ...form, position: t })} />
            <Field label={ut("mp.specialty")} value={form.specialty} onChangeText={(t) => setForm({ ...form, specialty: t })} />
            <Field label={ut("mp.rank")} value={form.rank} onChangeText={(t) => setForm({ ...form, rank: t })} />
            <ErrorText>{error}</ErrorText>
            <Button title={ut("common.save")} onPress={save} loading={busy} />
            <Button title={ut("common.cancel")} variant="secondary" onPress={() => setEditing(false)} />
          </>
        ) : (
          <>
            <ProfileRow label={ut("person.sex")} value={user?.sex === "male" ? ut("mp.male") : user?.sex === "female" ? ut("mp.female") : "—"} />
            <ProfileRow
              label={ut("mp.age")}
              value={
                ageAt(user?.birthDate ?? null, new Date().toISOString()) !== null
                  ? `${ageAt(user!.birthDate, new Date().toISOString())}`
                  : "—"
              }
            />
            <ProfileRow label={ut("person.unit")} value={user?.unit ?? "—"} />
            <ProfileRow label={ut("mp.position")} value={user?.position ?? "—"} />
            <ProfileRow label={ut("mp.specialty")} value={user?.specialty ?? "—"} />
            <ProfileRow label={ut("mp.rank")} value={user?.rank ?? "—"} />
            <ProfileRow label={ut("mp.since")} value={user?.createdAt.slice(0, 10) ?? "—"} />
            <Button title={ut("mp.edit")} variant="secondary" onPress={() => setEditing(true)} />
          </>
        )}
      </Card>

      {!user?.sex || !user?.birthDate ? (
        <Card>
          <Body muted>
            {ut("mp.noSexBirth")}
          </Body>
        </Card>
      ) : null}

      <Card>
        <Body muted>{ut("mp.server")}</Body>
        <Body>{API_URL}</Body>
      </Card>

      <Button title={ut("auth.logout")} onPress={onLogout} variant="danger" />
    </ScrollView>
  );
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <Row>
      <Body muted>{label}</Body>
      <View style={{ flex: 1 }} />
      <Body>{value}</Body>
    </Row>
  );
}


/**
 * Замок по отпечатку или лицу.
 *
 * Формулировки честные: замок закрывает экран, а не шифрует данные — токен и
 * так лежит в защищённом хранилище системы. И отдельно сказано, чего делать
 * не надо: на общем планшете в кабинете биометрия принадлежит не
 * обследуемому, и замок привяжет учётную запись к чужому пальцу.
 */
function BiometricsCard() {
  const c = useColors();
  const { ut } = useLang();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    void isAvailable().then(setAvailable);
    void isEnabled().then(setOn);
  }, []);

  if (available === null) return null;
  if (!available) return null;

  const toggle = async () => {
    // включение подтверждаем прямо сейчас: иначе человек узнает, что замок не
    // работает, только когда окажется от него заперт
    if (!on && !(await authenticate())) return;
    await setBiometrics(!on);
    setOn(!on);
  };

  return (
    <Card>
      <Text style={{ color: c.text, fontSize: 16, fontWeight: "700" }}>
        {ut("mp.appLock")}
      </Text>
      <Body muted>
        {ut("mp.lockHint")}
      </Body>
      <Body muted>
        {ut("mp.lockShared")}
      </Body>
      <Button
        title={
          on
            ? ut("mp.lockOff")
            : ut("mp.lockOn")
        }
        variant="secondary"
        onPress={() => void toggle()}
      />
    </Card>
  );
}


/**
 * Назвать имя: раскрытие учётной записи под кодом.
 *
 * Показывается только тем, у кого имени нет. Необратимость названа до
 * нажатия, а не после: пройденные под кодом методики привяжутся к имени, и
 * обратной операции нет — карта уже собрана, и притворяться, что данные
 * исчезли, было бы обманом.
 */
function RevealCard() {
  const c = useColors();
  const { ut } = useLang();
  const { user, refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const [passed, setPassed] = useState<number | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user?.anonymous) return null;

  const start = async () => {
    setOpen(true);
    /*
     * Число уже пройденного берётся у сервера. Считать его на клиенте
     * значило бы показать «0 методик» тому, кто прошёл двенадцать, — то
     * есть предупредить не о том.
     */
    setPassed(await api.myResponsesCount().catch(() => null));
  };

  return (
    <Card>
      <Body>{ut("rv.title")}</Body>
      <Body muted>{ut("rv.why")}</Body>

      {!open ? (
        <View style={{ marginTop: spacing.md }}>
          <Button title={ut("rv.title")} variant="secondary" onPress={() => void start()} />
        </View>
      ) : (
        <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
          <Text style={{ color: c.danger }}>{ut("rv.irreversible")}</Text>
          {passed !== null && passed > 0 ? (
            <Text style={{ color: c.danger }}>
              {ut("rv.alreadyPassed").replace("{n}", String(passed))}
            </Text>
          ) : null}
          <Field label={ut("person.lastName")} value={lastName} onChangeText={setLastName} />
          <Field label={ut("person.firstName")} value={firstName} onChangeText={setFirstName} />
          <ErrorText>{error}</ErrorText>
          <Button
            title={ut("rv.confirm")}
            disabled={busy || !firstName.trim() || !lastName.trim()}
            onPress={() => {
              Alert.alert(ut("rv.title"), ut("rv.irreversible"), [
                { text: ut("bk.screeningLater"), style: "cancel" },
                {
                  text: ut("rv.confirm"),
                  style: "destructive",
                  onPress: async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await api.reveal({
                        firstName: firstName.trim(),
                        lastName: lastName.trim(),
                      });
                      await refresh();
                      Alert.alert(ut("rv.done"));
                    } catch (e) {
                      setError(e instanceof Error ? e.message : ut("join.registerFailed"));
                    } finally {
                      setBusy(false);
                    }
                  },
                },
              ]);
            }}
          />
        </View>
      )}
    </Card>
  );
}
