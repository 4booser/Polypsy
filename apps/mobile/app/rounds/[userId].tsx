import { useCallback, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { AlertCase, RespondentDynamics, Worklist } from "@quizzy/shared";
import { api } from "@/api/client";
import { isAccessDenied, shownAfterFailure } from "@/api/access";
import { cache } from "@/offline/cache";
import { activeOwner } from "@/offline/owner";
import { useLang } from "@/lang";
import { useColors } from "@/theme";
import { ActionBar, Btn } from "@/ui/Button";
import { Callout } from "@/ui/Panel";
import { useNow, useOpenCase, useSurveyContents, useSurveyIndex } from "@/staff/data";
import { dm, hm, instrumentRows, shortName } from "@/staff/model";
import { ReviewSheet } from "@/staff/ReviewSheet";
import { PatientHead, WorkStrip } from "@/staff/patient";
import { BandIcon, Card, InstrumentLine, Line, LinkButton, Loading, RiskNow, Section, StaffNav, StateBlock } from "@/staff/ui";
import { flipVisited, visitedToday } from "@/staff/visited";

/**
 * Карта пациента в обходе.
 *
 * Открывается из списка обхода и работает по кэшу, если сети нет: в палате её
 * нет чаще, чем есть. Возраст снимка написан прямо сверху — карта из вчера
 * выглядит так же, как сегодняшняя, и это опаснее пустого экрана.
 *
 * Показывается только то, что нужно у койки: сигнал ризику с часами до
 * нормы, что от специалиста ждут по этому человеку, последний балл по каждой
 * шкале с выраженностью словом и сдвигом от старта. Полная динамика с
 * графиками — в карте пациента: на обходе её листать некогда.
 */
export default function RoundsCardScreen() {
  const { ut } = useLang();
  const c = useColors();
  const router = useRouter();
  const now = useNow();
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const { norm } = useSurveyIndex();
  const { open, reload: reloadCase } = useOpenCase(userId);

  const [data, setData] = useState<RespondentDynamics | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visited, setVisited] = useState(() => visitedToday().has(userId ?? ""));
  const [review, setReview] = useState<AlertCase | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const { card, cachedAt: at } = await api.roundsCard(userId);
      setData(card);
      setCachedAt(at);
      setError(null);
    } catch (e) {
      /*
       * Отказ доступа (#126) — карта, открытая раньше, больше не положена:
       * экран её сбрасывает и показывает ошибку. Без сети показанное остаётся.
       */
      setData((shown) => shownAfterFailure(shown, e));
      setCachedAt((at) => shownAfterFailure(at, e));
      setError(isAccessDenied(e) || !(e instanceof Error) ? ut("rounds.loadFailed") : e.message);
    }
  }, [userId, ut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // что от специалиста ждут по этому человеку — из снимка обхода, он есть и без сети
  const work = useMemo(() => {
    const saved = cache.rounds(activeOwner())?.rows as Worklist | undefined;
    return (saved?.items ?? []).filter((i) => i.userId === userId);
  }, [userId, data]);
  const contents = useSurveyContents(data?.surveys.map((s) => s.surveyId) ?? []);
  const rows = useMemo(() => (data ? instrumentRows(data, (id) => contents.get(id)) : []), [data, contents]);
  const dates = useMemo(() => {
    const all = new Set<string>();
    for (const r of rows) all.add(r.last.submittedAt.slice(0, 10));
    return [...all].sort().slice(-3).map((d) => dm(d));
  }, [rows]);

  const unit = work.find((w) => w.unit)?.unit ?? null;
  const back = ut("rounds.title");
  const openFull = () => router.push({ pathname: "/analytics/patients/[userId]", params: { userId: userId!, back: "rounds" } });

  if (!data) {
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <StaffNav back={back} title={ut("rounds.title")} />
        {error ? <StateBlock icon="circle-alert" title={error} action={{ label: ut("common.retry"), onPress: () => void load() }} /> : <Loading />}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <StaffNav back={back} title={shortName(data.fullName)} right={<BandIcon icon="user-round" label={ut("mst.openCard")} onPress={openFull} />}>
        <PatientHead name={data.fullName} age={data.age} sex={data.sex} extra={unit} />
      </StaffNav>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        {cachedAt ? (
          /*
           * Сети нет — работаем по снимку. Отметка обязательна: обход по
           * вчерашней карте выглядит точно так же, как по сегодняшней.
           */
          <View style={{ marginHorizontal: 16, marginTop: 16 }}>
            <Callout kind="warn" icon="wifi-off" title={ut("mst.noNetwork")} text={`${ut("rounds.cardOffline")} ${dm(cachedAt)}, ${hm(cachedAt)}`}>
              <View style={{ marginTop: 8, alignSelf: "flex-start" }}>
                <Btn title={ut("mst.refresh")} kind="outline" size="s" icon="refresh-cw" onPress={() => void load()} />
              </View>
            </Callout>
          </View>
        ) : null}

        {open ? (
          <RiskNow
            item={open}
            norm={norm(open.surveyId)}
            now={now}
            text={[`${open.surveyTitle}, ${dm(open.lastAlertAt)}, ${hm(open.lastAlertAt)}`, open.signals[0]?.label].filter(Boolean).join(": ")}
            onReview={() => setReview(open)}
          />
        ) : null}

        <WorkStrip items={work} />

        <Section
          title={ut("mst.lastMeasures")}
          count={rows.length}
          right={<LinkButton label={ut("mst.allDynamics")} onPress={openFull} />}
          sub={dates.length ? dates.join(", ") : undefined}
        />
        {rows.length ? (
          <Card>
            {rows.map((r, i) => (
              <InstrumentLine key={r.key} row={r} first={i === 0} />
            ))}
          </Card>
        ) : (
          <StateBlock title={ut("rounds.noData")} />
        )}
        <Line>{ut("mst.bedsideHint")}</Line>
      </ScrollView>

      <ActionBar>
        {/* «Відвідано» — память обходящего на этом устройстве, не запись в карте (staff/visited.ts) */}
        <Btn
          title={ut("mst.visitedBtn")}
          size="m"
          icon={visited ? "check-check" : "check"}
          kind={visited ? "outline" : "secondary"}
          accessibilityLabel={ut(visited ? "mst.visitedOn" : "mst.visitedOff")}
          accessibilityHint={ut("mst.visitedHint")}
          onPress={() => setVisited(flipVisited(userId!).has(userId!))}
        />
        {/*
          Заполнить методику за пациента — главное действие у койки: человек
          лежит рядом, а не сидит с телефоном. Ведёт в обычный список методик,
          где выбор уже привязан к этому пациенту.
        */}
        <Btn title={ut("rounds.fill")} kind="primary" size="m" flex={1} onPress={() => router.push(`/(app)/surveys?onBehalfOf=${userId}`)} />
      </ActionBar>

      <ReviewSheet
        item={review}
        norm={review ? norm(review.surveyId) : null}
        onClose={() => setReview(null)}
        onDone={() => {
          setReview(null);
          reloadCase();
        }}
      />
    </View>
  );
}

