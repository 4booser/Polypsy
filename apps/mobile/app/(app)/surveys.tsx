import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { BatteryAssignment, BatteryStep, SurveyGroupWithCounts, SurveyListItem } from "@quizzy/shared";
import { api } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { Body, Card, Chip, Empty, ErrorText, Loader, Row, Title } from "@/components/ui";
import { severityColor, spacing, useColors } from "@/theme";
import { useLang } from "@/lang";
import { ensurePushRegistered } from "@/push";

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
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  /*
   * Режим обхода: специалист заполняет методику за пациента. Идентификатор
   * приходит из карты обхода и передаётся дальше в прохождение — экран сам
   * ничего про пациента не знает, кроме того, что он есть.
   */
  const { onBehalfOf } = useLocalSearchParams<{ onBehalfOf?: string }>();
  const forPatient = onBehalfOf ? `?onBehalfOf=${onBehalfOf}` : "";

  const load = useCallback(async () => {
    try {
      setError(null);
      const [g, s, b] = await Promise.all([
        api.listGroups(),
        api.listSurveys(),
        // батареи не критичны для экрана: если они не поднялись, список
        // методик всё равно должен открыться
        api.myBatteries().catch(() => [] as BatteryAssignment[]),
      ]);
      setGroups(g);
      setSurveys(s);
      setBatteries(b.filter((x) => !x.completedAt && x.doneRequired < x.totalRequired));
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("surveys.loadFailed"));
      setSurveys([]);
    }
  }, [ut]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (surveys === null) return <Loader />;

  // методики, уже показанные в батарее, из общего списка убираем: иначе одна
  // и та же карточка встречается дважды и порядок прохождения теряется
  const inBattery = new Set(batteries.flatMap((b) => b.steps.map((s) => s.surveyId)));
  const loose = surveys.filter((s) => !inBattery.has(s.id));

  /*
   * Назначенное отделяется от общедоступного, и порядок именно такой.
   *
   * Общедоступную методику человек проходит, если захочет; назначенную от
   * него ждут, и у неё есть срок. Одним списком без различия не видно ни
   * того ни другого: назначенное теряется среди доступного, а доступное
   * выглядит обязательным — и человек либо не проходит нужное, либо проходит
   * лишнее, считая, что должен.
   *
   * Для сотрудника разделения нет: он смотрит каталог, а не свой список дел,
   * и «назначено вам» у него означало бы не то.
   */
  const assigned = isAdmin ? [] : loose.filter((s) => s.assigned && !s.completedByMe);
  const assignedIds = new Set(assigned.map((s) => s.id));
  const rest = loose.filter((s) => !assignedIds.has(s.id));
  const ungrouped = rest.filter((s) => !s.groupId);
  const sections = [
    ...groups.map((g) => ({ group: g, items: rest.filter((s) => s.groupId === g.id) })),
    ...(ungrouped.length ? [{ group: null, items: ungrouped }] : []),
  ].filter((s) => s.items.length > 0);

  return (
    <ScrollView
      style={{ backgroundColor: c.bg }}
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
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
      <Title>{ut("surveys.title")}</Title>
      <ErrorText>{error}</ErrorText>

      {batteries.map((b) => (
        <BatteryCard key={b.id} assignment={b} onOpen={(id) => router.push(`/survey/${id}${forPatient}`)} />
      ))}

      {/*
        Назначенное — первым разделом и со сроком. Срок стоит на карточке, а
        не в подписи раздела: сроки у назначений разные, и один общий
        заголовок «до такого-то» врал бы про половину из них.
      */}
      {assigned.length ? (
        <View style={{ gap: spacing.md }}>
          <Text style={{ color: c.text, fontSize: 15, fontWeight: "600" }}>
            {ut("sv.assigned")}
          </Text>
          {assigned.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => router.push(`/survey/${item.id}${forPatient}`)}
              accessibilityRole="button"
              accessibilityLabel={`${item.title}. ${ut("sv.assigned")}`}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
              <Card>
                <Body>{item.title}</Body>
                <Row gap={spacing.md}>
                  <Text style={{ color: c.muted, fontSize: 12 }}>
                    {item.questionCount} {ut("surveys.questions")}
                  </Text>
                  {item.timeLimitSec ? (
                    <Text style={{ color: c.muted, fontSize: 12 }}>
                      ~{Math.round(item.timeLimitSec / 60)} {ut("sv.minutes")}
                    </Text>
                  ) : null}
                  {item.dueAt ? (
                    <Text
                      style={{
                        color: new Date(item.dueAt) < new Date() ? c.danger : c.muted,
                        fontSize: 12,
                      }}
                    >
                      {new Date(item.dueAt) < new Date()
                        ? ut("sv.overdue")
                        : `${ut("sv.due")} ${new Date(item.dueAt).toLocaleDateString()}`}
                    </Text>
                  ) : null}
                </Row>
              </Card>
            </Pressable>
          ))}
        </View>
      ) : null}

      {sections.length === 0 && batteries.length === 0 && !error ? (
        <Empty
          text={
            isAdmin
              ? ut("surveys.emptyAdmin")
              : ut("surveys.empty")
          }
        />
      ) : null}

      {sections.map(({ group, items }) => (
        <View key={group?.id ?? "ungrouped"} style={{ gap: spacing.md }}>
          <View style={{ gap: 2 }}>
            <Row>
              {group?.color ? (
                <View
                  style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: group.color }}
                />
              ) : null}
              <Text style={{ color: c.text, fontSize: 17, fontWeight: "700" }}>
                {group?.title ?? ut("surveys.noGroup")}
              </Text>
            </Row>
            {group?.description ? <Body muted>{group.description}</Body> : null}
          </View>

          {items.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => router.push(`/survey/${item.id}${forPatient}`)}
              accessibilityRole="button"
              // карточка целиком — одна кнопка; иначе диктор читает название,
              // счётчик вопросов и метку «пройдено» как три несвязанных куска
              accessibilityLabel={`${item.title}. ${item.questionCount} ${ut("surveys.questions")}${
                item.completedByMe ? `. ${ut("surveys.completed")}` : ""
              }`}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
              <Card>
                <Row>
                  <Body>{item.title}</Body>
                  <View style={{ flex: 1 }} />
                  {item.completedByMe ? <Chip label={ut("surveys.completed")} /> : null}
                </Row>
                {item.description ? <Body muted>{item.description}</Body> : null}
                <Row gap={spacing.md}>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{item.questionCount} {ut("surveys.questions")}</Text>
                  {item.timeLimitSec ? (
                    <Text style={{ color: c.muted, fontSize: 12 }}>
                      ~{Math.round(item.timeLimitSec / 60)} мин
                    </Text>
                  ) : null}
                  {isAdmin && item.status !== "published" ? <Chip label={item.status} /> : null}
                </Row>
              </Card>
            </Pressable>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

/**
 * Батарея на экране обследуемого.
 *
 * Порядок здесь не подсказка, а правило: при строгом порядке следующая
 * методика открывается только после предыдущей, поэтому недоступные шаги
 * показаны, но не нажимаются — иначе человек упирается в отказ без объяснения.
 */
function BatteryCard({
  assignment,
  onOpen,
}: {
  assignment: BatteryAssignment;
  onOpen: (surveyId: string) => void;
}) {
  const c = useColors();
  const { ut, lang } = useLang();
  const overdue = assignment.overdue;
  // в наборе есть часть специалиста: она идёт параллельно и не мешает
  // проходить свои методики, но человек должен знать, что батарея не
  // закроется, пока психолог не внесёт свою часть
  const waiting = assignment.steps.find(
    (s) => s.state !== "done" && s.administration === "clinician" && s.required,
  );

  return (
    <Card style={overdue ? { borderColor: c.danger } : undefined}>
      <Row>
        <Text style={{ color: c.text, fontSize: 16, fontWeight: "700", flex: 1 }}>
          {assignment.batteryTitle}
        </Text>
        <Chip label={`${assignment.doneRequired} ${ut("battery.progressOf")} ${assignment.totalRequired}`} />
      </Row>

      <Body muted>
        {overdue
          ? ut("battery.overdue")
          : assignment.dueAt
            ? `${ut("battery.dueBy")} ${formatDay(assignment.dueAt, lang)}`
            : ut("battery.noDue")}
      </Body>

      {waiting ? (
        <Body muted>
          «{waiting.title}» {ut("battery.clinicianNote")}
        </Body>
      ) : null}

      <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
        {assignment.steps.map((step, i) => (
          <StepRow key={step.surveyId} step={step} index={i} onOpen={onOpen} />
        ))}
      </View>
    </Card>
  );
}

function StepRow({
  step,
  index,
  onOpen,
}: {
  step: BatteryStep;
  index: number;
  onOpen: (surveyId: string) => void;
}) {
  const c = useColors();
  const { ut } = useLang();
  // методику клинициста обследуемый открыть не может ни в каком состоянии
  const byClinician = step.administration === "clinician";
  const openable = !byClinician && (step.state === "current" || step.state === "available");
  const done = severityColor.none;
  const tone = step.state === "done" ? done : openable ? c.primary : c.muted;

  const row = (
    <Row gap={spacing.md}>
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: step.state === "done" ? done : "transparent",
          borderWidth: step.state === "done" ? 0 : 1,
          borderColor: tone,
          borderStyle: step.state === "locked" ? "dashed" : "solid",
        }}
      >
        <Text style={{ color: step.state === "done" ? c.bg : tone, fontSize: 12, fontWeight: "700" }}>
          {step.state === "done" ? "✓" : String(index + 1)}
        </Text>
      </View>

      <View style={{ flex: 1 }}>
        <Text
          style={{
            color: step.state === "locked" ? c.muted : c.text,
            fontSize: 14,
            fontWeight: openable ? "600" : "400",
          }}
        >
          {step.title}
        </Text>
        <Text style={{ color: c.muted, fontSize: 12 }}>
          {byClinician && step.state !== "done" ? ut("battery.step.clinician") : ut(STEP_KEY[step.state])}
          {step.required ? "" : ` · ${ut("battery.step.optional")}`}
          {step.medianMinutes !== null ? ` · ${ut("battery.step.usually")} ${step.medianMinutes} ${ut("battery.minutes")}` : ""}
        </Text>
      </View>
    </Row>
  );

  if (!openable)
    return <View style={{ opacity: step.state === "locked" ? 0.55 : 1 }}>{row}</View>;
  return (
    <Pressable
      onPress={() => onOpen(step.surveyId)}
      accessibilityRole="button"
      accessibilityLabel={`${step.title}. ${ut(STEP_KEY[step.state])}`}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {row}
    </Pressable>
  );
}

const STEP_KEY = {
  done: "battery.step.done",
  current: "battery.step.current",
  available: "battery.step.available",
  locked: "battery.step.locked",
} as const;

function formatDay(iso: string | null, lang: "uk" | "ru"): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(lang === "uk" ? "uk-UA" : "ru-RU", {
    day: "numeric",
    month: "long",
  });
}
