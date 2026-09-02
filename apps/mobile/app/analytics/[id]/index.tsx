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
import { useLang } from "@/lang";

type Tab = "overview" | "questions" | "scales" | "quality";

export default function SurveyAnalyticsScreen() {
  const { ut } = useLang();
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
      setError(e instanceof Error ? e.message : ut("ma.loadFailed"));
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
          <Body muted>{ut("msv.version")}</Body>
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
            {ut("msa.versionNote").replace("{v}", String(data.versionNumber))}
          </Body>
        </Card>
      ) : null}

      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: "overview", label: ut("msv.general") },
          { value: "questions", label: ut("msv.questions") },
          { value: "scales", label: ut("msv.scales") },
          { value: "quality", label: `${ut("msa.quality")}${data.quality.length ? " " + data.quality.length : ""}` },
        ]}
      />

      {tab === "overview" ? (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
            <StatTile
              label={ut("msv.completed")}
              value={String(data.completed)}
              hint={ut("msa.started").replace("{n}", String(data.started))}
            />
            <StatTile label={ut("msv.completion")} value={`${data.completionRate}%`} hint={ut("msa.abandoned").replace("{n}", String(data.abandoned))} />
            <StatTile label={ut("ma.avgTime")} value={formatDuration(data.avgDurationMs)} />
            <StatTile label={ut("msv.median")} value={formatDuration(data.medianDurationMs)} />
          </View>

          <ChartCard title={ut("msv.dynamics")} subtitle={ut("ma.trendHint")}>
            <LineChart
              showArea
              height={170}
              series={[
                {
                  label: ut("ma.responses"),
                  points: data.timeline.map((t) => ({ x: t.date.slice(5), y: t.count })),
                },
              ]}
            />
          </ChartCard>

          <ChartCard title={ut("msv.completion")} subtitle={ut("msv.completedVsAbandoned")}>
            <Donut
              centerValue={`${data.completionRate}%`}
              centerLabel={ut("msa.reachedEnd")}
              slices={[
                { label: ut("msv.completed"), value: data.completed, color: severityColor.none },
                { label: ut("msv.abandoned"), value: data.abandoned, color: severityColor.severe },
              ]}
            />
          </ChartCard>

          {data.dropOff.some((d) => d.lost > 0) ? (
            <ChartCard
              title={ut("msv.dropoff")}
              subtitle={ut("msv.dropoffHint")}
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
            title={ut("msv.responseList")}
            variant="secondary"
            onPress={() => router.push(`/analytics/${id}/responses`)}
          />
        </>
      ) : null}

      {tab === "questions" ? (
        <View style={{ gap: spacing.lg }}>
          {/* сводные срезы по всем вопросам сразу — прежде чем идти в детали */}
          <ChartCard
            title={ut("msv.timePerQuestion")}
            subtitle={ut("msv.timeHint")}
          >
            <BoxPlot
              boxes={data.questions
                .filter((q) => q.answered > 0)
                .map((q) =>
                  boxStatsOf(ut("msa.itemShort").replace("{n}", String(q.position + 1)), [
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
              title={ut("msv.optionSpread")}
              subtitle={ut("msv.optionSpreadHint")}
            >
              <Heatmap rows={heatRows} columns={heatColumns} />
            </ChartCard>
          ) : null}

          <ChartCard
            title={ut("msv.doubts")}
            subtitle={ut("msv.doubtsHint")}
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
              title={ut("msv.subscales")}
              subtitle={ut("msv.subscalesHint")}
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
              <Body muted>{ut("msa.noSubscales")}</Body>
            </Card>
          ) : (
            data.scales.map((s) => (
              <ChartCard
                key={s.scaleId}
                title={s.title}
                subtitle={ut("msa.spread")
                  .replace("{avg}", String(s.average))
                  .replace("{med}", String(s.median))
                  .replace("{min}", String(s.min))
                  .replace("{max}", String(s.max))
                  .replace("{of}", String(s.maxPossible))}
              >
                <SeverityBar bands={s.bands} />
                {s.reliability ? (
                  <View style={{ marginTop: spacing.lg }}>
                    <Body muted>{ut("msv.itemTotal")}</Body>
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
            <Body>{ut("msv.careless")}</Body>
            <Body muted>
              {ut("msa.flaggedNote")
                .replace("{n}", String(data.quality.length))
                .replace("{total}", String(data.completed))
                .replace("{sec}", String(Math.round(data.tooFastThresholdMs / 1000)))}
            </Body>
          </Card>

          {data.quality.length > 0 ? (
            <ChartCard
              title={ut("msv.timeVsFast")}
              subtitle={ut("msv.fastHint")}
            >
              <Scatter
                xLabel={ut("msa.durationAxis")}
                yLabel={ut("msa.fastAxis")}
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
              <Body muted>{ut("msv.noSuspicious")}</Body>
            </Card>
          )}

          {data.quality.map((q) => (
            <Card key={q.responseId}>
              <Row>
                <Body>{q.respondent ?? ut("mrs.anon")}</Body>
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
                  {ut("msa.fastAnswers").replace("{n}", String(q.tooFastShare))}
                </Text>
                {q.longestStraightLine > 1 ? (
                  <Text style={{ color: c.muted, fontSize: 12 }}>
                    {ut("msa.straightLine").replace("{n}", String(q.longestStraightLine))}
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
  const { ut } = useLang();
  const c = useColors();
  const verdict =
    r.alpha >= 0.9
      ? ut("msv.alphaVeryHigh")
      : r.alpha >= 0.8
        ? ut("msv.alphaGood")
        : r.alpha >= 0.7
          ? ut("msv.alphaOk")
          : ut("msv.alphaLow");

  return (
    <View style={{ gap: spacing.sm, marginTop: spacing.lg }}>
      <Divider />
      <Row>
        <Body muted>{ut("msv.alpha")}</Body>
        <View style={{ flex: 1 }} />
        <Text style={{ color: c.text, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
          {r.alpha}
        </Text>
        <Text style={{ color: c.muted, fontSize: 12 }}>{verdict}</Text>
      </Row>
      <Body muted>
        {ut("msa.consistencyNote").replace("{n}", String(r.itemCount))}
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
                {ut("msa.itemTotal").replace("{n}", String(it.itemTotalCorrelation))}
              </Text>
              <Text style={{ color: c.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
                {ut("msa.alphaIfDeleted").replace("{n}", String(it.alphaIfDeleted ?? "—"))}
              </Text>
            </Row>
            {harmful ? (
              <Text style={{ color: c.danger, fontSize: 12 }}>
                {ut("msa.reviseItem")}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function QuestionBlock({ q }: { q: QuestionAnalytics }) {
  const { ut } = useLang();
  const c = useColors();
  return (
    <Card>
      <Text style={{ color: c.text, fontSize: 15, fontWeight: "600" }}>
        {q.position + 1}. {q.title}
      </Text>
      <Row gap={spacing.md}>
        <Text style={{ color: c.muted, fontSize: 12 }}>{q.type}</Text>
        <Text style={{ color: c.muted, fontSize: 12 }}>{ut("msa.answersCount").replace("{n}", String(q.answered))}</Text>
        {q.skipped > 0 ? (
          <Text style={{ color: c.muted, fontSize: 12 }}>{ut("msa.skipsCount").replace("{n}", String(q.skipRate))}</Text>
        ) : null}
      </Row>

      <Divider />

      {/* время на вопрос — то, ради чего эта таблица и нужна */}
      <View style={{ gap: spacing.xs, marginVertical: spacing.sm }}>
        <Row>
          <Body muted>{ut("ma.avgTime")}</Body>
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.text, fontVariant: ["tabular-nums"] }}>
            {formatDuration(q.avgDurationMs)}
          </Text>
        </Row>
        <Row>
          <Body muted>{ut("msv.median")}</Body>
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.text, fontVariant: ["tabular-nums"] }}>
            {formatDuration(q.medianDurationMs)}
          </Text>
        </Row>
        <Row>
          <Body muted>{ut("msv.spread")}</Body>
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.text, fontVariant: ["tabular-nums"] }}>
            {formatDuration(q.minDurationMs)} — {formatDuration(q.maxDurationMs)}
          </Text>
        </Row>
        <Row>
          <Body muted>{ut("msv.thoughtBefore")}</Body>
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.text, fontVariant: ["tabular-nums"] }}>
            {formatDuration(q.avgTimeToFirstAnswerMs)}
          </Text>
        </Row>
        <Row>
          <Body muted>{ut("msv.changesAvg")}</Body>
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.text, fontVariant: ["tabular-nums"] }}>{q.avgChangeCount}</Text>
        </Row>
        <Row>
          <Body muted>{ut("msv.changedAnswer")}</Body>
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.text, fontVariant: ["tabular-nums"] }}>{q.changedShare}%</Text>
        </Row>
        {q.tooFastShare > 0 ? (
          <Row>
            <Body muted>{ut("msv.tooFast")}</Body>
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
              caption: o.avgRank !== undefined ? ut("msa.rank").replace("{n}", String(o.avgRank)) : `${o.percent}%`,
            }))}
          />
        </View>
      ) : null}

      {q.numeric ? (
        <View style={{ marginTop: spacing.sm, gap: spacing.sm }}>
          <Body muted>
            {ut("msa.spreadNoMax")
              .replace("{avg}", String(q.numeric.average))
              .replace("{med}", String(q.numeric.median))
              .replace("{min}", String(q.numeric.min))
              .replace("{max}", String(q.numeric.max))}
          </Body>
          <Histogram data={q.numeric.distribution} />
        </View>
      ) : null}

      {q.texts?.length ? (
        <View style={{ marginTop: spacing.sm, gap: spacing.xs }}>
          <Body muted>{ut("msa.freeText").replace("{n}", String(q.texts.length))}</Body>
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
