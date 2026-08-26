import { useCallback, useState } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import type { RespondentDynamics } from "@quizzy/shared";
import { api } from "@/api/client";
import { ChartCard, SeverityTag } from "@/components/charts";
import { PercentileBar } from "@/components/charts-extra";
import { LineChart, RadarChart } from "@/components/viz";
import { Body, Button, Card, Divider, Empty, ErrorText, Loader, Row, Title } from "@/components/ui";
import { spacing, useColors } from "@/theme";

/** Динамика одного пациента: как менялись баллы от замера к замеру */
export default function PatientDynamicsScreen() {
  const c = useColors();
  const navigation = useNavigation();
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const [data, setData] = useState<RespondentDynamics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const d = await api.respondentDynamics(userId);
      setData(d);
      navigation.setOptions({ title: d.fullName });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить динамику");
    }
  }, [userId, navigation]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loader />;

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      <View>
        <Title>{data.fullName}</Title>
        <Body muted>{data.email}</Body>
      </View>

      {data.surveys.length === 0 ? <Empty text="Завершённых прохождений нет" /> : null}

      {data.surveys.map((sv) => (
        <View key={sv.surveyId} style={{ gap: spacing.md }}>
          <Card>
            <Body>{sv.title}</Body>
            <Body muted>
              {sv.responseCount} замеров
              {sv.firstAt ? ` · с ${sv.firstAt.slice(0, 10)}` : ""}
              {sv.lastAt ? ` по ${sv.lastAt.slice(0, 10)}` : ""}
            </Body>
          </Card>

          {/* профиль целиком: в психодиагностике важна форма, а не отдельная шкала */}
          {sv.scales.length >= 3 ? (
            <ChartCard
              title="Профиль по субшкалам"
              subtitle="Последний замер против первого"
            >
              <RadarChart
                labels={["Последний замер", "Первый замер"]}
                axes={sv.scales.map((sc) => {
                  const p = sc.points[sc.points.length - 1];
                  return {
                    label: sc.title,
                    value: p && p.maxScore > 0 ? p.rawScore / p.maxScore : 0,
                    raw: p?.rawScore ?? 0,
                  };
                })}
                compare={
                  sv.scales.some((sc) => sc.points.length > 1)
                    ? sv.scales.map((sc) => {
                        const p = sc.points[0];
                        return {
                          label: sc.title,
                          value: p && p.maxScore > 0 ? p.rawScore / p.maxScore : 0,
                          raw: p?.rawScore ?? 0,
                        };
                      })
                    : undefined
                }
              />
            </ChartCard>
          ) : null}

          {sv.scales.map((sc) => {
            const last = sc.points[sc.points.length - 1];
            return (
              <ChartCard
                key={sc.scaleId}
                title={sc.title}
                subtitle={
                  sc.delta === null
                    ? "нужен минимум второй замер, чтобы говорить о динамике"
                    : `изменение за период: ${sc.delta > 0 ? "+" : ""}${sc.delta}`
                }
              >
                <LineChart
                  height={190}
                  yMax={last?.maxScore ?? undefined}
                  series={[
                    {
                      label: sc.title,
                      points: sc.points.map((pt) => ({
                        x: pt.submittedAt.slice(5, 10),
                        y: pt.rawScore,
                        tone: pt.severity ?? undefined,
                      })),
                    },
                  ]}
                />

                {last ? (
                  <View style={{ gap: spacing.sm, marginTop: spacing.lg }}>
                    <Divider />
                    <Row>
                      <Body muted>Последний замер</Body>
                      <View style={{ flex: 1 }} />
                      <Text style={{ color: c.text, fontVariant: ["tabular-nums"] }}>
                        {last.rawScore} из {last.maxScore}
                      </Text>
                    </Row>
                    {last.severity ? (
                      <SeverityTag severity={last.severity} label={last.bandLabel ?? undefined} />
                    ) : null}
                    {last.percentile !== null ? (
                      <PercentileBar percentile={last.percentile} />
                    ) : (
                      <Body muted>
                        Перцентиль не считается: накопленная выборка слишком мала, чтобы он что-то
                        значил
                      </Body>
                    )}
                    <Button
                      title="Заключение по последнему замеру"
                      variant="secondary"
                      onPress={() => Linking.openURL(api.reportUrl(last.responseId))}
                    />
                  </View>
                ) : null}
              </ChartCard>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}
