import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import type { AlertCase, OverviewAnalytics, Severity, SurveyListItem } from "@quizzy/shared";
import { api } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { Loader } from "@/components/ui";
import { useLang } from "@/lang";
import { formatDuration, severityKey, useColors } from "@/theme";
import { Icon } from "@/ui/Icon";
import { Panel, Squircle } from "@/ui/Panel";
import { T } from "@/ui/Text";
import { lastDays, num, shortName } from "@/staff/model";
import { Card, DayBars, HBars, Line, LinkButton, Loading, Section, StaffTop, StateBlock, SumRows, useDurationValue } from "@/staff/ui";

const SEVERITY_ORDER: Severity[] = ["none", "mild", "moderate", "severe"];

/**
 * Аналітика — вкладка сотрудника.
 *
 * Сначала люди на разбор: аналитика, которая открывается графиком, когда
 * кто-то ждёт разбора сигнала, учит смотреть не туда. Ниже — числа сводки
 * списком с их смыслом (не плитками), сдачи по дням, выраженность по
 * клиническим шкалам и методики по числу проходжень; методика открывается
 * поверх вкладок (/analytics/[id]), «назад» возвращает сюда.
 *
 * Прямой адрес /insights у пациента ведёт в его «Опитування».
 */
export default function InsightsTab() {
  const { loading, isAdmin } = useAuth();
  if (loading) return <Loader />;
  if (!isAdmin) return <Redirect href="/(app)/surveys" />;
  return <Overview />;
}

function Overview() {
  const { ut, locale } = useLang();
  const c = useColors();
  const router = useRouter();
  const [data, setData] = useState<OverviewAnalytics | null>(null);
  const [cases, setCases] = useState<{ items: AlertCase[]; total: number }>({ items: [], total: 0 });
  const [surveys, setSurveys] = useState<SurveyListItem[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const duration = useDurationValue();

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setError(null);
      const [overview, open] = await Promise.all([api.overview(), api.alertCases({ limit: "3" })]);
      setData(overview);
      setCases({ items: open.items, total: open.total ?? open.items.length });
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("ma.loadFailed"));
    } finally {
      setBusy(false);
    }
    api
      .listSurveys()
      .then((rows) => setSurveys(rows ?? []))
      .catch(() => {});
  }, [ut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const top = (
    <StaffTop
      title={ut("tab.analytics")}
      lead={data ? ut("mst.analyticsLead").replace("{s}", String(data.surveyCount)).replace("{r}", String(data.respondentCount)) : undefined}
    />
  );

  if (!data) {
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        {top}
        {error ? <StateBlock icon="circle-alert" title={error} action={{ label: ut("common.retry"), onPress: () => void load() }} /> : <Loading />}
      </View>
    );
  }

  const now = new Date();
  const days = lastDays(data.timeline, 10, now);
  const today = days.at(-1)?.value ?? 0;
  const avg = Math.round(days.reduce((s, d) => s + d.value, 0) / Math.max(1, days.length));
  const sev = SEVERITY_ORDER.map((s) => ({ s, n: data.severityBreakdown.find((b) => b.severity === s)?.count ?? 0 }));
  const sevTotal = sev.reduce((sum, x) => sum + x.n, 0);
  const list = showAll ? (surveys ?? []).map((s) => ({ id: s.id, title: s.title, n: s.responseCount, ms: null as number | null, draft: s.status !== "published" })) : data.topSurveys.map((s) => ({ id: s.surveyId, title: s.title, n: s.responseCount, ms: s.avgDurationMs, draft: false }));

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      {top}
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void load()} tintColor={c.vink} />}>
        {error ? <StateBlock icon="circle-alert" title={error} action={{ label: ut("common.retry"), onPress: () => void load() }} /> : null}

        {/* люди на разбор — первое, что должен увидеть специалист */}
        {cases.total > 0 ? (
          <Card tone="risk" style={{ marginTop: 16 }}>
            <Pressable onPress={() => router.navigate("/(app)/alerts")} accessibilityRole="button" accessibilityLabel={ut("mst.peopleToReview").replace("{n}", String(cases.total))}>
              {({ pressed }) => (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, opacity: pressed ? 0.75 : 1 }}>
                  <Squircle icon="triangle-alert" tone="risk" />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T v="headline">{ut("mst.peopleToReview").replace("{n}", String(cases.total))}</T>
                    <T v="sub" tone="text2" numberOfLines={2}>
                      {cases.items.map((x) => shortName(x.userName)).join(", ")}
                    </T>
                  </View>
                  <Icon name="chevron-right" size={20} color={c.muted} />
                </View>
              )}
            </Pressable>
          </Card>
        ) : null}

        <View style={{ marginHorizontal: 16, marginTop: 16, gap: 16 }}>
          <Panel title={ut("mst.summary")} icon="chart-line" sub={ut("mst.allTime")}>
            <SumRows
              rows={[
                { label: ut("ma.responses"), value: String(data.responseCount), sub: ut("ma.completion").replace("{n}", num(data.completionRate)) },
                { label: ut("ma.respondents"), value: String(data.respondentCount) },
                { label: ut("mst.surveysAtWork"), value: String(data.surveyCount), sub: `${ut("ma.published")} ${data.publishedCount}` },
                { label: ut("ma.avgTime"), ...duration(data.avgDurationMs), sub: ut("mst.perCompletion") },
              ]}
            />
          </Panel>

          <Panel title={ut("mst.completedByDay")} icon="clipboard-check" sub={ut("mst.lastNDays").replace("{n}", String(days.length))}>
            <DayBars days={days.map((d) => ({ key: d.key, label: d.date.toLocaleDateString(locale, { weekday: "short" }), value: d.value }))} />
            <T v="sub">{ut("mst.todayAvg").replace("{t}", String(today)).replace("{a}", String(avg))}</T>
          </Panel>

          {sevTotal > 0 ? (
            <Panel title={ut("ma.severityAll")} icon="gauge" sub={ut("mst.clinicalN").replace("{n}", String(sevTotal))}>
              <HBars
                labelWidth={110}
                rows={sev.map((x) => ({
                  key: x.s,
                  label: ut(severityKey[x.s]),
                  value: x.n,
                  text: `${x.n}`,
                }))}
              />
              <T v="sub">{ut("ma.severityHint")}</T>
            </Panel>
          ) : null}
        </View>

        <Section
          title={ut("ma.byResponses")}
          right={surveys && surveys.length > data.topSurveys.length ? <LinkButton label={showAll ? ut("mst.showTop") : ut("mst.allN").replace("{n}", String(surveys.length))} onPress={() => setShowAll((s) => !s)} /> : undefined}
        />
        {list.length ? (
          <Card>
            {list.map((s, i) => (
              <Pressable key={s.id} onPress={() => router.push(`/analytics/${s.id}`)} accessibilityRole="button" accessibilityLabel={s.title}>
                {({ pressed }) => (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, paddingVertical: 11, paddingLeft: 16, paddingRight: 14, borderTopWidth: i ? 1 : 0, borderTopColor: c.divider, backgroundColor: pressed ? c.panel2 : "transparent" }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T v="body" size={15} weight={800} numberOfLines={2}>
                        {s.title}
                      </T>
                      <T v="sub" num>
                        {[
                          ut("mst.completionsN").replace("{n}", String(s.n)),
                          s.ms ? formatDuration(s.ms) : null,
                          s.draft ? ut("mst.notPublished") : null,
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </T>
                    </View>
                    <Icon name="chevron-right" size={20} color={c.muted} />
                  </View>
                )}
              </Pressable>
            ))}
          </Card>
        ) : (
          <StateBlock title={ut("mrs.none")} />
        )}
        <Line>{ut("mst.analyticsHint")}</Line>
      </ScrollView>
    </View>
  );
}
