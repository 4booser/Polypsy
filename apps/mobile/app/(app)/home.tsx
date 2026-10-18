import { useCallback, useRef, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { recordingRevocable, type AppointmentView, type BatteryAssignment, type SafetyPlan, type SurveyListItem } from "@quizzy/shared";
import { api } from "@/api/client";
import { codeOf } from "@/catalog/surveysTab";
import { Loader } from "@/components/ui";
import { Avatar, firstNameOf, personName } from "@/components/patient/Avatar";
import { BandChip, ChipStrip } from "@/components/patient/BandChip";
import { CodeTile } from "@/components/patient/CodeTile";
import { Hero } from "@/components/patient/Hero";
import { useAuth } from "@/auth/AuthContext";
import { useLang } from "@/lang";
import { useColors } from "@/theme";
import { Btn } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { List, ListRow, Panel, SectionHead, Squircle } from "@/ui/Panel";
import { Count, Pill } from "@/ui/Pill";
import { CallRow } from "@/ui/Rows";
import { BottomSheet } from "@/ui/Sheet";
import { T } from "@/ui/Text";
import { useToast } from "@/ui/Toast";

type Recording = Awaited<ReturnType<typeof api.recording>>;

/**
 * Главный экран пациента.
 *
 * Ровно три блока: ближайший приём, что пройти до него, связь и помощь.
 * Над ними, на полосе, — строка открытого: что ждёт действия прямо сейчас
 * (подтвердить приём, новое письмо, срок методики, план под рукой).
 *
 * Динамики здесь нет намеренно. Главный экран открывают по дороге на приём —
 * там нужно «когда и куда» и «что успеть», а не график. Свою кривую тревоги
 * человек смотрит в спокойную минуту, и живёт она на «Здоровье»; каждый день
 * видеть её на первом экране — это само по себе вмешательство.
 */
export default function HomeScreen() {
  const c = useColors();
  const { ut, locale } = useLang();
  const router = useRouter();
  const toast = useToast();
  const { user } = useAuth();
  const scroll = useRef<ScrollView>(null);
  const visitY = useRef(0);

  const [appointments, setAppointments] = useState<AppointmentView[] | null>(null);
  const [pending, setPending] = useState<SurveyListItem[]>([]);
  const [sets, setSets] = useState<BatteryAssignment[]>([]);
  const [thread, setThread] = useState<{ name: string; unread: number } | null>(null);
  const [plan, setPlan] = useState<SafetyPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    // каждый блок сам по себе: отказ одного запроса не гасит экран целиком
    const [mine, surveys, batteries, threads, safety] = await Promise.all([
      api.myAppointments().catch(() => ({ items: [] as AppointmentView[] })),
      api.listSurveys().catch(() => [] as SurveyListItem[]),
      api.myBatteries().catch(() => [] as BatteryAssignment[]),
      api.threads().catch(() => null),
      api.mySafetyPlan().catch(() => ({ plan: null })),
    ]);
    setAppointments(mine.items);
    const open = batteries.filter((b) => !b.completedAt && b.doneRequired < b.totalRequired);
    setSets(open);
    /*
     * «Що пройти» — это назначенное и не сданное, а не весь каталог.
     * Список всего доступного превратил бы блок в витрину, из которой ничего
     * не выбирают. Методики набора идут строкой набора, а не поштучно.
     */
    const inSet = new Set(open.flatMap((b) => b.steps.map((s) => s.surveyId)));
    setPending(surveys.filter((s) => s.assigned && !s.completedByMe && !inSet.has(s.id)));
    const first = threads?.items[0];
    setThread(first ? { name: first.withName, unread: first.unread } : null);
    setPlan(safety.plan);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (appointments === null) return <Loader />;

  const next = appointments[0] ?? null;
  const toDo = sets.length + pending.length;
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 5 ? ut("mpt.hm.evening") : hour < 12 ? ut("mpt.hm.morning") : hour < 18 ? ut("mpt.hm.day") : ut("mpt.hm.evening");
  const name = firstNameOf(user?.fullName, user?.firstName);
  const today = now.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
  const dueFirst = pending.find((s) => s.dueAt) ?? null;

  const confirm = async () => {
    if (!next) return;
    setBusy(true);
    try {
      await api.confirmAppointment(next.id);
      toast.show(ut("mpt.hm.confirmedToast"));
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : ut("common.error"), { icon: "circle-alert" });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!next) return;
    setBusy(true);
    try {
      await api.cancelAppointment(next.id);
      setCancelOpen(false);
      toast.show(ut("mpt.hm.cancelledToast"));
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : ut("common.error"), { icon: "circle-alert" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ScrollView
        ref={scroll}
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
            tintColor={c.muted}
          />
        }
      >
        <Hero
          title={name ? `${greeting}, ${name}` : greeting}
          lead={[capitalize(today), toDo ? ut("mpt.hm.leadToDo").replace("{n}", String(toDo)) : null].filter(Boolean).join(". ")}
        >
          {/*
            Строка открытого: каждая пилюля ведёт туда, где это делается.
            Нет ничего — нет и строки: пустая полоса пилюль читается как
            «что-то не загрузилось».
          */}
          {(next && next.status === "booked") || thread?.unread || dueFirst || plan ? (
            <ChipStrip accessibilityLabel={ut("mpt.hm.openNow")}>
              {next && next.status === "booked" ? (
                <BandChip
                  icon="calendar-clock"
                  label={ut("mpt.hm.chipConfirm")}
                  onPress={() => scroll.current?.scrollTo({ y: Math.max(0, visitY.current - 8), animated: true })}
                />
              ) : null}
              {thread?.unread ? (
                <BandChip
                  kind="msg"
                  icon="message-circle"
                  label={ut("mpt.hm.chipMessage")}
                  detail={ut("mpt.hm.chipUnread").replace("{n}", String(thread.unread))}
                  onPress={() => router.push("/messages")}
                />
              ) : null}
              {dueFirst?.dueAt ? (
                <BandChip
                  kind={new Date(dueFirst.dueAt) < now ? "warn" : undefined}
                  icon="clipboard-clock"
                  label={`${codeOf(dueFirst.title).code ?? codeOf(dueFirst.title).name} ${ut("sv.due")} ${shortDate(dueFirst.dueAt, locale)}`}
                  onPress={() => router.push(`/survey/${dueFirst.id}`)}
                />
              ) : null}
              {plan ? (
                <BandChip kind="good" icon="shield-check" label={ut("home.safetyPlan")} onPress={() => router.push("/safety")} />
              ) : null}
            </ChipStrip>
          ) : null}
        </Hero>

        {/* ── 1. ближайший приём ── */}
        <View
          onLayout={(e) => {
            visitY.current = e.nativeEvent.layout.y;
          }}
        >
          {next ? (
            <VisitPanel visit={next} busy={busy} onConfirm={() => void confirm()} onCancel={() => setCancelOpen(true)} onMove={() => router.push("/booking")} />
          ) : (
            <Panel title={ut("home.nextVisit")} icon="calendar-clock" style={{ marginTop: 16, marginHorizontal: 16 }}>
              <T v="note">{ut("home.noVisit")}</T>
              <Btn title={ut("home.bookNow")} kind="primary" size="m" icon="calendar-plus" full onPress={() => router.push("/booking")} style={{ marginTop: 4 }} />
            </Panel>
          )}
        </View>

        {/* ── 2. что пройти до приёма ── */}
        <SectionHead title={ut("home.toDo")} right={toDo ? <Count n={toDo} kind="t" /> : undefined} />
        {toDo ? (
          <List>
            {sets.map((b, i) => {
              const step = b.steps.find((s) => s.administration !== "clinician" && (s.state === "current" || s.state === "available"));
              return (
                <ListRow
                  key={b.id}
                  first={i === 0}
                  title={b.batteryTitle}
                  sub={`${b.doneRequired} ${ut("battery.progressOf")} ${b.totalRequired}${step ? `, ${ut("mpt.hm.nextStep").replace("{title}", codeOf(step.title).code ?? step.title)}` : ""}`}
                  lead={<Squircle icon="layers" />}
                  chips={b.dueAt ? <Pill kind={b.overdue ? "warn" : "v"} icon="calendar" label={b.overdue ? ut("sv.overdue") : `${ut("sv.due")} ${shortDate(b.dueAt, locale)}`} /> : undefined}
                  chevron
                  onPress={() => router.push("/surveys")}
                />
              );
            })}
            {pending.map((s, i) => {
              const { name: title, code } = codeOf(s.title);
              const overdue = !!s.dueAt && new Date(s.dueAt) < now;
              return (
                <ListRow
                  key={s.id}
                  first={sets.length === 0 && i === 0}
                  title={title}
                  sub={[code, `${s.questionCount} ${ut("surveys.questions")}`].filter(Boolean).join(", ")}
                  lead={<CodeTile code={code} />}
                  chips={s.dueAt ? <Pill kind={overdue ? "warn" : "v"} icon="calendar" label={overdue ? ut("sv.overdue") : `${ut("sv.due")} ${shortDate(s.dueAt, locale)}`} /> : undefined}
                  chevron
                  onPress={() => router.push(`/survey/${s.id}`)}
                />
              );
            })}
          </List>
        ) : (
          <List>
            <ListRow first title={ut("home.nothingToDo")} lead={<Squircle icon="circle-check" tone="good" />} />
          </List>
        )}

        {/* ── 3. связь и помощь ── */}
        <SectionHead title={ut("home.help")} />
        <List>
          {user?.leadSpecialistId ? (
            <ListRow
              first
              title={thread ? ut("mpt.hm.writeTo").replace("{name}", firstNameOf(thread.name)) : ut("ms.write")}
              sub={thread ? `${personName(thread.name)}, ${ut("mpt.hm.workHours")}` : ut("mpt.hm.workHours")}
              lead={<Squircle icon="message-square-text" />}
              chevron
              onPress={() => router.push("/messages")}
            />
          ) : (
            <ListRow first title={ut("home.noLead")} lead={<Squircle icon="message-square-text" tone="n" />} />
          )}
          <ListRow
            title={ut("home.safetyPlan")}
            sub={plan ? ut("mpt.hm.planSub").replace("{v}", String(plan.version)).replace("{d}", shortDate(plan.reviewedAt ?? plan.createdAt, locale)) : ut("mpt.hm.noPlan")}
            lead={<Squircle icon="shield-check" tone={plan ? "good" : "n"} />}
            chevron
            onPress={() => router.push("/safety")}
          />
          {/*
            Телефон доверия нажимается и звонит сразу — без экрана,
            подтверждения и поиска. В кризис лишний шаг между человеком и
            звонком стоит дороже всего остального на этом экране.
          */}
          <CallRow name={ut("home.hotline")} sub={ut("mui.hotlineSub")} number={ut("home.hotlineNumber")} />
        </List>
      </ScrollView>

      {next ? (
        <BottomSheet
          visible={cancelOpen}
          onClose={() => setCancelOpen(false)}
          title={ut("home.cancelSure")}
          sub={ut("mpt.hm.cancelSub")}
          footer={
            <>
              <Btn
                title={ut("mpt.hm.moveInstead")}
                kind="primary"
                size="l"
                icon="calendar-sync"
                full
                onPress={() => {
                  setCancelOpen(false);
                  router.push("/booking");
                }}
              />
              <Btn title={ut("mpt.hm.cancelVisit")} size="l" icon="calendar-x-2" full loading={busy} onPress={() => void cancel()} />
            </>
          }
        >
          <View style={{ paddingHorizontal: 20, gap: 12 }}>
            <T v="body">{`${visitWhen(next, locale)}, ${personName(next.specialistName)}`}</T>
            {/*
              Поздняя отмена не запрещается, но человек предупреждён, что
              она видна. Запрет не удерживает — он меняет позднюю отмену на
              молчаливую неявку, и специалист теряет и слот, и сигнал.
            */}
            {new Date(next.startsAt).getTime() - Date.now() < 24 * 3600_000 ? (
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Icon name="circle-alert" size={18} color={c.warn} />
                <T v="note" weight={600} color={c.warn} style={{ flex: 1 }}>
                  {ut("home.cancelLate")}
                </T>
              </View>
            ) : null}
          </View>
        </BottomSheet>
      ) : null}
    </>
  );
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function shortDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
}

/** «Субота, 10.10, 10:30–11:20» */
function visitWhen(visit: AppointmentView, locale: string): string {
  const s = new Date(visit.startsAt);
  const e = new Date(visit.endsAt);
  const t = (d: Date) => d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return `${capitalize(s.toLocaleDateString(locale, { weekday: "long" }))}, ${shortDate(visit.startsAt, locale)}, ${t(s)}–${t(e)}`;
}

/** «сьогодні», «завтра», «через 3 дні» — по календарным дням, а не по суткам от сейчас */
function whenFromNow(iso: string, ut: (k: "mpt.hm.today" | "mpt.hm.tomorrow" | "mpt.hm.inDays") => string): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date(iso)) - day(new Date())) / 86_400_000);
  if (days <= 0) return ut("mpt.hm.today");
  if (days === 1) return ut("mpt.hm.tomorrow");
  return ut("mpt.hm.inDays").replace("{n}", String(days));
}

/**
 * Ближайший приём. Время — крупно и первым: экран открывают по дороге, и
 * первое, что нужно, — во сколько и куда, а не кто и зачем.
 */
function VisitPanel({
  visit,
  busy,
  onConfirm,
  onCancel,
  onMove,
}: {
  visit: AppointmentView;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onMove: () => void;
}) {
  const { ut, locale } = useLang();
  const confirmed = visit.status !== "booked";
  const where = visit.mode === "remote" ? ut("home.remote") : visit.room ? `${ut("mpt.hm.room")} ${visit.room}` : null;
  return (
    <Panel
      title={ut("home.nextVisit")}
      icon="calendar-clock"
      pad={false}
      style={{ marginTop: 16, marginHorizontal: 16 }}
      right={
        confirmed ? (
          <Pill kind="good" icon="circle-check" label={ut("mpt.hm.confirmed")} />
        ) : (
          <Pill kind="warn" icon="circle-alert" label={ut("mpt.hm.notConfirmed")} />
        )
      }
    >
      <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16, gap: 12 }}>
        <View>
          <T v="sheetTitle" num>
            {visitWhen(visit, locale)}
          </T>
          <T v="note" weight={600} tone="muted">
            {whenFromNow(visit.startsAt, ut)}
          </T>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Avatar name={visit.specialistName} size={28} />
          <T v="note" weight={600} tone="text2" style={{ flex: 1 }}>
            {[personName(visit.specialistName), where].filter(Boolean).join(", ")}
          </T>
        </View>
        {/*
          Подтверждение — одно нажатие и только пока не подтверждено.
          Специалист смотрит на подтверждение, а не на отправку напоминания:
          отправленный push и прочитанный push — разные вещи.
        */}
        {confirmed ? null : <Btn title={ut("home.confirm")} kind="primary" size="l" icon="check" full loading={busy} onPress={onConfirm} />}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Btn title={ut("home.reschedule")} icon="calendar-sync" flex={1} onPress={onMove} />
          <Btn title={ut("home.cancel")} icon="calendar-x-2" flex={1} disabled={busy} onPress={onCancel} />
        </View>
      </View>
      {/*
        Запись приёма — здесь же, под приёмом, а не в настройках. Согласие
        даётся в тот приём, который записывают, и человек должен видеть его
        там же, где видит сам приём.
      */}
      <RecordingRow appointmentId={visit.id} />
    </Panel>
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
function RecordingRow({ appointmentId }: { appointmentId: string }) {
  const c = useColors();
  const { ut } = useLang();
  const [state, setState] = useState<Recording | null>(null);
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
  const run = (action: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await action();
      await load();
    } finally {
      setBusy(false);
    }
  };

  /*
   * Пока идёт запись, человек видит это на своём экране — не по словам
   * специалиста и не по красной лампочке на чужом устройстве. «Передумав» —
   * пока стенограммы нет: готовую сервер отзывом не трогает (#103), и
   * кнопка, которая всегда кончается отказом, человеку не нужна.
   */
  const sub = live
    ? ut("rec.patientNote")
    : state.consentAt
      ? recordingRevocable(state)
        ? ut("mpt.hm.recAgreed")
        : ut("rec.revokeTooLate")
      : ut("mpt.hm.recOnly");
  const action = live
    ? { title: ut("rec.stop"), onPress: run(() => api.recordingStopByPatient(appointmentId)) }
    : state.consentAt
      ? recordingRevocable(state)
        ? { title: ut("rec.consentRevoke"), onPress: run(() => api.recordingRevoke(appointmentId)) }
        : null
      : { title: ut("mpt.hm.recAgree"), onPress: run(() => api.recordingConsent(appointmentId)) };

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingTop: 12,
        paddingBottom: 14,
        paddingLeft: 16,
        paddingRight: 14,
        borderTopWidth: 1,
        borderTopColor: c.divider,
        // идёт запись — фиолетовым «моё, сейчас», а не красным: запись — не риск для человека
        backgroundColor: live ? c.vtint : c.panel2,
      }}
    >
      <Squircle icon="mic" tone={live ? "v" : "n"} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T v="headline">{live ? ut("rec.recording") : ut("mpt.hm.audio")}</T>
        <T v="sub">{sub}</T>
      </View>
      {action ? <Btn title={action.title} size="s" loading={busy} onPress={() => void action.onPress()} /> : null}
    </View>
  );
}
