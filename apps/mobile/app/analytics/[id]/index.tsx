import { useCallback, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { QuestionAnalytics, SurveyAnalytics, UiKey } from "@quizzy/shared";
import { api } from "@/api/client";
import { Histogram } from "@/components/charts";
import { BoxPlot, Heatmap, Scatter, boxStatsOf } from "@/components/viz";
import { useLang } from "@/lang";
import { formatDuration, useColors } from "@/theme";
import { ActionBar, Btn } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { Callout, Panel } from "@/ui/Panel";
import { Segmented } from "@/ui/Segmented";
import { T } from "@/ui/Text";
import { lastDays, num } from "@/staff/model";
import { Card, Chip, DayBars, HBars, Line, Loading, PillRow, Section, SplitBar, StaffNav, StateBlock, SumRows, useDurationValue } from "@/staff/ui";

type Tab = "overview" | "questions" | "scales" | "quality";

/** Порог связи пункта со шкалой: ниже — пункт слабо меряет то же, что остальные */
const WEAK_R = 0.3;

/**
 * Аналитика одной методики — по версии: проходження разных версий не
 * смешиваются, питання в них разные.
 *
 * «Загальне»: числа сводки списком с их смыслом, сдачи по дням,
 * доходимість и где покидают. «Питання»: распределение выборов, время
 * ответа и сомнения, разбор каждого питання. «Шкали»: распределение по
 * полосам, альфа Кронбаха и связь каждого пункта со шкалой — с подсказкой
 * пересмотреть слабый. «Якість»: позначенные проходження и почему.
 */
export default function SurveyAnalyticsScreen() {
  const { ut } = useLang();
  const c = useColors();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [data, setData] = useState<SurveyAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [versionId, setVersionId] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setData(await api.surveyAnalytics(id, versionId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("ma.loadFailed"));
    }
  }, [id, versionId, ut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const back = ut("tab.analytics");
  if (!data) {
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <StaffNav back={back} title={ut("mnav.survey")} />
        {error ? <StateBlock icon="circle-alert" title={error} action={{ label: ut("common.retry"), onPress: () => void load() }} /> : <Loading />}
      </View>
    );
  }

  const flagged = data.quality.filter((q) => q.flagged).length;
  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      {/* название методики бывает длинным («Депресія (PHQ-9)») — оно на полосе целиком, а не обрезанным в строке навигации */}
      <StaffNav back={back}>
        <View style={{ gap: 12 }}>
          <T v="sheetTitle" accessibilityRole="header">
            {data.title}
          </T>
          {/* после правки методики данные остаются на прежней версии — видно, какую смотрим */}
          {data.versions.length > 1 ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <T v="sub" weight={700} tone="text2">
                {ut("mst.version")}
              </T>
              <View style={{ flex: 1 }}>
                <PillRow
                  onBand
                  inline
                  value={data.versionId ?? ""}
                  onChange={(v) => setVersionId(v)}
                  items={data.versions.map((v) => ({ key: v.id, label: `v${v.version}`, count: v.responseCount }))}
                />
              </View>
            </View>
          ) : null}
          <Segmented
            onBand
            value={tab}
            onChange={setTab}
            accessibilityLabel={data.title}
            options={[
              { value: "overview", label: ut("msv.general") },
              { value: "questions", label: ut("msv.questions") },
              { value: "scales", label: ut("msv.scales") },
              { value: "quality", label: ut("msa.quality"), count: flagged || undefined },
            ]}
          />
        </View>
      </StaffNav>

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        {error ? <StateBlock icon="circle-alert" title={error} action={{ label: ut("common.retry"), onPress: () => void load() }} /> : null}
        {data.versions.length > 1 ? <Line>{ut("msa.versionNote").replace("{v}", String(data.versionNumber))}</Line> : null}
        <View style={{ marginHorizontal: 16, marginTop: 16, gap: 16 }}>
          {tab === "overview" ? <Overview data={data} /> : null}
          {tab === "questions" ? <Questions data={data} /> : null}
          {tab === "scales" ? <Scales data={data} /> : null}
          {tab === "quality" ? <Quality data={data} /> : null}
        </View>
      </ScrollView>

      <ActionBar>
        <Btn
          title={ut("mst.completionsBtn").replace("{n}", String(data.started))}
          kind="primary"
          size="l"
          icon="clipboard-list"
          flex={1}
          onPress={() => router.push({ pathname: "/analytics/[id]/responses", params: { id: id!, title: data.title } })}
        />
      </ActionBar>
    </View>
  );
}

function Overview({ data }: { data: SurveyAnalytics }) {
  const { ut, locale } = useLang();
  const duration = useDurationValue();
  const days = lastDays(data.timeline, 10, new Date());
  const today = days.at(-1)?.value ?? 0;
  const avg = Math.round(days.reduce((s, d) => s + d.value, 0) / Math.max(1, days.length));
  const lost = data.dropOff.filter((d) => d.lost > 0);
  const worst = [...data.dropOff].sort((a, b) => b.lost - a.lost)[0];
  const lostTotal = data.dropOff.reduce((s, d) => s + d.lost, 0);
  return (
    <>
      <Panel title={ut("ma.overview")} icon="clipboard-check" sub={`v${data.versionNumber}`}>
        <SumRows
          rows={[
            { label: ut("msv.completed"), value: String(data.completed), sub: ut("msa.started").replace("{n}", String(data.started)) },
            { label: ut("msv.completion"), value: num(data.completionRate), unit: "%", sub: ut("mst.abandonedOf").replace("{n}", String(data.abandoned)).replace("{of}", String(data.started)) },
            { label: ut("ma.avgTime"), ...duration(data.avgDurationMs), sub: ut("mst.perCompletion") },
            { label: ut("msv.median"), ...duration(data.medianDurationMs), sub: ut("mst.halfFaster") },
          ]}
        />
      </Panel>

      <Panel title={ut("msv.dynamics")} icon="chart-line" sub={ut("mst.lastNDays").replace("{n}", String(days.length))}>
        <DayBars days={days.map((d) => ({ key: d.key, label: d.date.toLocaleDateString(locale, { weekday: "short" }), value: d.value }))} />
        <T v="sub">{ut("mst.todayAvg").replace("{t}", String(today)).replace("{a}", String(avg))}</T>
      </Panel>

      <Panel title={ut("msv.completion")} icon="circle-check" sub={ut("msv.completedVsAbandoned")}>
        <SplitBar
          parts={[
            { key: "done", label: ut("mst.completedN").replace("{n}", String(data.completed)), value: data.completed, strong: true },
            { key: "left", label: ut("mst.abandonedN").replace("{n}", String(data.abandoned)), value: data.abandoned },
          ]}
        />
      </Panel>

      {lost.length && worst ? (
        <Panel title={ut("msv.dropoff")} icon="log-out" sub={ut("mst.peopleN").replace("{n}", String(lostTotal))}>
          <HBars
            stacked
            rows={data.dropOff.map((d) => ({ key: d.questionId, label: `${d.position + 1}. ${d.title}`, value: d.lost, hl: d.questionId === worst.questionId }))}
          />
          <Callout kind="v" icon="lightbulb" text={ut("mst.dropWorst").replace("{n}", String(worst.position + 1)).replace("{k}", String(worst.lost))} />
        </Panel>
      ) : null}
    </>
  );
}

function Questions({ data }: { data: SurveyAnalytics }) {
  const { ut } = useLang();
  const [open, setOpen] = useState<string | null>(null);
  // тепловая карта — только по пунктам с одинаковым набором вариантов: иначе столбцы значили бы разное
  const withOptions = data.questions.filter((q) => (q.options?.length ?? 0) > 0);
  const keyOf = (q: QuestionAnalytics) => (q.options ?? []).map((o) => o.text).join("|");
  const dominant = withOptions.reduce<Record<string, number>>((acc, q) => {
    acc[keyOf(q)] = (acc[keyOf(q)] ?? 0) + 1;
    return acc;
  }, {});
  const best = Object.entries(dominant).sort((a, b) => b[1] - a[1])[0]?.[0];
  const heatQ = withOptions.filter((q) => keyOf(q) === best && (dominant[best ?? ""] ?? 0) > 1);
  const answered = data.questions.filter((q) => q.answered > 0);
  const medians = answered.map((q) => q.medianDurationMs / 1000).sort((a, b) => a - b);
  const mid = medians.length ? medians[Math.floor(medians.length / 2)]! : 0;
  return (
    <>
      {heatQ.length ? (
        <Panel title={ut("msv.optionSpread")} icon="clipboard-list" sub={ut("mst.ofAnswered")}>
          {/* столбцы — номера вариантов: подписи вариантов длинные и в шапку столбца не помещаются; расшифровка — под таблицей */}
          <Heatmap
            rows={heatQ.map((q) => ({ label: `${q.position + 1}. ${q.title}`, cells: (q.options ?? []).map((o, i) => ({ label: String(i + 1), value: o.percent })) }))}
            columns={heatQ[0]?.options?.map((_, i) => String(i + 1)) ?? []}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 4 }}>
            {(heatQ[0]?.options ?? []).map((o, i) => (
              <T key={o.optionId} v="sub" size={13} tone="text2">
                <T v="sub" size={13} weight={800} tone="text">{`${i + 1} `}</T>
                {o.text}
              </T>
            ))}
          </View>
        </Panel>
      ) : null}

      {answered.length ? (
        <Panel title={ut("msv.timePerQuestion")} icon="timer" sub={ut("mst.medianSec")}>
          <HBars
            labelWidth={140}
            mark={mid}
            rows={answered.map((q) => ({ key: q.questionId, label: `${q.position + 1}. ${q.title}`, value: q.medianDurationMs / 1000, text: formatDuration(q.medianDurationMs) }))}
          />
          <T v="sub">{ut("mst.medianMark").replace("{t}", formatDuration(mid * 1000))}</T>
        </Panel>
      ) : null}

      {answered.length ? (
        <Panel title={ut("msv.doubts")} icon="pencil-line" sub={ut("msv.changedAnswer")}>
          <HBars
            labelWidth={140}
            max={100}
            rows={answered.map((q) => ({ key: q.questionId, label: `${q.position + 1}. ${q.title}`, value: q.changedShare, text: `${num(q.changedShare)}%` }))}
          />
          <T v="sub">{ut("msv.doubtsHint")}</T>
        </Panel>
      ) : null}

      <View style={{ marginHorizontal: -16 }}>
        <Section title={ut("msv.questions")} count={data.questions.length} sub={ut("mst.questionTap")} />
        <Card>
          {data.questions.map((q, i) => (
            <QuestionRow key={q.questionId} q={q} first={i === 0} open={open === q.questionId} onToggle={() => setOpen(open === q.questionId ? null : q.questionId)} />
          ))}
        </Card>
      </View>
    </>
  );
}

/** Питання: строка с ответами и пропусками; раскрытое — время, сомнения, варианты */
function QuestionRow({ q, first, open, onToggle }: { q: QuestionAnalytics; first: boolean; open: boolean; onToggle: () => void }) {
  const { ut } = useLang();
  const c = useColors();
  const kv: [string, string, boolean?][] = [
    [ut("ma.avgTime"), formatDuration(q.avgDurationMs)],
    [ut("msv.median"), formatDuration(q.medianDurationMs)],
    [ut("msv.spread"), `${formatDuration(q.minDurationMs)} — ${formatDuration(q.maxDurationMs)}`],
    // ленту событий чистит срок хранения телеметрии: тогда время неизвестно, а не ноль
    [ut("msv.thoughtBefore"), q.avgTimeToFirstAnswerMs === null ? "—" : formatDuration(q.avgTimeToFirstAnswerMs)],
    [ut("msv.changesAvg"), num(q.avgChangeCount)],
    [ut("msv.changedAnswer"), `${num(q.changedShare)}%`],
  ];
  if (q.tooFastShare > 0) kv.push([ut("msv.tooFast"), `${num(q.tooFastShare)}%`, true]);
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: c.divider, backgroundColor: open ? c.panel2 : "transparent" }}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${q.position + 1}. ${q.title}`}>
        {({ pressed }) => (
          <View style={{ flexDirection: "row", gap: 10, paddingVertical: 12, paddingLeft: 16, paddingRight: 14, opacity: pressed ? 0.7 : 1 }}>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <T v="body" size={15} weight={700}>{`${q.position + 1}. ${q.title}`}</T>
              <T v="sub" num>
                {[ut(`qt.${q.type}` as UiKey, q.type), ut("msa.answersCount").replace("{n}", String(q.answered)), q.skipped > 0 ? ut("msa.skipsCount").replace("{n}", String(q.skipRate)) : null]
                  .filter(Boolean)
                  .join(", ")}
              </T>
            </View>
            <Icon name={open ? "chevron-up" : "chevron-down"} size={20} color={c.muted} />
          </View>
        )}
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 14, gap: 12 }}>
          <View style={{ gap: 6 }}>
            {kv.map(([k, v, warn]) => (
              <View key={k} style={{ flexDirection: "row", gap: 12 }}>
                <T v="sub" size={14} style={{ flex: 1 }}>
                  {k}
                </T>
                <T v="sub" size={14} weight={800} color={warn ? c.warn : c.text} num>
                  {v}
                </T>
              </View>
            ))}
          </View>
          {q.options?.length ? (
            <HBars
              labelWidth={130}
              rows={q.options.map((o) => ({
                key: o.optionId,
                label: o.text,
                value: o.count,
                text: o.avgRank !== undefined ? ut("msa.rank").replace("{n}", String(o.avgRank)) : `${num(o.percent)}%`,
              }))}
            />
          ) : null}
          {q.numeric ? (
            <View style={{ gap: 8 }}>
              <T v="sub">
                {ut("mst.numSpread")
                  .replace("{avg}", num(q.numeric.average))
                  .replace("{med}", num(q.numeric.median))
                  .replace("{min}", num(q.numeric.min))
                  .replace("{max}", num(q.numeric.max))}
              </T>
              <Histogram data={q.numeric.distribution} />
            </View>
          ) : null}
          {q.texts?.length ? (
            <View style={{ gap: 6 }}>
              <T v="sub" weight={700}>
                {ut("msa.freeText").replace("{n}", String(q.texts.length))}
              </T>
              {q.texts.slice(0, 8).map((t, i) => (
                <View key={i} style={{ padding: 10, borderRadius: 10, backgroundColor: c.sunk }}>
                  <T v="note" tone="text">
                    {t}
                  </T>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Scales({ data }: { data: SurveyAnalytics }) {
  const { ut } = useLang();
  const c = useColors();
  if (data.scales.length === 0) return <Callout text={ut("msa.noSubscales")} />;
  // слабый пункт — первым делом: «пересмотреть формулировку» и есть то, ради чего сюда приходят
  const weak = data.scales
    .flatMap((s) => (s.reliability?.items ?? []).map((it) => ({ s, it, alpha: s.reliability!.alpha })))
    .filter(({ it, alpha }) => it.itemTotalCorrelation < WEAK_R || (it.alphaIfDeleted !== null && it.alphaIfDeleted > alpha))
    .sort((a, b) => a.it.itemTotalCorrelation - b.it.itemTotalCorrelation)[0];
  return (
    <>
      {weak ? (
        <Callout
          kind="warn"
          icon="triangle-alert"
          title={ut("mst.weakItem").replace("{t}", weak.it.title)}
          text={`${ut("mst.weakR").replace("{r}", num(weak.it.itemTotalCorrelation))}${weak.it.alphaIfDeleted !== null ? ` ${ut("mst.alphaWithout").replace("{a}", num(weak.it.alphaIfDeleted))}` : ""} ${ut("msa.reviseItem")}.`}
        />
      ) : null}
      {data.scales.length > 1 ? (
        <Panel title={ut("msv.subscales")} icon="chart-line" sub={ut("msv.subscalesHint")}>
          <BoxPlot categorical boxes={data.scales.map((s) => boxStatsOf(s.code, [s.min, s.p25, s.median, s.p75, s.max])).filter((b): b is NonNullable<typeof b> => b !== null)} />
        </Panel>
      ) : null}
      {data.scales.map((s) => {
        const total = s.bands.reduce((sum, b) => sum + b.count, 0);
        const r = s.reliability;
        const verdict = r ? (r.alpha >= 0.9 ? "msv.alphaVeryHigh" : r.alpha >= 0.8 ? "msv.alphaGood" : r.alpha >= 0.7 ? "msv.alphaOk" : "msv.alphaLow") : null;
        return (
          <Panel key={s.scaleId} title={s.title} icon="gauge" sub={s.code ? `${s.code}, n = ${total}` : `n = ${total}`}>
            <T v="note">
              {ut("mst.scaleSum")
                .replace("{avg}", num(s.average))
                .replace("{med}", num(s.median))
                .replace("{min}", num(s.min))
                .replace("{max}", num(s.max))
                .replace("{of}", num(s.maxPossible))}
            </T>
            {s.bands.length ? (
              <HBars
                stacked
                rows={s.bands.map((b) => ({ key: `${b.label}${b.min}`, label: `${b.label}, ${num(b.min)}–${num(b.max)}`, value: b.count, text: `${b.count}` }))}
              />
            ) : null}
            {r && verdict ? (
              <View style={{ marginTop: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.divider, gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <T v="sub" weight={700} tone="text2" style={{ flex: 1 }}>
                    {ut("msv.alpha")}
                  </T>
                  <T v="number" size={28} num scale={false}>
                    {num(r.alpha)}
                  </T>
                  <Chip kind={r.alpha >= 0.8 ? "good" : r.alpha >= 0.7 ? "n" : "warn"} label={ut(verdict)} />
                </View>
                <T v="sub">{ut("msa.consistencyNote").replace("{n}", String(r.itemCount))}</T>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: c.divider }}>
                  <T v="caption" style={{ flex: 1 }}>
                    {ut("mst.itemCol")}
                  </T>
                  <View style={{ width: 56 }} />
                  <T v="caption" style={{ width: 36, textAlign: "right" }}>
                    {ut("mst.rCol")}
                  </T>
                  <T v="caption" style={{ width: 62, textAlign: "right" }}>
                    {ut("mst.withoutCol")}
                  </T>
                </View>
                {r.items.map((it, n) => {
                  const bad = it.itemTotalCorrelation < WEAK_R || (it.alphaIfDeleted !== null && it.alphaIfDeleted > r.alpha);
                  return (
                    <View
                      key={it.questionId}
                      style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 34, borderBottomWidth: n === r.items.length - 1 ? 0 : 1, borderBottomColor: c.divider }}
                      accessible
                      accessibilityLabel={`${it.title}: ${ut("msa.itemTotal").replace("{n}", num(it.itemTotalCorrelation))}, ${ut("msa.alphaIfDeleted").replace("{n}", it.alphaIfDeleted === null ? "—" : num(it.alphaIfDeleted))}`}
                    >
                      <T v="sub" size={14} weight={bad ? 800 : 600} color={bad ? c.warn : c.text2} numberOfLines={1} style={{ flex: 1 }}>
                        {it.title}
                      </T>
                      <View style={{ width: 56 }}>
                        <CorrTrack r={it.itemTotalCorrelation} weak={bad} />
                      </View>
                      <T v="sub" size={14} weight={800} color={bad ? c.warn : c.text} num style={{ width: 36, textAlign: "right" }}>
                        {num(it.itemTotalCorrelation)}
                      </T>
                      <T v="sub" size={14} num color={bad ? c.warn : c.muted} style={{ width: 62, textAlign: "right" }}>
                        {it.alphaIfDeleted === null ? "—" : num(it.alphaIfDeleted)}
                      </T>
                    </View>
                  );
                })}
                <T v="sub">{ut("mst.corrHint").replace("{r}", num(WEAK_R))}</T>
              </View>
            ) : null}
          </Panel>
        );
      })}
    </>
  );
}

/** Связь пункта со шкалой полоской: риска — порог 0,3 */
function CorrTrack({ r, weak }: { r: number; weak: boolean }) {
  const c = useColors();
  const top = 1;
  return (
    <View style={{ height: 8, borderRadius: 4, backgroundColor: c.sunk2 }}>
      <View style={{ width: `${Math.max(2, Math.min(100, (Math.max(0, r) / top) * 100))}%`, height: 8, borderRadius: 4, backgroundColor: weak ? c.warn : c.vink }} />
      <View style={{ position: "absolute", left: `${(WEAK_R / top) * 100}%`, top: -4, width: 2, height: 16, marginLeft: -1, borderRadius: 1, backgroundColor: c.text }} />
    </View>
  );
}

function Quality({ data }: { data: SurveyAnalytics }) {
  const { ut } = useLang();
  const c = useColors();
  const flagged = data.quality.filter((q) => q.flagged);
  return (
    <>
      <Callout
        kind={flagged.length ? "warn" : "good"}
        icon={flagged.length ? "eye" : "circle-check"}
        title={ut("msv.careless")}
        text={ut("msa.flaggedNote")
          .replace("{n}", String(flagged.length))
          .replace("{total}", String(data.completed))
          .replace("{sec}", num(Math.round(data.tooFastThresholdMs / 100) / 10))}
      />
      {data.quality.length ? (
        <Panel title={ut("msv.timeVsFast")} icon="chart-line" sub={String(data.quality.length)}>
          <Scatter
            xLabel={ut("msa.durationAxis")}
            yLabel={ut("msa.fastAxis")}
            xThreshold={(data.questions.length * data.tooFastThresholdMs) / 1000}
            points={data.quality.map((q) => ({ x: Math.round(q.durationMs / 1000), y: q.tooFastShare, flagged: q.flagged }))}
          />
          <T v="sub">{ut("msv.fastHint")}</T>
        </Panel>
      ) : null}
      <View style={{ marginHorizontal: -16 }}>
        <Section title={ut("mst.flaggedTitle")} count={flagged.length} />
        {flagged.length ? (
          <Card>
            {flagged.map((q, i) => (
              <View key={q.responseId} style={{ flexDirection: "row", gap: 12, paddingTop: 12, paddingBottom: 13, paddingLeft: 16, paddingRight: 14, borderTopWidth: i ? 1 : 0, borderTopColor: c.divider }}>
                <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: c.sunk2, alignItems: "center", justifyContent: "center" }}>
                  <Icon name="user-round" size={17} color={c.text2} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                  <T v="headline">{q.respondent ?? ut("mrs.anon")}</T>
                  {q.reasons.map((r, k) => (
                    <View key={k} style={{ flexDirection: "row", gap: 8 }}>
                      <View style={{ width: 8, height: 8, marginTop: 6, backgroundColor: c.warn, transform: [{ rotate: "45deg" }] }} />
                      <T v="note" tone="text" style={{ flex: 1 }}>
                        {r}
                      </T>
                    </View>
                  ))}
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                    <Chip kind="warn" icon="timer" label={formatDuration(q.durationMs)} detail={ut("msa.fastAnswers").replace("{n}", String(q.tooFastShare))} />
                    {q.longestStraightLine > 1 ? <Chip label={ut("msa.straightLine").replace("{n}", String(q.longestStraightLine))} /> : null}
                  </View>
                </View>
              </View>
            ))}
          </Card>
        ) : (
          <StateBlock icon="circle-check" title={ut("msv.noSuspicious")} />
        )}
      </View>
    </>
  );
}

