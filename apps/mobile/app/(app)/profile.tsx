import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ageAt, type MyDynamics } from "@quizzy/shared";
import { api } from "@/api/client";
import { authenticate, isAvailable, isEnabled, setEnabled as setBiometrics } from "@/auth/biometrics";
import { useAuth } from "@/auth/AuthContext";
import { API_URL } from "@/config";
import { Body, Button, Card, Chip, Divider, ErrorText, Field, Row, Title } from "@/components/ui";
import { LineChart } from "@/components/viz/LineChart";
import { severityColor, spacing, useColors } from "@/theme";
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
      setError(
        lang === "uk"
          ? "Є невідправлені відповіді — зачекайте на мережу, вони підуть самі."
          : ut("mp.unsentAnswers"),
      );
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

      <Card>
        <Body>{ut("profile.language")}</Body>
        <Row>
          <Chip label="Українська" selected={lang === "uk"} onPress={() => setLang("uk")} />
          <Chip label="Русский" selected={lang === "ru"} onPress={() => setLang("ru")} />
        </Row>
      </Card>

      <BiometricsCard />

      {queueLeft > 0 ? (
        <Card style={{ borderColor: severityColor.mild, borderWidth: 1 }}>
          <Body>
            {lang === "uk"
              ? `Не відправлено відповідей: ${queueLeft}. Підуть самі, щойно з’явиться мережа.`
              : `Не отправлено ответов: ${queueLeft}. Уйдут сами, как только появится сеть.`}
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
            Не заполнены пол и дата рождения. Часть методик использует нормы, которые
            зависят от пола и возраста, — без них результат будет посчитан без нормирования.
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
