import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { pointShare, pointValueText, pointValueTop } from "@quizzy/shared";
import type { AlertCase, RespondentDynamics, Severity, Worklist } from "@quizzy/shared";
import { isAborted } from "@/api/abort";
import { api } from "@/api/client";
import { useReads } from "@/api/useReads";
import { PercentileBar } from "@/components/charts-extra";
import { CourseChart, RadarChart } from "@/components/viz";
import { localDecimal } from "@/components/viz/math";
import { cache } from "@/offline/cache";
import { activeOwner } from "@/offline/owner";
import { useLang } from "@/lang";
import { useOpenReport } from "@/report/useOpenReport";
import { useColors } from "@/theme";
import { Btn } from "@/ui/Button";
import { Icon, type IconName } from "@/ui/Icon";
import { Panel } from "@/ui/Panel";
import { SevPill } from "@/ui/Pill";
import { Segmented } from "@/ui/Segmented";
import { T } from "@/ui/Text";
import { useNow, useOpenCase, usePersonHead, useSurveyContents } from "@/staff/data";
import { bandsOf, changeVerdict, courseInput, dm, hm, instrumentRows, num, reliableThreshold, shortName, STEP_OF } from "@/staff/model";
import { PatientHead, WorkStrip } from "@/staff/patient";
import { heads } from "@/staff/people";
import { ReviewSheet } from "@/staff/ReviewSheet";
import { InstrumentLine, Line, LinkButton, Loading, PillRow, RiskNow, StaffNav, StateBlock } from "@/staff/ui";

type Tab = "overview" | "dynamics";

const BACK = { patients: "mnav.patients", rounds: "rounds.title", alerts: "mst.tabAlerts" } as const;

/**
 * Карта пациента на телефоне — компактная карта консоли.
 *
 * «Огляд»: быстрые действия (написать, заполнить за пациента, заключение),
 * сигнал ризику с часами до нормы, открытое по человеку строкой плашек,
 * последний балл каждой шкалы со сравнением и курс главной шкалы.
 * «Динаміка»: выбор шкалы, график курса с полосами тяжести, межами похибки
 * и сигналом на оси (viz/CourseChart), последний замер с перцентилем и
 * профиль шкал «перший проти останнього».
 *
 * Единицы — общие с консолью (#199): доля профиля — pointShare, подпись
 * значения — pointValueText, верх оси — pointValueTop: у стенов и T-баллов
 * сырой максимум не годится.
 */
export default function PatientCardScreen() {
  const { ut } = useLang();
  const c = useColors();
  const router = useRouter();
  const now = useNow();
  const { userId, back } = useLocalSearchParams<{ userId: string; back?: string }>();
  const { open, reload: reloadCase } = useOpenCase(userId);
  // заключение по замеру — одноразовой ссылкой в браузере (src/report)
  const report = useOpenReport();
  /*
   * Шапка — сразу, из строки, на которую нажали, снимка обхода или карты у
   * койки (staff/people.ts): динамика идёт секунды, и всё это время полоса
   * стояла пустой, без имени.
   */
  const head = usePersonHead(userId);
  const reads = useReads();

  const [data, setData] = useState<RespondentDynamics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [pick, setPick] = useState<string | null>(null);
  const [review, setReview] = useState<AlertCase | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    const signal = reads.next();
    try {
      const card = await api.respondentDynamics(userId, { signal });
      setData(card);
      setError(null);
      // «Заповнити» отсюда знает человека без второго чтения его истории (staff/data.ts, useFillSubject)
      heads.noteCard(activeOwner(), userId, { fullName: card.fullName, sex: card.sex, age: card.age });
    } catch (e) {
      // ушли с карты, пока динамика шла (api/abort.ts) — показывать нечего и некому
      if (isAborted(e)) return;
      setError(e instanceof Error ? e.message : ut("mdy.loadFailed"));
    }
  }, [userId, ut, reads]);

  // уход с карты обрывает чтение динамики; вернулись — читаем заново
  useFocusEffect(
    useCallback(() => {
      void load();
      return reads.cancel;
    }, [load, reads]),
  );

  const contents = useSurveyContents(data?.surveys.map((s) => s.surveyId) ?? []);
  const rows = useMemo(() => (data ? instrumentRows(data, (id) => contents.get(id)) : []), [data, contents]);
  const work = useMemo(() => ((cache.rounds(activeOwner())?.rows as Worklist | undefined)?.items ?? []).filter((i) => i.userId === userId), [userId, data]);

  // главная шкала — с наибольшим числом замеров: на ней курс виден лучше всего
  const main = useMemo(() => [...rows].sort((a, b) => b.count - a.count)[0] ?? null, [rows]);
  const current = rows.find((r) => r.key === pick) ?? main;
  const backLabel = ut(BACK[back as keyof typeof BACK] ?? "common.back");

  if (!data) {
    // ошибка — без имени: карта может быть уже не положена (вывели из зоны), и строке с ним не место рядом с отказом
    const hint = error ? null : head;
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <StaffNav back={backLabel}>{hint ? <PatientHead name={hint.name} age={hint.age} sex={hint.sex} /> : null}</StaffNav>
        {error ? <StateBlock icon="circle-alert" title={error} action={{ label: ut("common.retry"), onPress: () => void load() }} /> : <Loading />}
      </View>
    );
  }

  const tabs = (
    <Segmented
      onBand
      value={tab}
      onChange={setTab}
      accessibilityLabel={ut("mst.cardSections")}
      options={[
        { value: "overview", label: ut("mst.overview") },
        { value: "dynamics", label: ut("msv.dynamics") },
      ]}
    />
  );

  const lastResponse = rows.reduce<string | null>((acc, r) => (!acc || r.last.submittedAt > (rows.find((x) => x.last.responseId === acc)?.last.submittedAt ?? "") ? r.last.responseId : acc), null);

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      {tab === "overview" ? (
        <StaffNav back={backLabel}>
          <View style={{ gap: 14 }}>
            <PatientHead name={data.fullName} age={data.age} sex={data.sex} />
            {tabs}
          </View>
        </StaffNav>
      ) : (
        <StaffNav back={backLabel} title={shortName(data.fullName)}>
          {tabs}
        </StaffNav>
      )}

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        {tab === "overview" ? (
          <>
            <View style={{ flexDirection: "row", gap: 8, marginHorizontal: 16, marginTop: 16 }}>
              <Quick icon="message-square-text" label={ut("mst.write")} onPress={() => router.push(`/inbox/${userId}`)} />
              <Quick icon="clipboard-check" label={ut("mst.fill")} onPress={() => router.push(`/(app)/surveys?onBehalfOf=${userId}`)} />
              <Quick icon="file-text" label={ut("mst.conclusion")} disabled={!lastResponse || report.opening} onPress={() => lastResponse && report.open(lastResponse)} />
            </View>

            {open ? (
              <RiskNow
                item={open}
                now={now}
                text={[`${open.surveyTitle}, ${dm(open.lastAlertAt)}, ${hm(open.lastAlertAt)}`, open.signals[0]?.label].filter(Boolean).join(": ")}
                onReview={() => setReview(open)}
              />
            ) : null}
            <WorkStrip items={work} />

            {rows.length === 0 ? (
              <StateBlock title={ut("mdy.noCompleted")} />
            ) : (
              <View style={{ marginHorizontal: 16, marginTop: 16, gap: 16 }}>
                <Panel title={ut("mst.instruments")} icon="clipboard-list" sub={ut("mst.measuresN").replace("{n}", String(rows.reduce((s, r) => s + r.count, 0)))} pad={false}>
                  {rows.map((r, i) => (
                    <InstrumentLine
                      key={r.key}
                      row={r}
                      first={i === 0}
                      onPress={() => {
                        setPick(r.key);
                        setTab("dynamics");
                      }}
                    />
                  ))}
                </Panel>
                {main && main.count > 1 ? (
                  <Panel
                    title={ut("mst.course")}
                    icon="chart-line"
                    sub={main.code || main.title}
                    right={
                      <LinkButton
                        label={ut("mst.allDynamics")}
                        onPress={() => {
                          setPick(main.key);
                          setTab("dynamics");
                        }}
                      />
                    }
                  >
                    <Course data={data} rowKey={main.key} contents={contents} open={open} now={now} />
                  </Panel>
                ) : null}
              </View>
            )}
          </>
        ) : (
          <>
            {rows.length > 1 ? (
              <PillRow
                value={current?.key ?? ""}
                onChange={setPick}
                items={rows.map((r) => ({ key: r.key, label: `${r.code || r.title} ${num(r.last.rawScore)}` }))}
              />
            ) : null}
            {current ? (
              <>
                <Line>
                  {ut("mst.measuresRange")
                    .replace("{n}", String(current.count))
                    .replace("{a}", dm(data.surveys.find((s) => s.surveyId === current.surveyId)?.firstAt ?? current.last.submittedAt))
                    .replace("{b}", dm(current.last.submittedAt))}
                </Line>
                <View style={{ marginHorizontal: 16, marginTop: 12, gap: 16 }}>
                  <Panel title={ut("mst.course")} icon="chart-line" sub={current.title}>
                    {current.count > 1 ? (
                      <Course data={data} rowKey={current.key} contents={contents} open={open} now={now} />
                    ) : (
                      <T v="note">{ut("mpa.needSecond")}</T>
                    )}
                  </Panel>
                  <LastMeasure data={data} rowKey={current.key} contents={contents} opening={report.opening} onReport={(id) => report.open(id)} />
                  <Profile data={data} surveyId={current.surveyId} />
                </View>
              </>
            ) : (
              <StateBlock title={ut("mdy.noCompleted")} />
            )}
          </>
        )}
      </ScrollView>

      <ReviewSheet
        item={review}
        dynamics={data}
        onClose={() => setReview(null)}
        onDone={() => {
          setReview(null);
          reloadCase();
        }}
      />
    </View>
  );
}

/** Быстрое действие карты: значок в квадрате и подпись */
function Quick({ icon, label, onPress, disabled }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: "center",
        gap: 6,
        paddingTop: 10,
        paddingBottom: 9,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: pressed ? c.ctl : c.border,
        backgroundColor: pressed ? c.panel2 : c.panel,
        opacity: disabled ? 0.48 : 1,
      })}
    >
      <View style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: c.vtint, alignItems: "center", justifyContent: "center" }}>
        <Icon name={icon} size={19} color={c.vink} />
      </View>
      <T v="sub" size={13} weight={700} color={c.vink} scale={false} numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}

type Contents = ReturnType<typeof useSurveyContents>;

function findScale(data: RespondentDynamics, rowKey: string) {
  const [surveyId, scaleId] = rowKey.split(":");
  const sv = data.surveys.find((s) => s.surveyId === surveyId);
  return { sv, sc: sv?.scales.find((s) => s.scaleId === scaleId) };
}

/** График курса одной шкалы: полосы методики, межі похибки, сигнал на оси */
function Course({ data, rowKey, contents, open, now }: { data: RespondentDynamics; rowKey: string; contents: Contents; open: AlertCase | null; now: number }) {
  const { ut } = useLang();
  const { sv, sc } = findScale(data, rowKey);
  if (!sv || !sc) return null;
  const last = [...sc.points].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)).at(-1);
  const input = courseInput(sc, bandsOf(contents.get(sv.surveyId), sc), last ? pointValueTop(last) : null);
  /*
   * Сигнал — красной меткой на оси с подписью. Подпись сама уходит со слова
   * нижней полосы (viz/course.ts): влево от метки, строкой выше, а если
   * места нет нигде — остаётся одна метка, и что это сигнал, говорит легенда.
   */
  const signals = open && open.surveyId === sv.surveyId ? [{ t: Date.parse(open.lastAlertAt), label: ut("mui.signal") }] : [];
  return (
    <CourseChart
      points={input.points.map((p) => ({ ...p, step: p.severity ? STEP_OF[p.severity as Severity] : undefined }))}
      bands={input.bands}
      min={input.min}
      max={input.max}
      better={input.better ?? undefined}
      rc={input.rc}
      today={now}
      signals={signals}
      valueLabel={num}
    />
  );
}

/**
 * Последний замер: значение в своих единицах, выраженность словом, сдвиг
 * от старта с порогом надёжности и от предыдущего, перцентиль в выборке и
 * заключение по этому замеру.
 */
function LastMeasure({ data, rowKey, contents, opening, onReport }: { data: RespondentDynamics; rowKey: string; contents: Contents; opening: boolean; onReport: (responseId: string) => void }) {
  const { ut } = useLang();
  const c = useColors();
  const { sv, sc } = findScale(data, rowKey);
  if (!sv || !sc) return null;
  const pts = [...sc.points].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  const last = pts.at(-1);
  if (!last) return null;
  const first = pts[0]!;
  const prev = pts.at(-2);
  const rc = reliableThreshold(sc);
  const input = courseInput(sc, bandsOf(contents.get(sv.surveyId), sc), pointValueTop(last));
  const delta = pts.length > 1 && !sc.incomparable ? sc.delta : null;
  const verdict = delta === null ? null : changeVerdict(delta, rc, input.better);
  const sign = (d: number) => `${d > 0 ? "+" : d < 0 ? "−" : ""}${num(Math.abs(d))}`;
  return (
    <Panel title={ut("mdy.last")} icon="gauge" sub={`${sc.code || sc.title}, ${dm(last.submittedAt)}, ${hm(last.submittedAt)}`}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        {/* значение в своих единицах (pointValueText): число крупно, «з 27», «стен», «T-бал» — подписью */}
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
          {pointValueText(last, {
            of: ut("an.of"),
            norm: { raw: ut("norm.raw"), ratio: ut("norm.ratio"), tscore: ut("norm.tscore"), sten: ut("norm.sten") },
          })
            .split(" ")
            // числа общая подпись пишет с точкой — на экране дробь в формате языка: «частка 0,2» (viz/math.ts)
            .map((part) => (/^[\d.,−-]+%?$/.test(part) ? localDecimal(part) : part))
            .map((part, i, all) =>
              // крупно — само значение: первое число; «з 27» после него — подписью
              /^[\d.,−-]+%?$/.test(part) && all.findIndex((x) => /^[\d.,−-]+%?$/.test(x)) === i ? (
                <T key={i} v="number" size={40} num scale={false}>
                  {part}
                </T>
              ) : (
                <T key={i} v="body" size={17} weight={700} tone="muted" num scale={false}>
                  {part}
                </T>
              ),
            )}
        </View>
        {last.severity || last.bandLabel ? <SevPill severity={(last.severity ?? "none") as Severity} label={last.bandLabel ?? undefined} /> : null}
      </View>
      {delta !== null && verdict ? (
        <T v="note">
          <T v="note" weight={800} tone="text">
            {sign(delta)}
          </T>
          {` ${ut("mst.fromDate").replace("{d}", dm(first.submittedAt))}, ${ut(`mst.verdict.${verdict}`)}`}
          {rc !== null ? ` (${ut("mst.threshold").replace("{n}", num(rc))})` : ""}
          {prev && prev !== first ? `. ${ut("mst.fromDateCap").replace("{d}", dm(prev.submittedAt))}: ${sign(last.rawScore - prev.rawScore)}` : ""}
        </T>
      ) : sc.incomparable ? (
        <T v="note">{ut(`mst.incomparable.${sc.incomparable}`)}</T>
      ) : null}
      <View style={{ marginTop: 6, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.divider }}>
        {last.percentile !== null ? <PercentileBar percentile={last.percentile} /> : <T v="sub">{ut("mpa.noPercentile")}</T>}
      </View>
      <Btn title={ut("mdy.conclusion")} icon="file-text" full loading={opening} onPress={() => onReport(last.responseId)} style={{ marginTop: 6 }} />
    </Panel>
  );
}

/** Профиль шкал методики: в психодиагностике важна форма, а не отдельная шкала */
function Profile({ data, surveyId }: { data: RespondentDynamics; surveyId: string }) {
  const { ut } = useLang();
  const sv = data.surveys.find((s) => s.surveyId === surveyId);
  if (!sv || sv.scales.length < 3) return null;
  return (
    <Panel title={ut("mdy.profile")} icon="chart-line" sub={ut("mdy.lastVsFirst")}>
      <RadarChart
        labels={[ut("mdy.last"), ut("mdy.first")]}
        /*
         * Доля — сырой балл после поправок против максимума шкалы
         * (pointShare, одна запись с консолью): rawScore точки —
         * T-балл или стен, и делить его на максимум сырого балла
         * значило мерить в двух единицах (#199).
         */
        axes={sv.scales.map((sc) => {
          const p = sc.points[sc.points.length - 1];
          return { label: sc.title, value: p ? pointShare(p) : 0, raw: p?.rawScore ?? 0 };
        })}
        compare={
          sv.scales.some((sc) => sc.points.length > 1)
            ? sv.scales.map((sc) => {
                const p = sc.points[0];
                return { label: sc.title, value: p ? pointShare(p) : 0, raw: p?.rawScore ?? 0 };
              })
            : undefined
        }
      />
    </Panel>
  );
}

