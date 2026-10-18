import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { AlertCase, Respondent, WorkItem, Worklist } from "@quizzy/shared";
import { api } from "@/api/client";
import { cache } from "@/offline/cache";
import { activeOwner } from "@/offline/owner";
import { useLang } from "@/lang";
import { useColors } from "@/theme";
import { Btn } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { T } from "@/ui/Text";
import { useNow, useSurveyIndex } from "@/staff/data";
import { caseClock, clock, dm } from "@/staff/model";
import { Avatar, Card, Chip, Loading, PillRow, SearchField, Section, StaffTop, StateBlock, useClockText } from "@/staff/ui";

type View_ = "all" | "risk" | "watch";

interface PersonRow {
  userId: string;
  name: string;
  unit: string | null;
  birthYear: number | null;
  count: number | null;
  last: string | null;
  open: AlertCase | null;
  work: WorkItem[];
}

/**
 * Пацієнти — те, кто проходил методики ваших групп.
 *
 * Сначала те, кто требует внимания сейчас: открытый сигнал ризику или
 * открытое дело в обходе (неявка, просроченный повтор, письмо). Остальные —
 * ниже, по давности последнего замера. Срезы «Ризик» и «Під наглядом»
 * строятся из самих очередей, а не из загруженной страницы списка: человек
 * с сигналом не пропадает оттого, что его замер был давно.
 */
export default function PatientsTab() {
  const { ut } = useLang();
  const c = useColors();
  const router = useRouter();
  const now = useNow();
  const { norm } = useSurveyIndex();

  const [view, setView] = useState<View_>("all");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Respondent[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [cases, setCases] = useState<AlertCase[]>([]);
  const [work, setWork] = useState<WorkItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const loadPeople = useCallback(
    async (search: string, from: string | null = null) => {
      const my = ++seq.current;
      setBusy(true);
      try {
        const page = await api.respondents({ search: search.trim() || undefined, cursor: from ?? undefined });
        if (my !== seq.current) return;
        setPeople((prev) => (from && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        if (!from) setTotal(page.total ?? null);
        setError(null);
      } catch (e) {
        if (my !== seq.current) return;
        setError(e instanceof Error ? e.message : ut("mpt.loadFailed"));
        setPeople((prev) => prev ?? []);
      } finally {
        if (my === seq.current) setBusy(false);
      }
    },
    [ut],
  );

  const loadQueues = useCallback(() => {
    // открытые случаи — человек за строкой (очередь сгруппирована по людям)
    api
      .alertCases({ limit: "100" })
      .then((p) => setCases(p.items))
      .catch(() => {});
    // что от специалиста ждут — снимок обхода, свежий или с устройства
    api
      .rounds()
      .then((r) => setWork(r.list.items))
      .catch(() => setWork(((cache.rounds(activeOwner())?.rows as Worklist | undefined)?.items ?? []) as WorkItem[]));
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadPeople(query);
      loadQueues();
    }, [loadPeople, loadQueues]),
  );

  // поиск — на сервере (ФИО зашифровано), с паузой после набора
  useEffect(() => {
    const t = setTimeout(() => void loadPeople(query), 300);
    return () => clearTimeout(t);
  }, [query, loadPeople]);

  const caseOf = useMemo(() => new Map(cases.map((x) => [x.userId, x])), [cases]);
  const workOf = useMemo(() => {
    const m = new Map<string, WorkItem[]>();
    for (const w of work) m.set(w.userId, [...(m.get(w.userId) ?? []), w]);
    return m;
  }, [work]);
  const watchIds = useMemo(() => [...workOf.keys()], [workOf]);

  const rows: PersonRow[] = useMemo(() => {
    const byId = new Map((people ?? []).map((p) => [p.userId, p]));
    const make = (userId: string, name: string, unit: string | null): PersonRow => {
      const p = byId.get(userId);
      return {
        userId,
        name: p?.fullName ?? name,
        unit: p?.unit ?? unit,
        birthYear: p?.birthYear ?? null,
        count: p?.count ?? null,
        last: p?.last ?? null,
        open: caseOf.get(userId) ?? null,
        work: workOf.get(userId) ?? [],
      };
    };
    const needle = query.trim().toLowerCase();
    const named = (r: PersonRow) => !needle || r.name.toLowerCase().includes(needle);
    if (view === "risk") return cases.map((x) => make(x.userId, x.userName, x.unit)).filter(named);
    if (view === "watch") {
      return watchIds.map((id) => {
        const w = workOf.get(id)![0]!;
        return make(id, w.userName, w.unit);
      }).filter(named);
    }
    return (people ?? []).map((p) => make(p.userId, p.fullName, p.unit));
  }, [view, people, cases, watchIds, workOf, caseOf, query]);

  const attention = view === "all" ? rows.filter((r) => r.open || r.work.length) : rows;
  const calm = view === "all" ? rows.filter((r) => !r.open && !r.work.length) : [];
  const open = (userId: string) => router.push({ pathname: "/analytics/patients/[userId]", params: { userId, back: "patients" } });

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <StaffTop title={ut("mnav.patients")} lead={ut("mpt.sub")}>
        <SearchField value={query} onChange={setQuery} placeholder={ut("mst.searchPatient")} />
      </StaffTop>
      {people === null ? (
        <Loading />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={busy}
              onRefresh={() => {
                void loadPeople(query);
                loadQueues();
              }}
              tintColor={c.vink}
            />
          }
        >
          <PillRow
            value={view}
            onChange={setView}
            items={[
              { key: "all", label: ut("mal.all"), count: total ?? people.length },
              { key: "risk", label: ut("mst.fRisk"), count: cases.length },
              { key: "watch", label: ut("mst.fWatch"), count: watchIds.length },
            ]}
          />
          {error ? <StateBlock icon="circle-alert" title={error} action={{ label: ut("common.retry"), onPress: () => void loadPeople(query) }} /> : null}

          {attention.length ? (
            <>
              <Section
                title={view === "all" ? ut("mst.needAttention") : view === "risk" ? ut("mst.fRisk") : ut("mst.fWatch")}
                count={attention.length}
                sub={view === "all" ? ut("mst.attentionSub") : undefined}
              />
              <Card>
                {attention.map((r, i) => (
                  <Row key={r.userId} r={r} first={i === 0} now={now} norm={r.open ? norm(r.open.surveyId) : null} onPress={() => open(r.userId)} />
                ))}
              </Card>
            </>
          ) : null}
          {calm.length ? (
            <>
              <Section title={ut("mst.others")} count={calm.length} sub={ut("mst.othersSub")} />
              <Card>
                {calm.map((r, i) => (
                  <Row key={r.userId} r={r} first={i === 0} now={now} norm={null} onPress={() => open(r.userId)} />
                ))}
              </Card>
            </>
          ) : null}
          {!rows.length && !error ? <StateBlock title={ut("mst.nobodyFound")} text={ut("mst.nobodyFoundHint")} /> : null}
          {view === "all" && cursor ? (
            <View style={{ marginHorizontal: 16, marginTop: 12 }}>
              <Btn title={ut("mal.loadMore")} icon="chevron-down" full loading={busy} onPress={() => void loadPeople(query, cursor)} />
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

/**
 * Строка пациента: почему он здесь сейчас — сигнал с часами разбора или
 * открытое в обходе, — и сколько замеров с датой последнего.
 */
function Row({ r, first, now, norm, onPress }: { r: PersonRow; first: boolean; now: number; norm: number | null; onPress: () => void }) {
  const c = useColors();
  const { ut } = useLang();
  const of = useClockText();
  const age = r.birthYear ? new Date(now).getFullYear() - r.birthYear : null;
  const k = r.open ? caseClock(r.open.openedAt, norm, now) : null;
  const sub = [age !== null ? ut("mst.age").replace("{n}", String(age)) : null, r.unit].filter(Boolean).join(", ");
  const overdue = r.work.filter((w) => w.overdue);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={[r.name, sub].filter(Boolean).join(". ")}>
      {({ pressed }) => (
        <View
          style={{
            flexDirection: "row",
            gap: 12,
            paddingTop: 12,
            paddingBottom: 13,
            paddingLeft: 16,
            paddingRight: 14,
            borderTopWidth: first ? 0 : 1,
            borderTopColor: c.divider,
            backgroundColor: r.open?.severity === "severe" ? c.risktint : pressed ? c.panel2 : "transparent",
          }}
        >
          <Avatar name={r.name} />
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <T v="headline">{r.name}</T>
            {sub ? <T v="sub">{sub}</T> : null}
            {r.count !== null ? (
              <T v="sub" size={14} tone="text2" num>
                {r.last ? ut("mst.measuresLast").replace("{n}", String(r.count)).replace("{d}", dm(r.last)) : ut("mst.measuresN").replace("{n}", String(r.count))}
              </T>
            ) : null}
            {r.open || r.work.length ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                {r.open && k ? (
                  <Chip kind={r.open.severity === "severe" ? "risk" : "warn"} icon="triangle-alert" label={clock(k.elapsed)} detail={of(k)} />
                ) : null}
                {overdue.length ? (
                  <Chip kind="warn" icon="clock" label={ut(`mst.kind.${overdue[0]!.kind}`)} detail={ut("mst.overdueDays").replace("{n}", String(overdue[0]!.days ?? 0))} />
                ) : r.work[0] ? (
                  <Chip icon="calendar" label={ut(`mst.kind.${r.work[0].kind}`)} />
                ) : null}
                {r.work.length > 1 ? <Chip label={ut("mst.plusN").replace("{n}", String(r.work.length - 1))} /> : null}
              </View>
            ) : null}
          </View>
          <View style={{ alignSelf: "center" }}>
            <Icon name="chevron-right" size={20} color={c.muted} />
          </View>
        </View>
      )}
    </Pressable>
  );
}
