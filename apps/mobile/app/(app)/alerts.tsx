import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { AlertCase } from "@quizzy/shared";
import { api } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { useLang } from "@/lang";
import { useColors } from "@/theme";
import { Btn } from "@/ui/Button";
import { Segmented } from "@/ui/Segmented";
import { T } from "@/ui/Text";
import { useToast } from "@/ui/Toast";
import { refreshStaffBadges } from "@/staff/badges";
import { useNow, useSurveyIndex } from "@/staff/data";
import { caseClock, dm, hm, hours } from "@/staff/model";
import { ReviewSheet } from "@/staff/ReviewSheet";
import { StaffOnly } from "@/staff/StaffOnly";
import { Avatar, Card, Chip, Line, Loading, Section, StaffTop, StateBlock, useClock, useClockText } from "@/staff/ui";

type Mode = "open" | "done";

/**
 * Сигналы ризику — очередь разбора на телефоне.
 *
 * Единица работы — человек, а не сработавший пункт: пять отмеченных пунктов
 * одного обследуемого дают один случай и одно клиническое решение. Строка
 * говорит, что сработало и сколько осталось до нормы; «Розібрати» открывает
 * лист снизу (staff/ReviewSheet.tsx), и список остаётся на месте.
 *
 * Разобранные — отдельной вкладкой переключателя: кто разобрал, когда и с
 * каким исходом.
 */
export default function AlertsTab() {
  // пациенту по ссылке — его «Головна», а не очередь случаев (staff/StaffOnly.tsx)
  return (
    <StaffOnly>
      <Alerts />
    </StaffOnly>
  );
}

function Alerts() {
  const { ut } = useLang();
  const c = useColors();
  const router = useRouter();
  const toast = useToast();
  const { user } = useAuth();
  const now = useNow();
  const { norm } = useSurveyIndex();

  const [mode, setMode] = useState<Mode>("open");
  const [rows, setRows] = useState<AlertCase[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [totals, setTotals] = useState<{ open: number | null; done: number | null }>({ open: null, done: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<AlertCase | null>(null);

  const load = useCallback(
    async (m: Mode, from: string | null = null) => {
      setBusy(true);
      try {
        setError(null);
        const page = await api.alertCases({ limit: "20", status: m === "done" ? "resolved" : undefined, cursor: from ?? undefined });
        setRows((prev) => (from && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        if (!from) setTotals((t) => ({ ...t, [m]: page.total ?? page.items.length }));
        // число на второй половине переключателя — одним лёгким запросом
        if (!from) {
          const other: Mode = m === "open" ? "done" : "open";
          void api
            .alertCases({ limit: "1", status: other === "done" ? "resolved" : undefined })
            .then((p) => setTotals((t) => ({ ...t, [other]: p.total ?? p.items.length })))
            .catch(() => {});
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : ut("mal.loadFailed"));
        if (!from) setRows((prev) => prev ?? []);
      } finally {
        setBusy(false);
      }
    },
    [ut],
  );

  useFocusEffect(
    useCallback(() => {
      void load(mode);
    }, [load, mode]),
  );

  const switchTo = (m: Mode) => {
    if (m === mode) return;
    setRows(null);
    setMode(m);
  };

  const take = async (item: AlertCase) => {
    try {
      await api.assignCase(item.id);
      toast.show(ut("mst.taken"), { icon: "check" });
    } catch (e) {
      toast.show(e instanceof Error ? e.message : ut("mal.saveFailed"), { icon: "circle-alert" });
    }
    void load(mode);
  };

  // норма одна на всех — говорим её словами; разные у разных методик — не обещаем одной
  const norms = [...new Set((mode === "open" ? (rows ?? []) : []).map((r) => norm(r.surveyId)).filter((n): n is number => !!n))];
  const lead = norms.length === 1 ? ut("mst.alertsLeadNorm").replace("{h}", hours(norms[0]!)) : ut("mst.alertsLead");

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <StaffTop title={ut("mst.alertsTitle")} lead={lead}>
        <Segmented
          onBand
          value={mode}
          onChange={switchTo}
          accessibilityLabel={ut("mst.alertsTitle")}
          options={[
            { value: "open", label: ut("mal.open"), count: totals.open ?? undefined },
            { value: "done", label: ut("mst.resolved"), count: totals.done ?? undefined },
          ]}
        />
      </StaffTop>
      {rows === null ? (
        <Loading />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void load(mode)} tintColor={c.vink} />}
        >
          {error ? <StateBlock icon="circle-alert" title={error} action={{ label: ut("common.retry"), onPress: () => void load(mode) }} /> : null}
          {mode === "open" ? (
            <>
              <Section title={ut("mst.waiting")} count={totals.open ?? rows.length} countKind="r" sub={ut("mal.caseIsPerson")} />
              {rows.length ? (
                <Card>
                  {rows.map((r, i) => (
                    <OpenRow
                      key={r.id}
                      item={r}
                      first={i === 0}
                      now={now}
                      norm={norm(r.surveyId)}
                      mine={r.assignedTo === user?.id}
                      onReview={() => setReview(r)}
                      onTake={() => void take(r)}
                      onPerson={() => router.push({ pathname: "/analytics/patients/[userId]", params: { userId: r.userId, back: "alerts" } })}
                    />
                  ))}
                </Card>
              ) : !error ? (
                <StateBlock icon="shield-check" title={ut("mal.none")} text={ut("mst.noneHint")} />
              ) : null}
              {rows.length ? <Line>{ut("mst.reviewHere")}</Line> : null}
            </>
          ) : (
            <>
              <Section title={ut("mst.resolvedTitle")} count={totals.done ?? rows.length} />
              {rows.length ? (
                <Card>
                  {rows.map((r, i) => (
                    <DoneRow key={r.id} item={r} first={i === 0} />
                  ))}
                </Card>
              ) : !error ? (
                <StateBlock title={ut("mst.noneResolved")} />
              ) : null}
            </>
          )}
          {cursor ? (
            <View style={{ marginHorizontal: 16, marginTop: 12 }}>
              <Btn title={ut("mal.loadMore")} icon="chevron-down" full loading={busy} onPress={() => void load(mode, cursor)} />
            </View>
          ) : null}
        </ScrollView>
      )}
      <ReviewSheet
        item={review}
        norm={review ? norm(review.surveyId) : null}
        onClose={() => setReview(null)}
        onDone={() => {
          setReview(null);
          refreshStaffBadges();
          void load(mode);
        }}
      />
    </View>
  );
}

/**
 * Открытый случай: человек, что сработало (по строке на сигнал), часы до
 * нормы и кто взял. Тяжёлый — на красной подложке: это риск для человека.
 */
function OpenRow({
  item,
  first,
  now,
  norm,
  mine,
  onReview,
  onTake,
  onPerson,
}: {
  item: AlertCase;
  first: boolean;
  now: number;
  norm: number | null;
  mine: boolean;
  onReview: () => void;
  onTake: () => void;
  onPerson: () => void;
}) {
  const c = useColors();
  const { ut } = useLang();
  const of = useClockText();
  const clockOf = useClock();
  const k = caseClock(item.openedAt, norm, now);
  const severe = item.severity === "severe";
  const more = (item.group?.cases ?? 1) - 1;
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 12,
        paddingTop: 14,
        paddingBottom: 14,
        paddingLeft: 16,
        paddingRight: 14,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: severe ? c.riskline : c.divider,
        backgroundColor: severe ? c.risktint : "transparent",
      }}
    >
      <Avatar name={item.userName} />
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <View>
          <T v="headline" onPress={onPerson} accessibilityRole="link">
            {item.userName}
          </T>
          <T v="sub">{[item.unit, item.surveyTitle].filter(Boolean).join(", ")}</T>
        </View>
        <View style={{ gap: 4 }}>
          {item.signals.slice(0, 3).map((s) => (
            <View key={s.id} style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ width: 9, height: 9, marginTop: 6, borderRadius: 2.5, backgroundColor: s.severity === "severe" ? c.risk : c.warn }} />
              <T v="note" tone="text" style={{ flex: 1 }}>
                {s.label}
                <T v="sub" size={13}>{`  ${dm(s.at)}, ${hm(s.at)}`}</T>
              </T>
            </View>
          ))}
          {item.signalCount > 3 ? <T v="sub">{ut("mal.andMore").replace("{n}", String(item.signalCount - 3))}</T> : null}
          {more > 0 ? <T v="sub">{ut("mst.moreCases").replace("{n}", String(more))}</T> : null}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Chip kind="risk" icon="timer" label={clockOf(k.elapsed)} detail={of(k)} />
          {k.due ? <Chip label={ut("mst.until").replace("{t}", hm(k.due))} /> : null}
          {item.overdue || k.over ? <Chip kind="warn" icon="clock" label={ut("mal.overdue")} /> : null}
          {item.assignedToName ? <Chip kind={mine ? "v" : "n"} icon="user-round" label={mine ? ut("mst.takenByMe") : item.assignedToName} /> : null}
        </View>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
          <Btn title={ut("mst.review")} kind="risk" icon="triangle-alert" onPress={onReview} accessibilityHint={ut("mst.reviewHint")} />
          {!item.assignedTo ? <Btn title={ut("mal.take")} kind="ghost" icon="user-round" onPress={onTake} /> : null}
        </View>
      </View>
    </View>
  );
}

const OUTCOME_CHIP = {
  confirmed: { kind: "riskOutline", icon: "triangle-alert", key: "mal.confirmed" },
  needs_followup: { kind: "warn", icon: "eye", key: "mal.needsFollowup" },
  not_confirmed: { kind: "good", icon: "shield-check", key: "mal.notConfirmed" },
  duplicate: { kind: "n", icon: "archive", key: "mst.duplicate" },
} as const;

/** Разобранный случай: кто и когда, заметка и исход словом */
function DoneRow({ item, first }: { item: AlertCase; first: boolean }) {
  const c = useColors();
  const { ut } = useLang();
  const o = item.outcome ? OUTCOME_CHIP[item.outcome] : null;
  return (
    <View style={{ flexDirection: "row", gap: 12, paddingTop: 12, paddingBottom: 13, paddingLeft: 16, paddingRight: 14, borderTopWidth: first ? 0 : 1, borderTopColor: c.divider }}>
      <Avatar name={item.userName} muted />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <T v="headline">{item.userName}</T>
        <T v="sub">
          {item.acknowledgedAt
            ? ut("mal.resolvedBy").replace("{who}", item.acknowledgedByName ?? "—").replace("{at}", `${dm(item.acknowledgedAt)}, ${hm(item.acknowledgedAt)}`)
            : item.surveyTitle}
        </T>
        {item.note ? <T v="note">{item.note}</T> : null}
        {o ? (
          <View style={{ marginTop: 4 }}>
            <Chip kind={o.kind} icon={o.icon} label={ut(o.key)} />
          </View>
        ) : null}
      </View>
    </View>
  );
}
