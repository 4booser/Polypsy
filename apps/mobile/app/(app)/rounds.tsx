import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { AlertCase, UiKey, WorkItem } from "@quizzy/shared";
import { api } from "@/api/client";
import { shownAfterFailure } from "@/api/access";
import { activeOwner } from "@/offline/owner";
import { useLang } from "@/lang";
import { useColors } from "@/theme";
import { Icon, type IconName } from "@/ui/Icon";
import { ProgressSegments } from "@/ui/Progress";
import { T } from "@/ui/Text";
import { useNow } from "@/staff/data";
import { dm, hm, roundsCounts, roundsMatch, roundsWards, WORK_KINDS, type RoundsFilter, type RoundsPerson } from "@/staff/model";
import { heads } from "@/staff/people";
import { ReviewSheet } from "@/staff/ReviewSheet";
import { StaffOnly } from "@/staff/StaffOnly";
import { Avatar, BandIcon, Card, Chip, Line, Loading, PillRow, RiskNow, SearchField, Section, StaffTop, StateBlock } from "@/staff/ui";
import { visitedToday } from "@/staff/visited";

/**
 * Обход.
 *
 * Планшет в палате вместо ноутбука. Отличие от очереди работы в консоли не в
 * данных, а в порядке: обход идут по палатам, а не по видам работы, поэтому
 * список сгруппирован по подразделениям — иначе на каждого второго пациента
 * приходилось бы возвращаться в тот же коридор. Строка — человек, а не вид
 * работы: к койке подходят один раз (staff/model.ts, roundsWards).
 *
 * Список и открытые карты кладутся в кэш: сети в отделении нет чаще, чем есть.
 * Возраст кэша показывается прямо в шапке — молча показанная вчерашняя очередь
 * хуже пустого экрана, потому что по ней ходят как по сегодняшней.
 *
 * Сверху — самый срочный сигнал ризику с часами до нормы: его разбирают
 * здесь же, в листе снизу, не уходя с обхода.
 */
export default function RoundsTab() {
  // пациенту по ссылке — его «Головна», а не обход с запросами сотрудника (staff/StaffOnly.tsx)
  return (
    <StaffOnly>
      <RoundsScreen />
    </StaffOnly>
  );
}

function RoundsScreen() {
  const { ut } = useLang();
  const c = useColors();
  const router = useRouter();
  const now = useNow();

  /*
   * Каталог методик — на устройство заранее, раз за сессию: «Заповнити» у
   * койки без сети берёт список и содержимое методик из кэша (api/client.ts,
   * listSurveys → prefetchSurveys), а обход — первый экран сотрудника.
   *
   * Прежде этот же запрос шёл ради нормы разбора (общий хук индекса
   * методик) — здесь, на «Пацієнтах», «Сигналах» и при каждом открытии
   * карты. Норма теперь приходит со случаем (model.ts, normOf), а прогрев
   * офлайна остался один и назван своим именем.
   */
  useEffect(() => {
    void api.listSurveys().catch(() => {});
  }, []);

  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [visited, setVisited] = useState<Set<string>>(() => visitedToday());
  const [filter, setFilter] = useState<RoundsFilter>("all");
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [urgent, setUrgent] = useState<AlertCase | null>(null);
  const [review, setReview] = useState<AlertCase | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setVisited(visitedToday());
    // самый срочный открытый случай — очередь сервера уже стоит по срочности
    void api
      .alertCases({ limit: "1" })
      .then((p) => setUrgent(p.items[0] ?? null))
      .catch(() => setUrgent(null));
    try {
      const { list, cachedAt: at } = await api.rounds();
      setItems(list.items);
      setCachedAt(at);
      setLoadedAt(new Date());
      setError(null);
    } catch (e) {
      // отказ доступа — показанный список больше не положен (#126); без сети — остаётся
      setItems((shown) => shownAfterFailure(shown, e));
      setCachedAt((at) => shownAfterFailure(at, e));
      setError(e instanceof Error ? e.message : ut("rounds.loadFailed"));
    } finally {
      setBusy(false);
    }
  }, [ut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const wards = useMemo(() => roundsWards(items ?? [], visited), [items, visited]);
  const counts = useMemo(() => roundsCounts(wards), [wards]);
  const needle = query.trim().toLowerCase();
  const shown = wards
    .map((w) => ({ ...w, people: w.people.filter((p) => roundsMatch(p, filter) && (!needle || p.userName.toLowerCase().includes(needle))) }))
    .filter((w) => w.people.length > 0);

  const pills = [
    { key: "all" as const, label: ut("mal.all"), count: counts.all },
    { key: "overdue" as const, label: ut("mst.fOverdue"), count: counts.overdue },
    ...WORK_KINDS.filter((k) => counts[k] > 0).map((k) => ({ key: k, label: ut(`mst.f.${k}`), count: counts[k] })),
    { key: "visited" as const, label: ut("mst.fVisited"), count: counts.visited },
  ];

  const top = (
    <StaffTop
      title={ut("rounds.title")}
      lead={ut("mst.roundsLead")}
      actions={<BandIcon icon="search" label={ut("mst.searchList")} pressed={searching} onPress={() => setSearching((s) => !s)} />}
    >
      <View style={{ gap: 10 }}>
        {searching ? <SearchField value={query} onChange={setQuery} placeholder={ut("mst.searchName")} autoFocus /> : null}
        {items ? (
          <View style={{ paddingTop: 12, paddingBottom: 13, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: c.bcardline, backgroundColor: c.bcard }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <T v="body" size={15} weight={800} num style={{ flex: 1 }}>
                {ut("mst.visitedOf").replace("{n}", String(counts.visited)).replace("{of}", String(counts.all))}
              </T>
              <Icon name={cachedAt ? "cloud-off" : "cloud-check"} size={15} color={cachedAt ? c.warn : c.good} />
              <T v="sub" size={13.5} color={cachedAt ? c.warn : c.text2} num>
                {cachedAt
                  ? ut("mst.offlineAt").replace("{d}", `${dm(cachedAt)}, ${hm(cachedAt)}`)
                  : loadedAt
                    ? ut("mst.updatedAt").replace("{t}", hm(loadedAt))
                    : ""}
              </T>
            </View>
            {counts.all > 0 ? (
              <ProgressSegments total={counts.all} current={-1} done={counts.visited} accessibilityLabel={ut("mst.visitedOf").replace("{n}", String(counts.visited)).replace("{of}", String(counts.all))} />
            ) : null}
          </View>
        ) : null}
      </View>
    </StaffTop>
  );

  if (!items) {
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        {top}
        {error ? <StateBlock icon="circle-alert" title={error} action={{ label: ut("common.retry"), onPress: () => void load() }} /> : <Loading />}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      {top}
      <ScrollView
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void load()} tintColor={c.vink} />}
      >
        {urgent ? <RiskNow item={urgent} now={now} onReview={() => setReview(urgent)} /> : null}

        {items.length === 0 ? (
          <StateBlock icon="circle-check" title={ut("rounds.empty")} text={ut("rounds.emptyHint")} />
        ) : (
          <>
            <PillRow items={pills} value={filter} onChange={setFilter} />
            {shown.map((w) => (
              <View key={w.unit ?? ""}>
                <Section title={w.unit ?? ut("rounds.noUnit")} count={w.people.length} />
                <Card>
                  {w.people.map((p, i) => (
                    <PersonRow
                      key={p.userId}
                      p={p}
                      first={i === 0}
                      onPress={() => {
                        // карта у койки покажет имя сразу, пока сама идёт (staff/people.ts)
                        heads.noteRow(activeOwner(), p.userId, { name: p.userName, unit: p.unit });
                        router.push(`/rounds/${p.userId}`);
                      }}
                    />
                  ))}
                </Card>
              </View>
            ))}
            {shown.length === 0 ? (
              <StateBlock
                title={ut("mst.nobodyFilter")}
                text={ut("mst.nobodyFilterHint")}
                action={{
                  label: ut("mst.showAll"),
                  onPress: () => {
                    setFilter("all");
                    setQuery("");
                  },
                }}
              />
            ) : null}
            <Line icon="wifi-off">{ut("rounds.hint")}</Line>
          </>
        )}
      </ScrollView>
      <ReviewSheet
        item={review}
        onClose={() => setReview(null)}
        onDone={() => {
          setReview(null);
          void load();
        }}
      />
    </View>
  );
}

const KIND_ICON: Record<WorkItem["kind"], IconName> = {
  noshow: "calendar-x-2",
  message: "message-square-text",
  followup: "clipboard-check",
  assignment: "clipboard-list",
  dispensary: "calendar-clock",
  referral: "file-text",
};

/** Что за строкой обхода словами: вид работы и его подробность */
function useWhat() {
  const { ut } = useLang();
  return (i: WorkItem): string => {
    switch (i.kind) {
      case "referral":
        return [i.destination ? ut(`dest.${i.destination}` as UiKey, i.destination) : null, i.title === "created" ? ut("mst.refCreated") : ut("mst.refAccepted")]
          .filter(Boolean)
          .join(", ");
      case "message":
        return `${ut("work.msgUnread")} ${i.signals ?? 1}`;
      case "noshow":
        return (i.signals ?? 0) > 1 ? `${ut("work.noshowTimes")} ${i.signals}` : ut("work.noshowOnce");
      default:
        return i.title;
    }
  };
}

/**
 * Человек в обходе: что от специалиста ждут по нему, по строке на вид
 * работы, и плашка срока — «прострочено 3 дн.» жёлтым, это внимание, а не
 * риск. Отмеченный «відвідано» — приглушённым кружком и зелёной отметкой.
 */
function PersonRow({ p, first, onPress }: { p: RoundsPerson; first: boolean; onPress: () => void }) {
  const c = useColors();
  const { ut } = useLang();
  const what = useWhat();
  const worst = p.items[0]!;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${p.userName}. ${p.items.map((i) => `${ut(`mst.kind.${i.kind}`)}: ${what(i)}`).join(". ")}`}>
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
            backgroundColor: pressed ? c.panel2 : "transparent",
          }}
        >
          <Avatar name={p.userName} muted={p.visited} />
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <T v="headline">{p.userName}</T>
            {p.visited ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Icon name="check-check" size={14} color={c.good} />
                <T v="sub" weight={700} color={c.good}>
                  {ut("mst.visited")}
                </T>
              </View>
            ) : null}
            {p.items.slice(0, 3).map((i) => (
              <View key={`${i.kind}:${i.id}`} style={{ flexDirection: "row", gap: 6 }}>
                <View style={{ marginTop: 3 }}>
                  <Icon name={KIND_ICON[i.kind]} size={16} color={i.overdue && (i.kind === "noshow" || i.kind === "referral") ? c.warn : c.muted} />
                </View>
                <T v="note" style={{ flex: 1 }}>
                  <T v="note" weight={700} tone="text">
                    {`${ut(`mst.kind.${i.kind}`)}: `}
                  </T>
                  {what(i)}
                </T>
              </View>
            ))}
            {p.items.length > 3 ? <T v="sub">{ut("mal.andMore").replace("{n}", String(p.items.length - 3))}</T> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
              {worst.overdue ? (
                <Chip kind="warn" icon="clock" label={ut("mst.overdueDays").replace("{n}", String(worst.days ?? 0))} />
              ) : (worst.days ?? 0) > 0 ? (
                <Chip icon="calendar" label={ut("mst.daysWaiting").replace("{n}", String(worst.days))} />
              ) : null}
            </View>
          </View>
          <View style={{ alignSelf: "center" }}>
            <Icon name="chevron-right" size={20} color={c.muted} />
          </View>
        </View>
      )}
    </Pressable>
  );
}
