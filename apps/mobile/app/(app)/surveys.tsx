import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { BatteryAssignment, BatteryStep, SurveyGroupWithCounts, SurveyListItem } from "@quizzy/shared";
import { api } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { Body, Card, Chip, Empty, ErrorText, Loader, Row, Title } from "@/components/ui";
import { severityColor, spacing, useColors } from "@/theme";

export default function SurveysScreen() {
  const c = useColors();
  const router = useRouter();
  const { isAdmin } = useAuth();

  const [groups, setGroups] = useState<SurveyGroupWithCounts[]>([]);
  const [surveys, setSurveys] = useState<SurveyListItem[] | null>(null);
  const [batteries, setBatteries] = useState<BatteryAssignment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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
      setError(e instanceof Error ? e.message : "Не удалось загрузить методики");
      setSurveys([]);
    }
  }, []);

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
  const ungrouped = loose.filter((s) => !s.groupId);
  const sections = [
    ...groups.map((g) => ({ group: g, items: loose.filter((s) => s.groupId === g.id) })),
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
      <Title>Методики</Title>
      <ErrorText>{error}</ErrorText>

      {batteries.map((b) => (
        <BatteryCard key={b.id} assignment={b} onOpen={(id) => router.push(`/survey/${id}`)} />
      ))}

      {sections.length === 0 && batteries.length === 0 && !error ? (
        <Empty
          text={
            isAdmin
              ? "Методик пока нет. Создайте первую во вкладке «Конструктор»."
              : "Доступных методик пока нет. Загляните позже."
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
                {group?.title ?? "Без группы"}
              </Text>
            </Row>
            {group?.description ? <Body muted>{group.description}</Body> : null}
          </View>

          {items.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => router.push(`/survey/${item.id}`)}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
              <Card>
                <Row>
                  <Body>{item.title}</Body>
                  <View style={{ flex: 1 }} />
                  {item.completedByMe ? <Chip label="Пройдена" /> : null}
                </Row>
                {item.description ? <Body muted>{item.description}</Body> : null}
                <Row gap={spacing.md}>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{item.questionCount} вопросов</Text>
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
        <Chip label={`${assignment.doneRequired} из ${assignment.totalRequired}`} />
      </Row>

      <Body muted>
        {overdue
          ? `Срок прошёл ${formatDay(assignment.dueAt)} — пройдите, пожалуйста, в ближайшее время`
          : assignment.dueAt
            ? `Пройти до ${formatDay(assignment.dueAt)}`
            : "Без срока"}
      </Body>

      {waiting ? (
        <Body muted>
          «{waiting.title}» заполняет специалист отдельно — ваши методики доступны, проходите
          их в своём порядке.
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
          {byClinician && step.state !== "done" ? "заполняет специалист" : STEP_HINT[step.state]}
          {step.required ? "" : " · можно пропустить"}
          {step.medianMinutes !== null ? ` · обычно ${step.medianMinutes} мин` : ""}
        </Text>
      </View>
    </Row>
  );

  if (!openable)
    return <View style={{ opacity: step.state === "locked" ? 0.55 : 1 }}>{row}</View>;
  return (
    <Pressable
      onPress={() => onOpen(step.surveyId)}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {row}
    </Pressable>
  );
}

const STEP_HINT: Record<BatteryStep["state"], string> = {
  done: "пройдена",
  current: "следующая — нажмите, чтобы начать",
  available: "доступна",
  locked: "откроется после предыдущей",
};

function formatDay(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}
