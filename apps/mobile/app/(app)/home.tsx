import { useCallback, useState } from "react";
import { Alert, Linking, RefreshControl, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { AppointmentView } from "@quizzy/shared";
import { api } from "@/api/client";
import { Body, Button, Card, Loader, Title } from "@/components/ui";
import { useAuth } from "@/auth/AuthContext";
import { useLang } from "@/lang";
import { spacing, type, useColors } from "@/theme";

/**
 * Главный экран пациента.
 *
 * Ровно три блока: ближайший приём, что пройти до него, связь и помощь.
 *
 * Динамики здесь нет намеренно. Главный экран открывают по дороге на приём —
 * там нужно «когда и куда» и «что успеть», а не график. Свою кривую тревоги
 * человек смотрит в спокойную минуту, и живёт она на «Здоровье»; каждый день
 * видеть её на первом экране — это само по себе вмешательство.
 */
export default function HomeScreen() {
  const c = useColors();
  const { ut } = useLang();
  const router = useRouter();
  const { user } = useAuth();

  const [appointments, setAppointments] = useState<AppointmentView[] | null>(null);
  const [pending, setPending] = useState<{ id: string; title: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [mine, surveys] = await Promise.all([
      api.myAppointments().catch(() => ({ items: [] as AppointmentView[] })),
      api.listSurveys().catch(() => []),
    ]);
    setAppointments(mine.items);
    /*
     * «Что пройти» — это назначенное и не сданное, а не весь каталог.
     * Список всего доступного превратил бы блок в витрину, из которой ничего
     * не выбирают.
     */
    setPending(
      surveys
        .filter((s) => s.assigned && !s.completedByMe)
        .map((s) => ({ id: s.id, title: s.title })),
    );
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (appointments === null) return <Loader />;

  const next = appointments[0] ?? null;

  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}
    >
      {/* ── 1. ближайший приём ── */}
      <View style={{ gap: spacing.sm }}>
        <Title>{ut("home.nextVisit")}</Title>
        {next ? (
          <NextVisit
            visit={next}
            busy={busy}
            onConfirm={async () => {
              setBusy(true);
              try {
                await api.confirmAppointment(next.id);
                await load();
              } finally {
                setBusy(false);
              }
            }}
            onCancel={() => {
              const hoursLeft = (new Date(next.startsAt).getTime() - Date.now()) / 3600_000;
              /*
               * Поздняя отмена не запрещается, но человек предупреждён, что
               * она видна. Запрет не удерживает — он меняет позднюю отмену на
               * молчаливую неявку, и специалист теряет и слот, и сигнал.
               */
              Alert.alert(
                ut("home.cancelSure"),
                hoursLeft < 24 ? ut("home.cancelLate") : "",
                [
                  { text: ut("bk.screeningLater"), style: "cancel" },
                  {
                    text: ut("home.cancel"),
                    style: "destructive",
                    onPress: async () => {
                      setBusy(true);
                      try {
                        await api.cancelAppointment(next.id);
                        await load();
                      } finally {
                        setBusy(false);
                      }
                    },
                  },
                ],
              );
            }}
            onReschedule={() => router.push("/booking")}
          />
        ) : (
          <Card>
            <Body muted>{ut("home.noVisit")}</Body>
            <View style={{ marginTop: spacing.md }}>
              <Button title={ut("home.bookNow")} onPress={() => router.push("/booking")} />
            </View>
          </Card>
        )}
      </View>

      {/*
        Запись приёма — сразу под ближайшим приёмом, а не в настройках.
        Согласие на запись даётся в тот приём, который записывают, и человек
        должен видеть его там же, где видит сам приём.
      */}
      {next ? <RecordingBlock appointmentId={next.id} /> : null}

      {/* ── 2. что пройти до приёма ── */}
      <View style={{ gap: spacing.sm }}>
        <Title>{ut("home.toDo")}</Title>
        {pending.length === 0 ? (
          <Card>
            <Body muted>{ut("home.nothingToDo")}</Body>
          </Card>
        ) : (
          pending.map((s) => (
            <Card key={s.id}>
              <Body>{s.title}</Body>
              <View style={{ marginTop: spacing.md }}>
                <Button
                  title={ut("bk.screeningStart")}
                  onPress={() => router.push(`/survey/${s.id}`)}
                />
              </View>
            </Card>
          ))
        )}
      </View>

      {/* ── 3. связь и помощь ── */}
      <View style={{ gap: spacing.sm }}>
        <Title>{ut("home.help")}</Title>
        <Card>
          <Body muted>
            {user?.leadSpecialistId ? ut("home.myLead") : ut("home.noLead")}
          </Body>
          <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
            <Button
              title={ut("ms.write")}
              variant="secondary"
              onPress={() => router.push("/messages")}
            />
            <Button
              title={ut("home.safetyPlan")}
              variant="secondary"
              onPress={() => router.push("/safety")}
            />
            {/*
              Телефон доверия нажимается и звонит сразу — без экрана,
              подтверждения и поиска. В кризис лишний шаг между человеком и
              звонком стоит дороже всего остального на этом экране.
            */}
            <Button
              title={`${ut("home.hotline")} · ${ut("home.hotlineNumber")}`}
              variant="secondary"
              onPress={() => void Linking.openURL(`tel:${ut("home.hotlineNumber")}`)}
            />
          </View>
        </Card>
      </View>
    </ScrollView>
  );
}

function NextVisit({
  visit,
  busy,
  onConfirm,
  onCancel,
  onReschedule,
}: {
  visit: AppointmentView;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onReschedule: () => void;
}) {
  const c = useColors();
  const { ut } = useLang();
  const when = new Date(visit.startsAt);

  return (
    <Card>
      {/*
        Время — крупно и первым. Человек открывает этот экран по дороге, и
        первое, что ему нужно, — во сколько и куда, а не кто и зачем.
      */}
      <Text style={{ ...type.display, color: c.text }}>
        {when.toLocaleDateString([], { day: "2-digit", month: "long" })}
        {", "}
        {when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </Text>
      <Body>{visit.specialistName}</Body>
      {visit.mode === "remote" ? (
        <Body muted>{ut("home.remote")}</Body>
      ) : visit.room ? (
        <Body muted>
          {ut("home.room")} {visit.room}
        </Body>
      ) : null}

      <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
        {/*
          Подтверждение — одно нажатие и только пока не подтверждено.
          Специалист смотрит на подтверждение, а не на отправку напоминания:
          отправленный push и прочитанный push — разные вещи.
        */}
        {visit.status === "booked" ? (
          <Button title={ut("home.confirm")} onPress={onConfirm} disabled={busy} />
        ) : (
          <Body muted>{ut("home.confirmed")}</Body>
        )}
        <Button title={ut("home.reschedule")} variant="secondary" onPress={onReschedule} />
        <Button title={ut("home.cancel")} variant="secondary" onPress={onCancel} disabled={busy} />
      </View>
    </Card>
  );
}


/**
 * Согласие на запись этого приёма и остановка.
 *
 * Согласие даётся именно на этот разговор, а не «вообще»: галочка в общем
 * согласии, подписанном год назад, относилась к обследованию, а не к тому,
 * что сегодняшний разговор запишут.
 *
 * Остановить может пациент — в первую очередь он: это его разговор о себе, и
 * право прекратить запись у него не меньше, чем у специалиста.
 */
function RecordingBlock({ appointmentId }: { appointmentId: string }) {
  const c = useColors();
  const { ut } = useLang();
  const [state, setState] = useState<{ status: string; consentAt: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState(await api.recording(appointmentId).catch(() => null));
  }, [appointmentId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!state) return null;
  const live = state.status === "recording";

  return (
    <Card>
      <Body>{ut("rec.title")}</Body>

      {live ? (
        <>
          {/*
            Пока идёт запись, человек видит это на своём экране — не по
            словам специалиста и не по красной лампочке на чужом устройстве.
          */}
          <Body muted>{ut("rec.patientNote")}</Body>
          <View style={{ marginTop: spacing.md }}>
            <Button
              title={ut("rec.stop")}
              variant="secondary"
              disabled={busy}
              onPress={async () => {
                setBusy(true);
                try {
                  await api.recordingStopByPatient(appointmentId);
                  await load();
                } finally {
                  setBusy(false);
                }
              }}
            />
          </View>
        </>
      ) : state.consentAt ? (
        <>
          <Body muted>{ut("rec.consentBySelf")}</Body>
          <View style={{ marginTop: spacing.md }}>
            <Button
              title={ut("rec.consentRevoke")}
              variant="secondary"
              disabled={busy}
              onPress={async () => {
                setBusy(true);
                try {
                  await api.recordingRevoke(appointmentId);
                  await load();
                } finally {
                  setBusy(false);
                }
              }}
            />
          </View>
        </>
      ) : (
        <>
          <Body muted>{ut("rec.consentAsk")}</Body>
          <View style={{ marginTop: spacing.md }}>
            <Button
              title={ut("rec.consentGive")}
              disabled={busy}
              onPress={async () => {
                setBusy(true);
                try {
                  await api.recordingConsent(appointmentId);
                  await load();
                } finally {
                  setBusy(false);
                }
              }}
            />
          </View>
        </>
      )}
    </Card>
  );
}
