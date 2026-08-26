import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ageAt, type MyDynamics } from "@quizzy/shared";
import { api } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { API_URL } from "@/config";
import { Body, Button, Card, Chip, Divider, ErrorText, Field, Row, Title } from "@/components/ui";
import { LineChart } from "@/components/viz/LineChart";
import { spacing, useColors } from "@/theme";
import { useLang } from "@/lang";

const ROLE_LABEL: Record<string, string> = {
  superadmin: "Суперадминистратор",
  admin: "Администратор группы",
  user: "Пациент",
};

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
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function onLogout() {
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

      {myDynamics?.surveys.length ? (
        <Card>
          <Text style={{ color: c.text, fontSize: 16, fontWeight: "700" }}>
            {lang === "uk" ? "Моя динаміка" : "Моя динамика"}
          </Text>
          <Body muted>
            {lang === "uk"
              ? "Зміна ваших показників від заміру до заміру. Інтерпретацію дає фахівець."
              : "Изменение ваших показателей от замера к замеру. Интерпретацию даёт специалист."}
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
          <Chip label={ROLE_LABEL[user?.role ?? "user"] ?? "Пациент"} />
        </View>

        <Divider />
        {editing ? (
          <>
            <Field label="Фамилия" value={form.lastName} onChangeText={(t) => setForm({ ...form, lastName: t })} />
            <Field label="Имя" value={form.firstName} onChangeText={(t) => setForm({ ...form, firstName: t })} />
            <Field label="Отчество" value={form.middleName} onChangeText={(t) => setForm({ ...form, middleName: t })} />
            <View style={{ gap: spacing.xs }}>
              <Text style={{ color: c.muted, fontSize: 13 }}>Пол</Text>
              <Row gap={spacing.xs}>
                <Chip label="Мужской" selected={sex === "male"} onPress={() => setSex("male")} />
                <Chip label="Женский" selected={sex === "female"} onPress={() => setSex("female")} />
              </Row>
            </View>
            <Field
              label="Дата рождения (ГГГГ-ММ-ДД)"
              value={form.birthDate}
              onChangeText={(t) => setForm({ ...form, birthDate: t })}
              placeholder="1994-03-12"
            />
            <Field label="Подразделение" value={form.unit} onChangeText={(t) => setForm({ ...form, unit: t })} />
            <Field label="Должность" value={form.position} onChangeText={(t) => setForm({ ...form, position: t })} />
            <Field label="Специальность" value={form.specialty} onChangeText={(t) => setForm({ ...form, specialty: t })} />
            <Field label="Звание" value={form.rank} onChangeText={(t) => setForm({ ...form, rank: t })} />
            <ErrorText>{error}</ErrorText>
            <Button title="Сохранить" onPress={save} loading={busy} />
            <Button title="Отмена" variant="secondary" onPress={() => setEditing(false)} />
          </>
        ) : (
          <>
            <ProfileRow label="Пол" value={user?.sex === "male" ? "Мужской" : user?.sex === "female" ? "Женский" : "—"} />
            <ProfileRow
              label="Возраст"
              value={
                ageAt(user?.birthDate ?? null, new Date().toISOString()) !== null
                  ? `${ageAt(user!.birthDate, new Date().toISOString())}`
                  : "—"
              }
            />
            <ProfileRow label="Подразделение" value={user?.unit ?? "—"} />
            <ProfileRow label="Должность" value={user?.position ?? "—"} />
            <ProfileRow label="Специальность" value={user?.specialty ?? "—"} />
            <ProfileRow label="Звание" value={user?.rank ?? "—"} />
            <ProfileRow label="В системе с" value={user?.createdAt.slice(0, 10) ?? "—"} />
            <Button title="Редактировать" variant="secondary" onPress={() => setEditing(true)} />
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
        <Body muted>Сервер</Body>
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
