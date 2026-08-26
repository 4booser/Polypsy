import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import type { QuestionAnalytics, SurveyAnalytics } from "@quizzy/shared";
import { api } from "@/api/client";
import { BarList, ChartCard, Histogram, SeverityBar, StatTile } from "@/components/charts";
import {
  BoxPlot,
  DivergingBar,
  Donut,
  Funnel,
  Heatmap,
  LineChart,
  Scatter,
  boxStatsOf,
} from "@/components/viz";
import { Body, Button, Card, Chip, Divider, ErrorText, Loader, Row, Segmented } from "@/components/ui";
import { formatDuration, severityColor, spacing, useColors } from "@/theme";

type Tab = "overview" | "questions" | "scales" | "quality";

export default function SurveyAnalyticsScreen() {
  const c = useColors();
  const router = useRouter();
  const navigation = useNavigation();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [data, setData] = useState<SurveyAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [versionId, setVersionId] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const a = await api.surveyAnalytics(id, versionId);
      setData(a);
      navigation.setOptions({ title: a.title });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить аналитику");
    }
  }, [id, navigation, versionId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loader />;

  // тепловая карта строится только по вопросам с одинаковым набором вариантов:
  // иначе столбцы означали бы разное в разных строках
  const withOptions = data.questions.filter((q) => (q.options?.length ?? 0) > 0);
  const columnKey = (q: (typeof withOptions)[number]) =>
    (q.options ?? []).map((o) => o.text).join("|");
  const dominant = withOptions.reduce<Record<string, number>>((acc, q) => {
    acc[columnKey(q)] = (acc[columnKey(q)] ?? 0) + 1;
    return acc;
  }, {});
  const bestKey = Object.entries(dominant).sort((a, b) => b[1] - a[1])[0]?.[0];
  const heatQuestions = withOptions.filter((q) => columnKey(q) === bestKey && (dominant[bestKey] ?? 0) > 1);
  const heatColumns = heatQuestions[0]?.options?.map((o) => o.text) ?? [];
  const heatRows = heatQuestions.map((q) => ({
    label: `${q.position + 1}. ${q.title}`,
    cells: (q.options ?? []).map((o) => ({ label: o.text, value: o.percent })),
  }));

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      {/* переключатель версий: после правки методики данные остаются на прежней,
          и надо явно показывать, какую редакцию мы сейчас смотрим */}
      {data.versions.length > 1 ? (
        <Card>
          <Body muted>Версия методики</Body>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
            {data.versions.map((v) => (
              <Chip
                key={v.id}
                label={`v${v.version} · ${v.responseCount}`}
                selected={v.id === data.versionId}
                onPress={() => setVersionId(v.id)}
              />
            ))}
          </View>
          <Body muted>
            Срезы посчитаны по версии {data.versionNumber}. Прохождения разных версий не
            смешиваются — вопросы у них разные.
          </Body>
        </Card>
      ) : null}

      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: "overview", label: "Общее" },
          { value: "questions", label: "Вопросы" },
          { value: "scales", label: "Шкалы" },
          { value: "quality", label: `Качество${data.quality.length ? " " + data.quality.length : ""}` },
        ]}
      />

      {tab === "overview" ? (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
            <StatTile
              label="Завершено"
              value={String(data.completed)}
              hint={`начато ${data.started}`}
            />
            <StatTile label="Доходимость" value={`${data.completionRate}%`} hint={`брошено ${data.abandoned}`} />
            <StatTile label="Среднее время" value={formatDuration(data.avgDurationMs)} />
            <StatTile label="Медиана" value={formatDuration(data.medianDurationMs)} />
          </View>

          <ChartCard title="Динамика" subtitle="Завершённые прохождения по дням">
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

          <ChartCard title="Доходимость" subtitle="Завершённые против брошенных">
            <Donut
              centerValue={`${data.completionRate}%`}
              centerLabel="дошли до конца"
              slices={[
                { label: "Завершено", value: data.completed, color: severityColor.none },
                { label: "Брошено", value: data.abandoned, color: severityColor.severe },
              ]}
            />
          </ChartCard>

          {data.dropOff.some((d) => d.lost > 0) ? (
            <ChartCard
              title="Где теряются респонденты"
              subtitle="Сколько человек дошло до каждого вопроса"
            >
              <Funnel
                stages={data.dropOff.map((d) => ({
                  label: `${d.position + 1}. ${d.title}`,
                  value: d.reached,
                  lost: d.lost,
                }))}
              />
            </ChartCard>
          ) : null}

          <Button
            title="Список прохождений"
            variant="secondary"
            onPress={() => router.push(`/analytics/${id}/responses`)}
          />
        </>
      ) : null}

      {tab === "questions" ? (
        <View style={{ gap: spacing.lg }}>
          {/* сводные срезы по всем вопросам сразу — прежде чем идти в детали */}
          <ChartCard
            title="Время ответа по вопросам"
            subtitle="Разброс, а не только среднее: две одинаковые средние могут вести себя по-разному"
          >
            <BoxPlot
              boxes={data.questions
                .filter((q) => q.answered > 0)
                .map((q) =>
                  boxStatsOf(`В${q.position + 1}`, [
                    q.minDurationMs / 1000,
                    q.medianDurationMs / 1000,
                    q.avgDurationMs / 1000,
                    q.maxDurationMs / 1000,
                  ]),
                )
                .filter((b): b is NonNullable<typeof b> => b !== null)}
            />
          </ChartCard>

          {heatRows.length > 0 ? (
            <ChartCard
              title="Распределение выборов"
              subtitle="Доля респондентов по каждому варианту, % от ответивших"
            >
              <Heatmap rows={heatRows} columns={heatColumns} />
            </ChartCard>
          ) : null}

          <ChartCard
            title="Сомнения при ответе"
            subtitle="Доля респондентов, менявших ответ — маркер неоднозначной формулировки"
          >
            <BarList
              unit="%"
              items={data.questions.map((q) => ({
                label: `${q.position + 1}. ${q.title}`,
                value: q.changedShare,
              }))}
            />
          </ChartCard>

          {data.questions.map((q) => (
            <QuestionBlock key={q.questionId} q={q} />
          ))}
        </View>
      ) : null}

      {tab === "scales" ? (
        <View style={{ gap: spacing.lg }}>
          {data.scales.length > 1 ? (
            <ChartCard
              title="Сравнение субшкал"
              subtitle="Разброс баллов по каждой шкале в одном масштабе"
            >
              <BoxPlot
                categorical
                boxes={data.scales
                  .map((s) => boxStatsOf(s.code, [s.min, s.average, s.median, s.max]))
                  .filter((b): b is NonNullable<typeof b> => b !== null)}
              />
            </ChartCard>
          ) : null}
          {data.scales.length === 0 ? (
            <Card>
              <Body muted>У методики нет субшкал — подсчёт баллов отключён.</Body>
            </Card>
          ) : (
            data.scales.map((s) => (
              <ChartCard
                key={s.scaleId}
                title={s.title}
                subtitle={`среднее ${s.average} · медиана ${s.median} · диапазон ${s.min}–${s.max} из ${s.maxPossible}`}
              >
                <SeverityBar bands={s.bands} />
                {s.reliability ? (
                  <View style={{ marginTop: spacing.lg }}>
                    <Body muted>Связь пункта со своей шкалой</Body>
                    <DivergingBar
                      goodThreshold={0.3}
                      items={s.reliability.items.map((it) => ({
                        label: it.title,
                        value: it.itemTotalCorrelation,
                      }))}
                    />
                  </View>
                ) : null}
                {s.reliability ? <Reliability r={s.reliability} /> : null}
              </ChartCard>
            ))
          )}
        </View>
      ) : null}
      {tab === "quality" ? (
        <View style={{ gap: spacing.lg }}>
          <Card>
            <Body>Признаки небрежного заполнения</Body>
            <Body muted>
              Помечено {data.quality.length} из {data.completed} прохождений. Порог «слишком
              быстро» — {Math.round(data.tooFastThresholdMs / 1000)} с на вопрос. Это флаг для
              проверки специалистом, а не основание автоматически исключать данные.
            </Body>
          </Card>

          {data.quality.length > 0 ? (
            <ChartCard
              title="Время против доли быстрых ответов"
              subtitle="Точки у левого края — прошли методику быстрее, чем её можно прочесть"
            >
              <Scatter
                xLabel="время прохождения, с"
                yLabel="% быстрых"
                xThreshold={(data.questions.length * data.tooFastThresholdMs) / 1000}
                points={data.quality.map((q) => ({
                  x: Math.round(q.durationMs / 1000),
                  y: q.tooFastShare,
                  flagged: q.flagged,
                }))}
              />
            </ChartCard>
          ) : (
            <Card>
              <Body muted>Подозрительных прохождений не найдено</Body>
            </Card>
          )}

          {data.quality.map((q) => (
            <Card key={q.responseId}>
              <Row>
                <Body>{q.respondent ?? "Аноним"}</Body>
                <View style={{ flex: 1 }} />
                <Text style={{ color: c.muted, fontSize: 12 }}>{formatDuration(q.durationMs)}</Text>
              </Row>
              {q.reasons.map((r, i) => (
                <Row key={i}>
                  <View
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 3,
                      backgroundColor: severityColor.severe,
                    }}
                  />
                  <Text style={{ color: c.text, fontSize: 13, flex: 1 }}>{r}</Text>
                </Row>
              ))}
              <Row gap={spacing.md}>
                <Text style={{ color: c.muted, fontSize: 12 }}>
                  быстрых ответов {q.tooFastShare}%
                </Text>
                {q.longestStraightLine > 1 ? (
                  <Text style={{ color: c.muted, fontSize: 12 }}>
                    серия одинаковых: {q.longestStraightLine}
                  </Text>
                ) : null}
              </Row>
            </Card>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

/** Надёжность субшкалы: альфа и вклад каждого пункта */
function Reliability({ r }: { r: NonNullable<SurveyAnalytics["scales"][number]["reliability"]> }) {
  const c = useColors();
  const verdict =
    r.alpha >= 0.9
      ? "очень высокая"
      : r.alpha >= 0.8
        ? "хорошая"
        : r.alpha >= 0.7
          ? "приемлемая"
          : "низкая";

  return (
    <View style={{ gap: spacing.sm, marginTop: spacing.lg }}>
      <Divider />
      <Row>
        <Body muted>Альфа Кронбаха</Body>
        <View style={{ flex: 1 }} />
        <Text style={{ color: c.text, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
          {r.alpha}
        </Text>
        <Text style={{ color: c.muted, fontSize: 12 }}>{verdict}</Text>
      </Row>
      <Body muted>
        Внутренняя согласованность по {r.itemCount} пунктам: насколько они измеряют одно и то же.
      </Body>
      {r.items.map((it) => {
        const weak = it.itemTotalCorrelation < 0.3;
        const harmful = it.alphaIfDeleted !== null && it.alphaIfDeleted > r.alpha;
        return (
          <View key={it.questionId} style={{ gap: 2, marginTop: spacing.sm }}>
            <Text style={{ color: c.text, fontSize: 13 }} numberOfLines={2}>
              {it.title}
            </Text>
            <Row gap={spacing.md}>
              <Text
                style={{
                  color: weak ? c.danger : c.muted,
                  fontSize: 12,
                  fontVariant: ["tabular-nums"],
                }}
              >
                связь с остальными {it.itemTotalCorrelation}
              </Text>
              <Text style={{ color: c.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
                α без него {it.alphaIfDeleted ?? "—"}
              </Text>
            </Row>
            {harmful ? (
              <Text style={{ color: c.danger, fontSize: 12 }}>
                без этого пункта шкала становится согласованнее — стоит пересмотреть формулировку
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function QuestionBlock({ q }: { q: QuestionAnalytics }) {
  const c = useColors();
  return (
    <Card>
      <Text style={{ color: c.text, fontSize: 15, fontWeight: "600" }}>
        {q.position + 1}. {q.title}
      </Text>
      <Row gap={spacing.md}>
        <Text style={{ color: c.muted, fontSize: 12 }}>{q.type}</Text>
        <Text style={{ color: c.muted, fontSize: 12 }}>ответов {q.answered}</Text>
        {q.skipped > 0 ? (
          <Text style={{ color: c.muted, fontSize: 12 }}>пропусков {q.skipRate}%</Text>
        ) : null}
      </Row>

      <Divider />

      {/* время на вопрос — то, ради чего эта таблица и нужна */}
      <View style={{ gap: spacing.xs, marginVertical: spacing.sm }}>
        <Row>
          <Body muted>Среднее время</Body>
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.text, fontVariant: ["tabular-nums"] }}>
            {formatDuration(q.avgDurationMs)}
          </Text>
        </Row>
        <Row>
          <Body muted>Медиана</Body>
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.text, fontVariant: ["tabular-nums"] }}>
            {formatDuration(q.medianDurationMs)}
          </Text>
        </Row>
        <Row>
          <Body muted>Разброс</Body>
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.text, fontVariant: ["tabular-nums"] }}>
            {formatDuration(q.minDurationMs)} — {formatDuration(q.maxDurationMs)}
          </Text>
        </Row>
        <Row>
          <Body muted>Думал до первого выбора</Body>
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.text, fontVariant: ["tabular-nums"] }}>
            {formatDuration(q.avgTimeToFirstAnswerMs)}
          </Text>
        </Row>
        <Row>
          <Body muted>Смен ответа в среднем</Body>
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.text, fontVariant: ["tabular-nums"] }}>{q.avgChangeCount}</Text>
        </Row>
        <Row>
          <Body muted>Меняли ответ</Body>
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.text, fontVariant: ["tabular-nums"] }}>{q.changedShare}%</Text>
        </Row>
        {q.tooFastShare > 0 ? (
          <Row>
            <Body muted>Отвечено слишком быстро</Body>
            <View style={{ flex: 1 }} />
            <Text style={{ color: c.danger, fontVariant: ["tabular-nums"] }}>{q.tooFastShare}%</Text>
          </Row>
        ) : null}
      </View>

      {q.options?.length ? (
        <View style={{ marginTop: spacing.sm }}>
          <BarList
            items={q.options.map((o) => ({
              label: o.text,
              value: o.count,
              caption: o.avgRank !== undefined ? `ранг ${o.avgRank}` : `${o.percent}%`,
            }))}
          />
        </View>
      ) : null}

      {q.numeric ? (
        <View style={{ marginTop: spacing.sm, gap: spacing.sm }}>
          <Body muted>
            среднее {q.numeric.average} · медиана {q.numeric.median} · диапазон {q.numeric.min}–
            {q.numeric.max}
          </Body>
          <Histogram data={q.numeric.distribution} />
        </View>
      ) : null}

      {q.texts?.length ? (
        <View style={{ marginTop: spacing.sm, gap: spacing.xs }}>
          <Body muted>Свободные ответы ({q.texts.length})</Body>
          {q.texts.slice(0, 8).map((t, i) => (
            <Text key={i} style={{ color: c.text, fontSize: 14 }}>
              — {t}
            </Text>
          ))}
        </View>
      ) : null}
    </Card>
  );
}
