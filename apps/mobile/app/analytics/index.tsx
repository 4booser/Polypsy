import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { OverviewAnalytics, RiskAlert, SurveyListItem } from "@quizzy/shared";
import { api } from "@/api/client";
import { ChartCard, StatTile } from "@/components/charts";
import { Donut, LineChart } from "@/components/viz";
import { Body, Button, Card, Empty, ErrorText, Loader, Row, Title } from "@/components/ui";
import { formatDuration, severityColor, severityLabel, spacing, useColors } from "@/theme";

export default function OverviewScreen() {
  const c = useColors();
  const router = useRouter();
  const [data, setData] = useState<OverviewAnalytics | null>(null);
  const [surveys, setSurveys] = useState<SurveyListItem[]>([]);
  const [alerts, setAlerts] = useState<RiskAlert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [overview, list, open] = await Promise.all([
        api.overview(),
        api.listSurveys(),
        api.alerts(),
      ]);
      setData(overview);
      setSurveys(list);
      setAlerts(open);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить аналитику");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!data) return error ? <ErrorText>{error}</ErrorText> : <Loader />;

  return (
    <ScrollView
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
      <Title>Сводка</Title>

      {/* тревоги — первое, что должен увидеть специалист */}
      {alerts.length > 0 ? (
        <Pressable onPress={() => router.push("/analytics/alerts")} accessibilityRole="button" accessibilityLabel="Открытые тревоги">
          <Card>
            <Row>
              <View
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 3,
                  backgroundColor: severityColor.severe,
                }}
              />
              <Body>Неразобранных тревог: {alerts.length}</Body>
              <View style={{ flex: 1 }} />
              <Text style={{ color: c.muted, fontSize: 18 }}>›</Text>
            </Row>
            <Body muted>{alerts[0]!.label}</Body>
          </Card>
        </Pressable>
      ) : null}

      <Row gap={spacing.md}>
        <View style={{ flex: 1 }}>
          <Button title="Пациенты" variant="secondary" onPress={() => router.push("/analytics/patients")} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Тревоги" variant="secondary" onPress={() => router.push("/analytics/alerts")} />
        </View>
      </Row>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
        <StatTile
          label="Прохождений"
          value={String(data.responseCount)}
          hint={`доходимость ${data.completionRate}%`}
        />
        <StatTile label="Респондентов" value={String(data.respondentCount)} />
        <StatTile
          label="Методик"
          value={String(data.surveyCount)}
          hint={`опубликовано ${data.publishedCount}`}
        />
        <StatTile label="Среднее время" value={formatDuration(data.avgDurationMs)} />
      </View>

      <ChartCard title="Динамика прохождений" subtitle="Завершённые прохождения по дням">
        <LineChart
          showArea
          height={170}
          series={[
            {
              label: "Прохождений",
              points: data.timeline.map((t) => ({ x: t.date.slice(5), y: t.count })),
            },
          ]}
        />
      </ChartCard>

      {data.severityBreakdown.length ? (
        <ChartCard
          title="Выраженность по всем шкалам"
          subtitle="Сколько результатов попало в каждую категорию норм"
        >
          <Donut
            centerValue={String(data.severityBreakdown.reduce((sum, s) => sum + s.count, 0))}
            centerLabel="результатов"
            slices={data.severityBreakdown.map((s) => ({
              label: severityLabel[s.severity],
              value: s.count,
              color: severityColor[s.severity],
            }))}
          />
        </ChartCard>
      ) : null}

      <Card>
        <Body>Все методики</Body>
        <Body muted>Выберите методику, чтобы открыть срезы</Body>
        {surveys.map((s) => (
          <Pressable
            key={s.id}
            onPress={() => router.push(`/analytics/${s.id}`)}
            accessibilityRole="button"
            accessibilityLabel={s.title}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingVertical: spacing.sm })}
          >
            <Row>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.text, fontSize: 15 }} numberOfLines={2}>
                  {s.title}
                </Text>
                <Text style={{ color: c.muted, fontSize: 12 }}>
                  {s.questionCount} вопросов · {s.responseCount} прохождений · {s.status}
                </Text>
              </View>
              <Text style={{ color: c.muted, fontSize: 18 }}>›</Text>
            </Row>
          </Pressable>
        ))}
      </Card>

      <Card>
        <Body>Методики по числу прохождений</Body>
        {data.topSurveys.length === 0 ? (
          <Body muted>Прохождений пока нет</Body>
        ) : (
          data.topSurveys.map((s) => (
            <Pressable
              key={s.surveyId}
              onPress={() => router.push(`/analytics/${s.surveyId}`)}
              accessibilityRole="button"
              accessibilityLabel={s.title}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingVertical: spacing.sm })}
            >
              <Row>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.text, fontSize: 15 }} numberOfLines={2}>
                    {s.title}
                  </Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>
                    среднее время {formatDuration(s.avgDurationMs)}
                  </Text>
                </View>
                <Text
                  style={{ color: c.text, fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] }}
                >
                  {s.responseCount}
                </Text>
              </Row>
            </Pressable>
          ))
        )}
      </Card>

      {error ? <Empty text={error} /> : null}
    </ScrollView>
  );
}
