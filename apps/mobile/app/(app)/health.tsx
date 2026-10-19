import { useCallback, useState } from "react";
import { ScrollView, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { MyDynamics, SafetyPlan } from "@quizzy/shared";
import { isAborted } from "@/api/abort";
import { api } from "@/api/client";
import { useReads } from "@/api/useReads";
import { codeOf } from "@/catalog/surveysTab";
import { Loader } from "@/components/ui";
import { personName } from "@/components/patient/Avatar";
import { CodeTile } from "@/components/patient/CodeTile";
import { HistoryTiles, formatScore } from "@/components/patient/History";
import { Hero } from "@/components/patient/Hero";
import { useLang } from "@/lang";
import { useColors } from "@/theme";
import { Icon } from "@/ui/Icon";
import { List, ListRow, Panel, SectionHead, Squircle } from "@/ui/Panel";
import { SevPill } from "@/ui/Pill";
import { T } from "@/ui/Text";

type Scale = MyDynamics["surveys"][number]["scales"][number];
type Point = Scale["points"][number];

/**
 * Здоровье: как меняется и что делать, если станет тяжелее.
 *
 * Динамика живёт здесь, а не на главной, и это решение, а не раскладка.
 * Главный экран открывают по дороге на приём; свою кривую тревоги человек
 * смотрит в спокойную минуту. Каждый день видеть её первым делом — само по
 * себе вмешательство, и не то, ради которого он сюда пришёл.
 *
 * По каждой шкале — последнее значение со словом выраженности, сдвиг от
 * первого замера и последние замеры плитками. Графика нет: на телефоне по
 * трём точкам он показывает шум, а читается как тенденция. Хорошо ли
 * «меньше», зависит от шкалы, а сервер её полярность сюда не отдаёт, — поэтому
 * сдвиг назван числом и стрелкой, без «краще» и «гірше»: оценку даёт
 * специалист.
 */
export default function HealthScreen() {
  const c = useColors();
  const { ut, locale } = useLang();
  const router = useRouter();
  const [data, setData] = useState<MyDynamics | null | undefined>(undefined);
  const [plan, setPlan] = useState<SafetyPlan | null>(null);
  const reads = useReads();

  useFocusEffect(
    useCallback(() => {
      // динамика — медленное чтение: уход с вкладки его обрывает (api/useReads.ts), вернулись — читаем заново
      void api
        .myDynamics({ signal: reads.next() })
        .then(setData)
        .catch((e) => !isAborted(e) && setData(null));
      // план — без отмены: он ложится в кэш устройства на кризис без сети (api/client.ts, mySafetyPlan)
      void api
        .mySafetyPlan()
        .then((r) => setPlan(r.plan))
        .catch(() => {});
      return reads.cancel;
    }, [reads]),
  );

  if (data === undefined) return <Loader />;

  /*
   * Показываются только методики, где отделение разрешило показывать
   * результат человеку: сервер отдаёт лишь их. Список того, что скрыто, тоже
   * не показываем — иначе человек считал бы, сколько от него скрыли.
   */
  const surveys = data?.surveys ?? [];
  const blocks = surveys.flatMap((s) =>
    s.scales
      .filter((sc) => sc.points.length >= 2)
      .map((sc) => ({ survey: s, scale: sc, points: [...sc.points].sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1)) })),
  );
  const single = surveys.filter((s) => s.scales.length > 0 && s.scales.every((sc) => sc.points.length < 2));
  const allPoints = blocks.flatMap((b) => b.points);
  const firstAt = allPoints.reduce<string | null>((m, p) => (!m || p.submittedAt < m ? p.submittedAt : m), null);
  const day = (iso: string) => new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });

  return (
    <ScrollView style={{ backgroundColor: c.ground }} contentContainerStyle={{ paddingBottom: 24 }}>
      <Hero title={ut("tab.health")} lead={ut("mpt.hl.lead")} />

      {blocks.length ? (
        <Panel
          title={ut("mp.myDynamics")}
          icon="activity"
          sub={firstAt ? ut("mpt.hl.since").replace("{d}", day(firstAt)) : undefined}
          pad={false}
          style={{ marginTop: 16, marginHorizontal: 16 }}
        >
          {blocks.map((b) => {
            const multi = b.survey.scales.length > 1;
            const { name, code } = codeOf(b.survey.title);
            return (
              <ScaleBlock
                key={`${b.survey.surveyId}-${b.scale.code}`}
                title={multi ? b.scale.title : name}
                code={multi ? (code ?? b.survey.title) : code}
                points={b.points}
              />
            );
          })}
          <View style={{ flexDirection: "row", gap: 8, paddingVertical: 12, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: c.divider }}>
            <View style={{ marginTop: 3 }}>
              <Icon name="info" size={16} color={c.muted} />
            </View>
            <T v="note" weight={600} tone="text2" style={{ flex: 1 }}>
              {ut("msv.notDiagnosis")}
            </T>
          </View>
        </Panel>
      ) : (
        <View style={{ marginTop: 16, marginHorizontal: 16 }}>
          {/*
            «Сравнивать пока не с чем» — честнее, чем пустой график.
            Пустой график читается как «всё плохо и данных нет», а правда в
            том, что второго замера ещё не было.
          */}
          <Panel title={ut("mp.myDynamics")} icon="activity">
            <T v="note">{ut("hl.noDynamics")}</T>
          </Panel>
        </View>
      )}

      {single.length ? (
        <>
          <SectionHead title={ut("mpt.hl.noDynamicsYet")} />
          <List>
            {single.map((s, i) => {
              const { name, code } = codeOf(s.title);
              const last = s.scales[0]?.points.at(-1);
              return (
                <ListRow
                  key={s.surveyId}
                  first={i === 0}
                  title={name}
                  sub={[code, last ? ut("mpt.hl.once").replace("{d}", day(last.submittedAt)) : null].filter(Boolean).join(", ")}
                  body={ut("hl.noDynamics")}
                  lead={<CodeTile code={code} neutral />}
                />
              );
            })}
          </List>
        </>
      ) : null}

      <SectionHead title={ut("mpt.hl.ifHarder")} />
      <List>
        <ListRow
          first
          title={ut("home.safetyPlan")}
          sub={plan ? ut("mpt.hl.planSub").replace("{who}", personName(plan.authorName)).replace("{v}", String(plan.version)) : ut("mpt.hm.noPlan")}
          lead={<Squircle icon="shield-check" tone={plan ? "good" : "n"} />}
          chevron
          onPress={() => router.push("/safety")}
        />
      </List>
    </ScrollView>
  );
}

const fmt = formatScore;

/** Одна шкала: последнее значение со словом, сдвиг от первого замера, последние замеры плитками */
function ScaleBlock({ title, code, points }: { title: string; code: string | null; points: Point[] }) {
  const c = useColors();
  const { ut, locale } = useLang();
  const last = points.at(-1)!;
  const first = points[0]!;
  const delta = Math.round((last.value - first.value) * 10) / 10;
  const day = (iso: string) => new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
  return (
    <View style={{ paddingTop: 14, paddingHorizontal: 16, paddingBottom: 14, borderTopWidth: 1, borderTopColor: c.divider }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <T v="headline" size={17} style={{ flexShrink: 1 }}>
          {title}
        </T>
        {code ? (
          <T v="sub" weight={700} tone="muted">
            {code}
          </T>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
        <T v="number" size={40} num scale={false}>
          {fmt(last.value)}
        </T>
        {last.bandLabel || last.severity ? <SevPill severity={last.severity ?? undefined} label={last.bandLabel ?? undefined} /> : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 }}>
        <View style={{ width: 22, height: 22, borderRadius: 7, alignItems: "center", justifyContent: "center", backgroundColor: c.sunk }}>
          <Icon name={delta < 0 ? "arrow-down" : delta > 0 ? "arrow-up" : "arrow-right"} size={14} color={c.text2} />
        </View>
        <T v="note" weight={600} tone="text2" style={{ flex: 1 }}>
          <T v="note" weight={800}>
            {delta > 0 ? `+${fmt(delta)}` : delta < 0 ? `−${fmt(-delta)}` : "0"}
          </T>
          {` ${ut("mpt.hl.fromFirst").replace("{d}", day(first.submittedAt))}`}
        </T>
      </View>
      <HistoryTiles points={points} label={ut("mpt.hl.history")} />
    </View>
  );
}
