import { useCallback, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { Severity, SurveyResponse, UiKey } from "@quizzy/shared";
import { isAborted } from "@/api/abort";
import { api, type ResponseDetail } from "@/api/client";
import { useReads } from "@/api/useReads";
import { useLang } from "@/lang";
import { useOpenReport } from "@/report/useOpenReport";
import { formatDuration, useColors } from "@/theme";
import { Btn } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { SevPill } from "@/ui/Pill";
import { T } from "@/ui/Text";
import { byDay, dayKey, hm, num, shortName } from "@/staff/model";
import { Avatar, Card, Chip, Loading, PillRow, SearchField, Section, StaffNav, StateBlock } from "@/staff/ui";

type Filter = "all" | "completed" | "abandoned" | "in_progress";

/**
 * Проходження методики — по дням, новые сверху.
 *
 * Строка: кто, когда, сколько длилось и чем кончилось, балл первой шкалы с
 * выраженностью словом. Раскрытая — ответы и время по каждому пункту,
 * сколько раз меняли ответ и пропуски; оттуда же — карта человека и
 * заключение по этому проходженню.
 */
export default function ResponsesScreen() {
  const { ut, locale } = useLang();
  const c = useColors();
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const [rows, setRows] = useState<SurveyResponse[] | null>(null);
  const [detail, setDetail] = useState<ResponseDetail | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const reads = useReads();
  // раскрытая строка — своим чтением: раскрыли другую, пока первая шла, — первая отменяется
  const details = useReads();

  const load = useCallback(async () => {
    if (!id) return;
    const signal = reads.next();
    try {
      setRows(await api.surveyResponses(id, { signal }));
      setError(null);
    } catch (e) {
      if (isAborted(e)) return;
      setError(e instanceof Error ? e.message : ut("mrs.loadFailed"));
      setRows((r) => r ?? []);
    }
  }, [id, ut, reads]);

  // уход с экрана обрывает чтения списка и раскрытой строки; вернулись — список читаем заново
  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        reads.cancel();
        details.cancel();
        setOpening(null);
      };
    }, [load, reads, details]),
  );

  const toggle = async (r: SurveyResponse) => {
    if (detail?.id === r.id) {
      setDetail(null);
      return;
    }
    const signal = details.next();
    setOpening(r.id);
    try {
      setDetail(await api.responseDetail(r.id, { signal }));
    } catch (e) {
      if (isAborted(e)) return;
      setError(e instanceof Error ? e.message : ut("mrs.loadFailed"));
    } finally {
      // отменённое чтение «открывается» уже другой строкой — её отметку не снимаем
      if (!signal.aborted) setOpening(null);
    }
  };

  const all = rows ?? [];
  const count = (f: Filter) => (f === "all" ? all.length : all.filter((r) => r.status === f).length);
  const needle = query.trim().toLowerCase();
  const shown = all.filter(
    (r) =>
      (filter === "all" || r.status === filter) &&
      (!needle || (r.userName ?? ut("mrs.anon")).toLowerCase().includes(needle) || (r.submittedAt ?? r.startedAt).includes(needle) || dayLabelNum(r.submittedAt ?? r.startedAt).includes(needle)),
  );
  const now = new Date();
  const groups = byDay(shown, (r) => r.submittedAt ?? r.startedAt, now);
  const pills = (["all", "completed", "abandoned", "in_progress"] as const)
    .filter((f) => f === "all" || count(f) > 0)
    .map((f) => ({ key: f, label: f === "all" ? ut("mal.all") : ut(`rstatus.${f}`), count: count(f) }));
  const dayTitle = (day: string, ago: number) => {
    const d = new Date(`${day}T12:00:00`).toLocaleDateString(locale, { day: "numeric", month: "long" });
    return ago === 0 ? `${ut("mst.today")}, ${d}` : ago === 1 ? `${ut("mst.yesterday")}, ${d}` : d;
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <StaffNav back={title || ut("mnav.survey")} title={ut("mnav.responses")}>
        <View style={{ gap: 12 }}>
          <SearchField value={query} onChange={setQuery} placeholder={ut("mst.searchResponses")} />
          <PillRow onBand value={filter} onChange={setFilter} items={pills} />
        </View>
      </StaffNav>
      {rows === null ? (
        <Loading />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
          {error ? <StateBlock icon="circle-alert" title={error} action={{ label: ut("common.retry"), onPress: () => void load() }} /> : null}
          {groups.map((g) => (
            <View key={g.day}>
              <Section title={g.day ? dayTitle(g.day, g.ago) : ut("mrs.notSubmitted")} count={g.rows.length} sub={g.ago === 0 && groups[0] === g ? ut("mst.newFirst") : undefined} />
              <Card>
                {g.rows.map((r, i) => (
                  <ResponseRow key={r.id} r={r} first={i === 0} detail={detail?.id === r.id ? detail : null} busy={opening === r.id} onToggle={() => void toggle(r)} />
                ))}
              </Card>
            </View>
          ))}
          {!shown.length && !error ? <StateBlock title={all.length ? ut("mst.nothingFound") : ut("mrs.none")} text={all.length ? ut("mst.nothingFoundHint") : undefined} /> : null}
        </ScrollView>
      )}
    </View>
  );
}

/** «08.10» — по нему ищут, как по дате на бланке */
function dayLabelNum(iso: string): string {
  const k = dayKey(new Date(iso));
  return `${k.slice(8, 10)}.${k.slice(5, 7)}`;
}

function ResponseRow({ r, first, detail, busy, onToggle }: { r: SurveyResponse; first: boolean; detail: ResponseDetail | null; busy: boolean; onToggle: () => void }) {
  const { ut } = useLang();
  const c = useColors();
  const router = useRouter();
  const report = useOpenReport();
  const s = r.scores[0];
  const open = !!detail;
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: c.divider }}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open, busy }} accessibilityLabel={`${r.userName ?? ut("mrs.anon")}, ${hm(r.submittedAt ?? r.startedAt)}`}>
        {({ pressed }) => (
          <View style={{ flexDirection: "row", gap: 12, paddingTop: 12, paddingBottom: 13, paddingLeft: 16, paddingRight: 14, backgroundColor: open ? c.panel2 : pressed ? c.panel2 : "transparent" }}>
            {r.userName ? (
              <Avatar name={r.userName} />
            ) : (
              <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: c.sunk2, alignItems: "center", justifyContent: "center" }}>
                <Icon name="user-round" size={17} color={c.text2} />
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                <T v="headline" numberOfLines={1} style={{ flex: 1 }}>
                  {r.userName ? shortName(r.userName) : ut("mrs.anon")}
                </T>
                <T v="sub" size={14} weight={700} tone="text2" num>
                  {hm(r.submittedAt ?? r.startedAt)}
                </T>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Icon name="timer" size={13} color={c.muted} />
                <T v="sub" num>{`${formatDuration(r.durationMs)}, ${ut(`rstatus.${r.status}` as UiKey, r.status).toLowerCase()}`}</T>
              </View>
              {s ? (
                <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                  {/* балл после поправок — максимум записан для него (#133) */}
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 3 }}>
                    <T v="number" size={20} num scale={false}>
                      {num(s.correctedScore)}
                    </T>
                    <T v="sub" size={12.5} weight={700} num>
                      {`${ut("common.of")} ${num(s.maxScore)}`}
                    </T>
                  </View>
                  {s.band ? <SevPill small severity={s.band.severity as Severity} label={s.band.label} /> : null}
                  {r.scores.length > 1 ? <Chip label={ut("mst.plusScales").replace("{n}", String(r.scores.length - 1))} /> : null}
                </View>
              ) : null}
            </View>
            <View style={{ alignSelf: "center" }}>
              <Icon name={open ? "chevron-up" : "chevron-down"} size={20} color={c.muted} />
            </View>
          </View>
        )}
      </Pressable>
      {detail ? (
        <View style={{ backgroundColor: c.panel2, paddingBottom: 12 }}>
          <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.divider, backgroundColor: c.panel }}>
            <T v="caption" style={{ flex: 1 }}>
              {ut("mst.itemCol")}
            </T>
            <T v="caption" style={{ width: 58, textAlign: "right" }}>
              {ut("mst.changesCol")}
            </T>
            <T v="caption" style={{ width: 52, textAlign: "right" }}>
              {ut("mst.timeCol")}
            </T>
            <T v="caption" style={{ width: 40, textAlign: "right" }}>
              {ut("mst.scoreCol")}
            </T>
          </View>
          {detail.answers.map((a) => (
            <View key={a.questionId} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 38, paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: c.divider }}>
              <T v="sub" size={14} tone="text" numberOfLines={1} style={{ flex: 1 }}>
                <T v="sub" size={14} weight={800} tone="muted">{`${a.position + 1}  `}</T>
                {a.title}
              </T>
              <T v="sub" size={13} weight={700} color={a.changeCount ? c.warn : c.muted} num style={{ width: 58, textAlign: "right" }}>
                {a.changeCount ? ut("mst.changesN").replace("{n}", String(a.changeCount)) : ""}
              </T>
              <T v="sub" size={13} num style={{ width: 52, textAlign: "right" }}>
                {formatDuration(a.durationMs)}
              </T>
              <View style={{ width: 40, alignItems: "flex-end" }}>
                {a.answered && a.score !== null ? (
                  <View style={{ minWidth: 28, height: 24, paddingHorizontal: 6, borderRadius: 7, backgroundColor: a.score ? c.vtint : c.sunk, alignItems: "center", justifyContent: "center" }}>
                    <T v="sub" size={13} weight={800} color={a.score ? c.vink : c.muted} num scale={false}>
                      {num(a.score)}
                    </T>
                  </View>
                ) : (
                  <T v="sub" size={13} num>
                    {a.answered ? "" : ut("mst.skippedShort")}
                  </T>
                )}
              </View>
            </View>
          ))}
          <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingTop: 12 }}>
            {r.userId ? (
              <Btn title={ut("mst.card")} icon="user-round" size="s" flex={1} onPress={() => router.push({ pathname: "/analytics/patients/[userId]", params: { userId: r.userId! } })} />
            ) : null}
            {r.status === "completed" ? <Btn title={ut("mst.conclusion")} icon="file-text" size="s" flex={1} loading={report.opening} onPress={() => report.open(r.id)} /> : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}
