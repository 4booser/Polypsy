import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { LOCALE_OF } from "@quizzy/shared";
import type { BatteryAssignment, BatteryStep, Lang, SurveyGroupWithCounts, SurveyListItem } from "@quizzy/shared";
import { api } from "@/api/client";
import { codeOf, loadSurveysTab, patientTabs, type DoneItem } from "@/catalog/surveysTab";
import { useAuth } from "@/auth/AuthContext";
import { Loader } from "@/components/ui";
import { CodeTile } from "@/components/patient/CodeTile";
import { formatScore } from "@/components/patient/History";
import { Hero } from "@/components/patient/Hero";
import { useColors, useIsDark, useShadows } from "@/theme";
import { useLang } from "@/lang";
import { ensurePushRegistered } from "@/push";
import { Btn } from "@/ui/Button";
import { Icon, type IconName } from "@/ui/Icon";
import { Callout, List, ListRow, SectionHead, Squircle } from "@/ui/Panel";
import { Count, Pill, SevPill } from "@/ui/Pill";
import { Segmented } from "@/ui/Segmented";
import { T } from "@/ui/Text";

type PatientTab = "assigned" | "done" | "self";

/**
 * «Опитування».
 *
 * У пациента — три вкладки по смыслу: назначенное (набор со сроком и
 * состояниями шагов, отдельные назначения), пройденное и то, что можно
 * пройти самому. У сотрудника — каталог по группам консоли: он смотрит
 * каталог, а не свой список дел, и отсюда же заполняет методику за пациента
 * в обходе (onBehalfOf).
 *
 * Загрузка — catalog/surveysTab.ts: пациенту справочник групп консоли не
 * запрашивается (он закрыт, 403 ронял всю вкладку), и ни один
 * вспомогательный отказ не роняет список.
 */
export default function SurveysScreen() {
  /*
   * Разрешение спрашиваем здесь, а не при первом запуске: на экране заданий
   * человек уже понимает, о чём его уведомят. Запрос без контекста
   * отклоняют, и второй раз система его не покажет.
   */
  useEffect(() => {
    void ensurePushRegistered();
  }, []);

  const c = useColors();
  const { ut } = useLang();
  const router = useRouter();
  const { isAdmin } = useAuth();

  const [groups, setGroups] = useState<SurveyGroupWithCounts[]>([]);
  const [surveys, setSurveys] = useState<SurveyListItem[] | null>(null);
  const [batteries, setBatteries] = useState<BatteryAssignment[]>([]);
  const [responses, setResponses] = useState<Awaited<ReturnType<typeof api.myResponses>>>([]);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<PatientTab>("assigned");

  /*
   * Режим обхода: специалист заполняет методику за пациента. Идентификатор
   * приходит из карты обхода и передаётся дальше в прохождение — экран сам
   * ничего про пациента не знает, кроме того, что он есть.
   */
  const { onBehalfOf } = useLocalSearchParams<{ onBehalfOf?: string }>();
  const forPatient = onBehalfOf ? `?onBehalfOf=${onBehalfOf}` : "";
  const open = (id: string) => router.push(`/survey/${id}${forPatient}`);

  const load = useCallback(async () => {
    const data = await loadSurveysTab(api, { staff: isAdmin });
    setFailed(data.surveysFailed);
    setGroups(data.groups);
    setSurveys(data.surveys);
    setBatteries(data.batteries);
    setResponses(data.responses);
  }, [isAdmin]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (surveys === null) return <Loader />;

  const refresh = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
      tintColor={c.muted}
    />
  );
  const failure = failed ? (
    <View style={{ marginTop: 16, marginHorizontal: 16 }}>
      <Callout kind="warn" icon="cloud-off" text={ut("surveys.loadFailed")} />
    </View>
  ) : null;

  if (isAdmin) {
    return (
      <ScrollView style={{ backgroundColor: c.ground }} contentContainerStyle={{ paddingBottom: 24 }} refreshControl={refresh}>
        <Hero title={ut("tab.surveys")} />
        {failure}
        <StaffCatalog surveys={surveys} groups={groups} onOpen={open} />
      </ScrollView>
    );
  }

  const tabs = patientTabs({ surveys, batteries, responses });
  const assignedCount = batteries.length + tabs.assigned.length;

  return (
    <ScrollView style={{ backgroundColor: c.ground }} contentContainerStyle={{ paddingBottom: 24 }} refreshControl={refresh}>
      <Hero title={ut("tab.surveys")} lead={ut("mpt.sv.lead")} compact>
        <View style={{ marginTop: 16 }}>
          <Segmented<PatientTab>
            onBand
            value={tab}
            onChange={setTab}
            accessibilityLabel={ut("tab.surveys")}
            options={[
              // список не загрузился — счётчиков нет: «Пройдені 0» без сети читалось бы как «ничего не сдано»
              { value: "assigned", label: ut("mpt.sv.assigned"), count: failed ? undefined : assignedCount },
              { value: "done", label: ut("mpt.sv.done"), count: failed ? undefined : tabs.done.length },
              // у каталога «самостійно» счётчик не нужен: это не список дел, и число в нём — шум
              { value: "self", label: ut("mpt.sv.self") },
            ]}
          />
        </View>
      </Hero>
      {failure}

      {tab === "assigned" ? (
        <>
          {batteries.map((b) => (
            <BatteryPanel key={b.id} assignment={b} onOpen={open} />
          ))}
          {/*
            Назначенное поштучно — со сроком. Срок стоит на строке, а не в
            подписи раздела: сроки у назначений разные, и один общий
            заголовок «до такого-то» врал бы про половину из них.
          */}
          {tabs.assigned.length ? (
            <>
              <SectionHead title={ut("sv.assigned")} right={<Count n={tabs.assigned.length} kind="t" />} />
              <List>
                {tabs.assigned.map((s, i) => (
                  <SurveyRow key={s.id} survey={s} first={i === 0} onOpen={open} due />
                ))}
              </List>
            </>
          ) : null}
          {assignedCount === 0 && !failed ? <EmptyNote icon="clipboard-check" text={ut("mpt.sv.nothingAssigned")} /> : null}
        </>
      ) : null}

      {tab === "done" ? (
        tabs.done.length ? (
          <>
            <SectionHead title={ut("mpt.sv.doneTitle")} />
            <List>
              {tabs.done.map((d, i) => (
                <DoneRow key={d.survey.id} item={d} first={i === 0} onOpen={open} />
              ))}
            </List>
          </>
        ) : (
          <EmptyNote icon="history" text={ut("mpt.sv.nothingDone")} />
        )
      ) : null}

      {tab === "self" ? (
        tabs.self.length ? (
          <>
            <SectionHead title={ut("mpt.sv.selfTitle")} sub={ut("mpt.sv.selfSub")} />
            <List>
              {tabs.self.map((s, i) => (
                <SurveyRow key={s.id} survey={s} first={i === 0} onOpen={open} />
              ))}
            </List>
          </>
        ) : (
          <EmptyNote icon="clipboard-list" text={ut("surveys.empty")} />
        )
      ) : null}
    </ScrollView>
  );
}

function EmptyNote({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View style={{ alignItems: "center", gap: 12, paddingTop: 40, paddingHorizontal: 32 }}>
      <Squircle icon={icon} tone="n" size={48} />
      <T v="note" center>
        {text}
      </T>
    </View>
  );
}

/** «пт 09.10» — день недели и дата, как в наборе */
function formatDay(iso: string, lang: Lang): string {
  // локаль — общей записью: у английского en-GB, день первым (см. LOCALE_OF)
  const d = new Date(iso);
  const wd = d.toLocaleDateString(LOCALE_OF[lang], { weekday: "short" });
  const dm = d.toLocaleDateString(LOCALE_OF[lang], { day: "2-digit", month: "2-digit" });
  return `${wd} ${dm}`;
}

/** Сколько полных дней до срока; прошёл — отрицательное */
function daysLeft(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/** Строка методики: код, название, число вопросов; у назначенного — срок */
function SurveyRow({
  survey,
  first,
  onOpen,
  due,
}: {
  survey: SurveyListItem;
  first: boolean;
  onOpen: (id: string) => void;
  due?: boolean;
}) {
  const { ut, lang } = useLang();
  const { name, code } = codeOf(survey.title);
  const minutes = survey.timeLimitSec ? Math.round(survey.timeLimitSec / 60) : null;
  const sub = [code, `${survey.questionCount} ${ut("surveys.questions")}`, minutes ? ut("mpt.rn.limit").replace("{n}", String(minutes)) : null]
    .filter(Boolean)
    .join(", ");
  const overdue = !!survey.dueAt && new Date(survey.dueAt) < new Date();
  return (
    <ListRow
      first={first}
      title={name}
      sub={sub}
      lead={<CodeTile code={code} />}
      chevron
      onPress={() => onOpen(survey.id)}
      chips={
        due && survey.dueAt ? (
          overdue ? (
            <Pill kind="warn" icon="circle-alert" label={ut("sv.overdue")} />
          ) : (
            <Pill kind="v" icon="calendar" label={`${ut("sv.due")} ${formatDay(survey.dueAt, lang)}`} />
          )
        ) : undefined
      }
      accessibilityLabel={[survey.title, sub, due && survey.dueAt ? (overdue ? ut("sv.overdue") : `${ut("sv.due")} ${formatDay(survey.dueAt, lang)}`) : null]
        .filter(Boolean)
        .join(". ")}
    />
  );
}

/**
 * Пройденное: когда, и — где методика показывает результат человеку — балл
 * с выраженностью словом и «було N» с прошлого раза. Без разрешения
 * методики сервер баллов не отдаёт, и строка остаётся без числа.
 */
function DoneRow({ item, first, onOpen }: { item: DoneItem; first: boolean; onOpen: (id: string) => void }) {
  const c = useColors();
  const { ut, locale } = useLang();
  const { name, code } = codeOf(item.survey.title);
  const score = item.last?.scores.find((s) => s.band) ?? item.last?.scores[0] ?? null;
  const before = score ? item.before?.scores.find((s) => s.scaleId === score.scaleId || s.scaleCode === score.scaleCode) : null;
  const when = item.last?.submittedAt
    ? `${new Date(item.last.submittedAt).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" })}, ${new Date(item.last.submittedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`
    : ut("surveys.completed");
  const sub = [when, before ? ut("mpt.sv.wasBefore").replace("{v}", fmt(before.rawScore)) : null].filter(Boolean).join(", ");
  return (
    <ListRow
      first={first}
      title={name}
      sub={sub}
      lead={<CodeTile code={code} neutral />}
      onPress={item.survey.allowRetake ? () => onOpen(item.survey.id) : undefined}
      accessibilityHint={item.survey.allowRetake ? ut("mpt.sv.retake") : undefined}
      // слово полосы методики бывает длинным («Без ознак зниженого благополуччя») — под названием, а не в узком столбце
      chips={score?.band ? <SevPill small severity={score.band.severity} label={score.band.label} /> : undefined}
      end={
        score ? (
          <View style={{ alignSelf: "center", paddingLeft: 4 }}>
            <T v="headline" size={22} num scale={false} color={c.text}>
              {fmt(score.rawScore)}
            </T>
          </View>
        ) : undefined
      }
    />
  );
}

// балл — тем же форматом, что на «Здоров’ї» и в итоге методики: дробь с запятой по-украински
const fmt = formatScore;

/**
 * Набор от специалиста: срок, полоса сделанного и шаги по порядку.
 *
 * Порядок здесь не подсказка, а правило: при строгом порядке следующая
 * методика открывается только после предыдущей, поэтому недоступные шаги
 * показаны, но не нажимаются — иначе человек упирается в отказ без объяснения.
 */
function BatteryPanel({ assignment, onOpen }: { assignment: BatteryAssignment; onOpen: (surveyId: string) => void }) {
  const c = useColors();
  const sh = useShadows();
  const dark = useIsDark();
  const { ut, lang, locale } = useLang();
  const overdue = assignment.overdue;
  // в наборе есть часть специалиста: она идёт параллельно и не мешает
  // проходить свои методики, но человек должен знать, что батарея не
  // закроется, пока психолог не внесёт свою часть
  const waiting = assignment.steps.find(
    (s) => s.state !== "done" && s.state !== "retired" && s.administration === "clinician" && s.required,
  );
  const start = assignment.steps.find((s) => s.administration !== "clinician" && (s.state === "current" || s.state === "available"));
  const left = assignment.dueAt ? daysLeft(assignment.dueAt) : null;
  const fill = dark ? c.vink : c.v;

  return (
    <View
      style={{
        marginTop: 16,
        marginHorizontal: 16,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: overdue ? c.warnline : c.border,
        backgroundColor: c.panel,
        boxShadow: sh.panel,
        overflow: "hidden",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, paddingTop: 14, paddingRight: 14, paddingLeft: 16, paddingBottom: 4 }}>
        <View style={{ marginTop: 2 }}>
          <Squircle icon="layers" />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T v="section" accessibilityRole="header">
            {assignment.batteryTitle}
          </T>
          <T v="sub" style={{ marginTop: 2 }}>
            {ut("mpt.sv.assignedOn").replace("{d}", new Date(assignment.assignedAt).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" }))}
          </T>
        </View>
        <View style={{ marginTop: 3 }}>
          <Pill kind="v" label={`${assignment.doneRequired} ${ut("battery.progressOf")} ${assignment.totalRequired}`} />
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 10, marginHorizontal: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
          <Icon name={overdue ? "circle-alert" : "calendar-clock"} size={17} color={overdue ? c.warn : c.muted} />
          <T v="body" size={15} weight={700} color={overdue ? c.warn : c.text2} style={{ flexShrink: 1 }}>
            {overdue ? ut("battery.overdue") : assignment.dueAt ? `${ut("battery.dueBy")} ${formatDay(assignment.dueAt, lang)}` : ut("battery.noDue")}
          </T>
        </View>
        {left !== null && left >= 0 && !overdue ? (
          <T v="sub" tone="muted">
            {ut("mpt.sv.daysLeft").replace("{n}", String(left))}
          </T>
        ) : null}
      </View>

      {/* полоса обязательного: по сегменту на шаг — сколько сделано, а не проценты */}
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: assignment.totalRequired, now: assignment.doneRequired }}
        style={{ flexDirection: "row", gap: 4, marginTop: 8, marginHorizontal: 16, marginBottom: 12 }}
      >
        {Array.from({ length: Math.max(1, assignment.totalRequired) }, (_, i) => (
          <View
            key={i}
            style={[
              { flex: 1, height: 6, borderRadius: 3, backgroundColor: i < assignment.doneRequired ? fill : i === assignment.doneRequired ? c.vline : c.sunk2 },
              i === assignment.doneRequired ? { borderWidth: 1.5, borderColor: fill } : null,
            ]}
          />
        ))}
      </View>

      <View style={{ borderTopWidth: 1, borderTopColor: c.divider }}>
        {assignment.steps.map((step, i) => (
          <StepRow key={step.surveyId} step={step} index={i} first={i === 0} onOpen={onOpen} />
        ))}
      </View>

      {waiting ? (
        <View style={{ flexDirection: "row", gap: 8, paddingVertical: 12, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: c.divider }}>
          <View style={{ marginTop: 3 }}>
            <Icon name="info" size={16} color={c.muted} />
          </View>
          <T v="note" weight={600} tone="text2" style={{ flex: 1 }}>
            {`«${waiting.title}» ${ut("battery.clinicianNote")}`}
          </T>
        </View>
      ) : null}

      {start ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 16, paddingTop: waiting ? 4 : 12 }}>
          <Btn
            title={ut("mpt.sv.start").replace("{title}", codeOf(start.title).code ?? codeOf(start.title).name)}
            kind="primary"
            size="l"
            full
            icon="arrow-right"
            iconEnd
            onPress={() => onOpen(start.surveyId)}
          />
        </View>
      ) : null}
    </View>
  );
}

function StepRow({
  step,
  index,
  first,
  onOpen,
}: {
  step: BatteryStep;
  index: number;
  first: boolean;
  onOpen: (surveyId: string) => void;
}) {
  const c = useColors();
  const dark = useIsDark();
  const { ut } = useLang();
  // методику клинициста обследуемый открыть не может ни в каком состоянии
  const byClinician = step.administration === "clinician";
  const openable = !byClinician && (step.state === "current" || step.state === "available");
  const current = !byClinician && step.state === "current";
  const fill = dark ? c.vink : c.v;

  const sub = [
    byClinician && step.state !== "done" && step.state !== "retired" ? ut("battery.step.clinician") : ut(STEP_KEY[step.state]),
    step.required ? null : ut("battery.step.optional"),
    // медиана — в целых минутах и не меньше одной: «0.6 хв» человеку ничего не говорит
    step.medianMinutes !== null && step.state !== "done"
      ? `${ut("battery.step.usually")} ${Math.max(1, Math.round(step.medianMinutes))} ${ut("battery.minutes")}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  const mark = (() => {
    const base = { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" } as const;
    if (step.state === "done")
      return (
        <View style={[base, { backgroundColor: c.goodtint }]}>
          <Icon name="check" size={16} strokeWidth={3} color={c.good} />
        </View>
      );
    if (step.state === "retired")
      return (
        <View style={[base, { backgroundColor: c.sunk }]}>
          <Icon name="archive" size={14} color={c.muted} />
        </View>
      );
    if (byClinician)
      return (
        <View style={[base, { backgroundColor: c.sunk, borderWidth: 1, borderColor: c.border }]}>
          <Icon name="user-round" size={15} color={c.text2} />
        </View>
      );
    const num = (
      <T v="sub" size={14} weight={800} num scale={false} color={current ? (dark ? c.ground : c.onfill) : openable ? c.vink : c.muted}>
        {index + 1}
      </T>
    );
    if (current) return <View style={[base, { backgroundColor: fill }]}>{num}</View>;
    if (openable) return <View style={[base, { borderWidth: 2, borderColor: fill }]}>{num}</View>;
    return <View style={[base, { borderWidth: 2, borderStyle: "dashed", borderColor: c.ctl }]}>{num}</View>;
  })();

  const row = (pressed: boolean) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 64,
        paddingVertical: 10,
        paddingLeft: 16,
        paddingRight: 12,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: c.divider,
        backgroundColor: current ? (pressed ? c.vtint2 : c.vtint) : pressed ? c.panel2 : "transparent",
      }}
    >
      {mark}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T
          v="headline"
          weight={current ? 800 : 700}
          color={step.state === "retired" ? c.muted : current ? c.vink : step.state === "locked" || byClinician ? c.text2 : c.text}
          style={step.state === "retired" ? { textDecorationLine: "line-through" } : undefined}
        >
          {step.title}
        </T>
        <T v="sub" tone={current ? "text2" : "muted"}>
          {sub}
        </T>
      </View>
      <View style={{ width: 24, alignItems: "center" }}>
        {openable ? <Icon name="chevron-right" size={20} color={c.muted} /> : step.state === "locked" && !byClinician ? <Icon name="lock" size={17} color={c.muted} /> : null}
      </View>
    </View>
  );

  if (!openable) return <View accessible accessibilityLabel={`${step.title}. ${sub}`} accessibilityState={{ disabled: true }}>{row(false)}</View>;
  return (
    <Pressable onPress={() => onOpen(step.surveyId)} accessibilityRole="button" accessibilityLabel={`${step.title}. ${sub}`}>
      {({ pressed }) => row(pressed)}
    </Pressable>
  );
}

const STEP_KEY = {
  done: "battery.step.done",
  current: "mpt.sv.stepNext",
  available: "battery.step.available",
  locked: "battery.step.locked",
  // методику шага сняли с использования или с публикации: пройти нельзя, и её не ждут
  retired: "mark.retired",
} as const;

/**
 * Каталог сотрудника — по группам консоли: здесь он выбирает методику,
 * чтобы заполнить её за пациента в обходе. Методика без группы — в конце.
 */
function StaffCatalog({
  surveys,
  groups,
  onOpen,
}: {
  surveys: SurveyListItem[];
  groups: SurveyGroupWithCounts[];
  onOpen: (id: string) => void;
}) {
  const { ut } = useLang();
  const known = new Set(groups.map((g) => g.id));
  const sections = [
    ...groups.map((g) => ({ key: g.id, title: g.title, color: g.color, items: surveys.filter((s) => s.groupId === g.id) })),
    { key: "ungrouped", title: ut("surveys.noGroup"), color: null, items: surveys.filter((s) => !s.groupId || !known.has(s.groupId)) },
  ].filter((s) => s.items.length > 0);

  if (sections.length === 0) return <EmptyNote icon="clipboard-list" text={ut("surveys.emptyAdmin")} />;
  return (
    <>
      {sections.map((section) => (
        <View key={section.key}>
          <SectionHead
            title={section.title}
            right={section.color ? <View style={{ width: 12, height: 12, borderRadius: 4, backgroundColor: section.color }} /> : undefined}
          />
          <List>
            {section.items.map((s, i) => {
              const { name, code } = codeOf(s.title);
              return (
                <ListRow
                  key={s.id}
                  first={i === 0}
                  title={name}
                  sub={[code, `${s.questionCount} ${ut("surveys.questions")}`].filter(Boolean).join(", ")}
                  lead={<CodeTile code={code} />}
                  chevron
                  onPress={() => onOpen(s.id)}
                  chips={s.status !== "published" ? <Pill kind="n" label={ut(s.status === "draft" ? "mpt.sv.statusDraft" : "mpt.sv.statusClosed")} /> : undefined}
                />
              );
            })}
          </List>
        </View>
      ))}
    </>
  );
}
