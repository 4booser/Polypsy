import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { SurveyFull } from "@quizzy/shared";
import { api } from "../api";
import { ChartLegend, Marker } from "../charts/kit";
import { useChartWidth } from "../charts";
import { axisFor } from "../charts/scale";
import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { Screen, useAction } from "../ui";
import { cx } from "../ui/cx";
import { Ic } from "../ui/icons";
import { Panel } from "../ui/layout";
import { MenuButton, menuItem } from "../ui/menu";
import { Tooltip } from "../ui/Popover";
import { Button, CheckLabel, Checkbox, Segmented, Switch, Tag } from "../ui/primitives";
import { Empty, Loading } from "../ui/states";
import { useResource } from "../useResource";
import { Mi } from "./methods/icons";
import { MethodPage } from "./methods/MethodPage";
import { T_SHIFT_LIMIT, tShift } from "./methods/model";
import { num } from "./methods/useCount";

/*
 * Локальні норми — UI 3, «Виразна» (methods-norms).
 *
 * Нормы пособий сняты с мирной популяции; на военной выборке они плывут.
 * Экран сравнивает M/SD сырого балла пособия с выборкой учреждения по
 * полу, показывает сдвиг среднего T (полоса ±5 T — граница, за которой
 * выборка систематически отличается) и даёт перевести шкалы на локальные
 * нормы. Публикация создаёт новую версию методики: собранные прохождения
 * остаются на нормах своей версии, а происхождение каждой нормы
 * («посібник» или «локальна вибірка, N = …») печатается в подсказках и SPSS.
 *
 * Вторая вкладка — вікові криві: медіана T за віком у вибірці установи
 * (P50 скользящего окна; ширина окна — сервера, и она честно подписана).
 */

type Data = Awaited<ReturnType<typeof api.normCandidates>>;
type Scale = Data["scales"][number];
type Tab = "table" | "curves";

const SEX_KEY = { male: "nm.men", female: "nm.women" } as const;
const sexes = ["male", "female"] as const;

export default function Norms() {
  const { id } = useParams<{ id: string }>();
  const res = useResource(
    async () => {
      const [survey, norms, groups, folders] = await Promise.all([
        api.survey(id!),
        api.normCandidates(id!),
        api.groups().catch(() => null),
        api.surveyFolders().catch(() => null),
      ]);
      return { survey, norms, groups, folders };
    },
    [id],
    { enabled: !!id },
  );
  return (
    <Screen res={res}>
      {({ survey, norms, groups, folders }) => (
        <MethodPage survey={survey} groups={groups} folders={folders} tab="norms" assignPrimary={false}>
          <NormsBody survey={survey} data={norms} onPublished={res.reload} />
        </MethodPage>
      )}
    </Screen>
  );
}

const f1 = (v: number) => v.toFixed(1).replace(".", ",");
const signed1 = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${f1(Math.abs(v))}`;

function NormsBody({ survey, data, onPublished }: { survey: SurveyFull; data: Data; onPublished: () => void }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const { run, busy } = useAction();
  const [tab, setTab] = useState<Tab>("table");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [checkKeys, setCheckKeys] = useState(true);
  const kindOf = useMemo(() => new Map(survey.scales.map((s) => [s.code, s.kind] as const)), [survey.scales]);

  /* выборка: люди, а не проходження — у каждой шкалы одна и та же, берётся наибольшее */
  const nOf = (sex: "male" | "female" | null) =>
    Math.max(0, ...data.scales.map((s) => s.candidate.find((g) => g.sex === sex)?.n ?? 0));
  const men = nOf("male");
  const women = nOf("female");
  const whole = nOf(null) || men + women;
  const enoughMen = data.scales.some((s) => s.candidate.some((g) => g.sex === "male" && g.publishable));
  const enoughWomen = data.scales.some((s) => s.candidate.some((g) => g.sex === "female" && g.publishable));
  const publishableSexes = (s: Scale) => sexes.filter((x) => s.candidate.some((g) => g.sex === x && g.publishable));
  const sources = [...new Set(data.scales.flatMap((s) => s.current.map((c) => c.source).filter((x): x is string => !!x)))];

  const pickedScales = data.scales.filter((s) => picked.has(s.code));
  const pickedSexes = [...new Set(pickedScales.flatMap(publishableSexes))];

  const publish = () =>
    void run(async () => {
      await api.applyNorms(survey.id, [...picked]);
      setPicked(new Set());
      onPublished();
      if (checkKeys) navigate(`/surveys/${survey.id}/key`);
    }, ut("nm.published"));

  return (
    <>
      <div className="mb-4 grid grid-cols-[minmax(0,1fr)_340px] items-stretch gap-4 max-[1180px]:grid-cols-1">
        <Panel
          title={ut("nm.title")}
          icon={<ShellIcon name="ruler" />}
          sub={ut("mc.nmSub")}
          actions={
            <Segmented
              label={ut("mc.nmView")}
              value={tab}
              onChange={setTab}
              items={[
                { key: "table", label: ut("nm.tabPoolVsSample") },
                { key: "curves", label: ut("nm.tabAgeCurves") },
              ]}
            />
          }
        >
          <dl className="m-0 grid grid-cols-2 gap-x-6 max-[700px]:grid-cols-1">
            <Fact title={ut("mc.nmSample")} sub={ut("mc.nmSampleSub")} value={num(whole)} />
            <Fact
              title={ut("mc.nmLeftOut")}
              sub={ut("mc.nmLeftOutSub")}
              value={data.unreliable === null ? ut("mc.nmFew") : num(data.unreliable)}
            />
            <Fact
              title={<SexMark sex="male">{ut("nm.menCap")}</SexMark>}
              sub={enoughMen ? ut("mc.nmEnough") : ut("mc.nmTooFew").replace("{n}", String(data.minGroup))}
              value={num(men)}
              warn={!enoughMen && men > 0}
            />
            <Fact
              title={<SexMark sex="female">{ut("nm.womenCap")}</SexMark>}
              sub={enoughWomen ? ut("mc.nmEnough") : ut("mc.nmTooFew").replace("{n}", String(data.minGroup))}
              value={num(women)}
              warn={!enoughWomen && women > 0}
            />
          </dl>
          <p className="m-0 mt-3 text-small text-muted">{ut("stats.normsBasis")}</p>
        </Panel>
        <Panel title={ut("mc.nmPublish")} icon={<Mi.upload />}>
          <p className="m-0 text-small text-text-2">{ut("mc.nmPublishText").replace("{v}", String(survey.versionNumber + 1))}</p>
          <div className="mt-3 flex flex-col gap-2">
            <CheckLabel
              control={<Checkbox checked={picked.size > 0} disabled={picked.size === 0} onChange={() => setPicked(new Set())} />}
              label={
                picked.size
                  ? ut("mc.nmPicked")
                      .replace("{n}", String(picked.size))
                      .replace("{sexes}", pickedSexes.map((x) => ut(SEX_KEY[x])).join(", "))
                      .replace("{codes}", pickedScales.map((s) => s.code).join(", "))
                  : ut("mc.nmPickHint")
              }
            />
            <CheckLabel control={<Checkbox checked={checkKeys} onChange={(e) => setCheckKeys(e.target.checked)} />} label={ut("nm.checkKeys")} />
          </div>
          <Button variant="primary" icon={<Mi.upload />} className="mt-4 w-full" disabled={!picked.size || busy} onClick={publish}>
            {picked.size ? ut("mc.nmPublishN").replace("{n}", String(picked.size)) : ut("mc.nmPublishNone")}
          </Button>
        </Panel>
      </div>

      {tab === "table" ? (
        data.scales.length ? (
          <Panel
            title={ut("nm.tabPoolVsSample")}
            icon={<Mi.table />}
            hint={ut("mc.nmTableHint").replace("{n}", String(T_SHIFT_LIMIT))}
            actions={<ChartLegend className="mt-0" items={[{ key: "m", label: ut("nm.men"), color: "var(--c1)", kind: "mark", shape: "circle" }, { key: "w", label: ut("nm.women"), color: "var(--c2)", kind: "mark", shape: "square" }]} />}
            flush
            footer={
              <>
                {!enoughWomen || !enoughMen ? (
                  <span className="text-small text-muted">
                    <b className="text-warn">*</b> {ut("mc.nmStarNote").replace("{n}", String(data.minGroup))}
                  </span>
                ) : null}
                {sources.length ? <span className="ml-auto text-small text-muted">{ut("mc.nmSource").replace("{src}", sources.join(", "))}</span> : null}
              </>
            }
          >
            <NormTable
              scales={data.scales}
              kindOf={kindOf}
              picked={picked}
              onPick={(code, on) => {
                const next = new Set(picked);
                if (on) next.add(code);
                else next.delete(code);
                setPicked(next);
              }}
              publishableSexes={publishableSexes}
            />
          </Panel>
        ) : (
          <Panel>
            <Empty title={ut("nm.nothing")} hint={ut("nm.nothingHint")} />
          </Panel>
        )
      ) : (
        <AgeCurves surveyId={survey.id} />
      )}
    </>
  );
}

/** Позиция панели выборки: что, пояснение и число справа */
function Fact({ title, sub, value, warn }: { title: ReactNode; sub: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center gap-3 border-t border-divider py-2.5">
      <dt className="min-w-0 flex-1">
        <span className="block text-body font-semibold text-text">{title}</span>
        <small className="block text-caption text-muted">{sub}</small>
      </dt>
      <dd className={cx("m-0 text-[18px] font-extrabold tabular-nums", warn ? "text-warn" : "text-text")}>{value}</dd>
    </div>
  );
}

/** Подпись пола с меткой ряда: чоловіки — круг c1, жінки — квадрат c2 */
function SexMark({ sex, children }: { sex: "male" | "female"; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="10" height="10" aria-hidden className="shrink-0">
        <Marker shape={sex === "male" ? "circle" : "square"} x={5} y={5} r={4} color={sex === "male" ? "var(--c1)" : "var(--c2)"} ringWidth={0} />
      </svg>
      {children}
    </span>
  );
}

/** Сдвиг среднего T полоской: середина — 0, коробка — ±5 T, круг — чоловіки, квадрат — жінки */
function ShiftBar({ men, women }: { men: number | null; women: number | null }) {
  const W = 120;
  const H = 22;
  const L = 6;
  const R = W - 6;
  const x = (v: number) => L + ((R - L) * (Math.max(-12, Math.min(12, v)) + 12)) / 24;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden className="shrink-0">
      <line x1={L} x2={R} y1={H / 2} y2={H / 2} stroke="var(--divider)" />
      <rect x={x(-T_SHIFT_LIMIT)} y={5} width={x(T_SHIFT_LIMIT) - x(-T_SHIFT_LIMIT)} height={H - 10} rx={4} fill="var(--sunk)" stroke="var(--ctl)" />
      <line x1={x(0)} x2={x(0)} y1={3} y2={H - 3} stroke="var(--muted)" />
      {women !== null ? <Marker shape="square" x={x(women)} y={H / 2} r={3.6} color="var(--c2)" /> : null}
      {men !== null ? <Marker shape="circle" x={x(men)} y={H / 2} r={4.4} color="var(--c1)" /> : null}
    </svg>
  );
}

function NormTable({
  scales,
  kindOf,
  picked,
  onPick,
  publishableSexes,
}: {
  scales: Scale[];
  kindOf: Map<string, string>;
  picked: Set<string>;
  onPick: (code: string, on: boolean) => void;
  publishableSexes: (s: Scale) => ("male" | "female")[];
}) {
  const { ut } = useLang();
  const th = "h-[30px] whitespace-nowrap border-divider bg-panel-2 px-2.5 text-caption font-bold text-muted";
  const pair = (v: { mean: number; sd: number } | undefined) => (v ? `${f1(v.mean)} / ${f1(v.sd)}` : "—");
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-body">
        <thead>
          <tr>
            <th rowSpan={2} className={cx(th, "border-y pl-4 text-left")}>
              {ut("mc.nmScale")}
            </th>
            {sexes.map((sx) => (
              <th key={sx} colSpan={2} className={cx(th, "border-t text-center")}>
                {ut(sx === "male" ? "nm.menCap" : "nm.womenCap")}
              </th>
            ))}
            <th rowSpan={2} className={cx(th, "border-y text-left")}>
              {ut("mc.nmShift")}
            </th>
            <th rowSpan={2} className={cx(th, "border-y pr-4 text-left")}>
              {ut("mc.nmConvert")}
            </th>
          </tr>
          <tr>
            {sexes.flatMap((sx) => [
              <th key={`${sx}-m`} className={cx(th, "border-b text-right")}>
                {ut("mc.nmManual")}
              </th>,
              <th key={`${sx}-s`} className={cx(th, "border-b text-right")}>
                {ut("mc.nmSampleCol")}
              </th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {scales.map((s) => {
            const cur = (sx: string) => s.current.find((n) => n.sex === sx);
            const cand = (sx: string) => s.candidate.find((g) => g.sex === sx);
            const sm = tShift(cur("male"), cand("male"));
            const sw = tShift(cur("female"), cand("female"));
            const big = (v: number | null) => v !== null && Math.abs(v) > T_SHIFT_LIMIT;
            const can = publishableSexes(s);
            const on = picked.has(s.code);
            const td = cx("h-11 border-b border-divider px-2.5", on && "bg-violet-tint");
            return (
              <tr key={s.code}>
                <td className={cx(td, "pl-4")}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="inline-grid h-6 place-items-center rounded-[7px] bg-sunk px-2 text-caption font-extrabold text-text">{s.code}</span>
                    <span className="truncate">{s.title}</span>
                    {kindOf.get(s.code) === "validity" ? <Tag>{ut("mc.nmService")}</Tag> : null}
                  </span>
                </td>
                {sexes.flatMap((sx) => {
                  const c = cand(sx);
                  return [
                    <td key={`${sx}-m`} className={cx(td, "whitespace-nowrap text-right tabular-nums text-muted")}>
                      {pair(cur(sx))}
                    </td>,
                    <td key={`${sx}-s`} className={cx(td, "whitespace-nowrap text-right font-bold tabular-nums")}>
                      {c ? pair(c) : <span className="font-medium text-muted">{ut("mark.fewData")}</span>}
                      {c && !c.publishable ? (
                        <Tooltip label={ut("mc.nmStarTip").replace("{n}", String(c.n))}>
                          <span tabIndex={0} className="ml-0.5 font-extrabold text-warn">
                            *
                          </span>
                        </Tooltip>
                      ) : null}
                    </td>,
                  ];
                })}
                <td className={td}>
                  <span className="flex items-center gap-2.5">
                    <ShiftBar men={sm} women={sw} />
                    <b className={cx("w-11 text-right tabular-nums", big(sm) ? "text-warn" : "text-text")}>{sm === null ? "—" : signed1(sm)}</b>
                    <span className="w-10 text-caption font-bold tabular-nums text-muted">{sw === null ? "—" : signed1(sw)}</span>
                  </span>
                </td>
                <td className={cx(td, "pr-4")}>
                  {can.length ? (
                    <Switch
                      checked={on}
                      onChange={(v) => onPick(s.code, v)}
                      label={on ? can.map((x) => ut(SEX_KEY[x])).join(", ") : ut("acc.no")}
                    />
                  ) : (
                    <span className="text-caption text-muted">{ut("mc.nmCant")}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Вікові криві: медіана (P50) за віком по статі. Одна шкала за раз — вибір
 * над графіком. Окно сглаживания — сервера; там, где данных мало, оно
 * шире, и подпись это говорит.
 */
function AgeCurves({ surveyId }: { surveyId: string }) {
  const { ut } = useLang();
  const res = useResource(() => api.ageCurves(surveyId), [surveyId]);
  const [code, setCode] = useState<string | null>(null);
  if (!res.data) return <Loading rows={4} error={res.error} onRetry={res.reload} />;
  const data = res.data;
  if (!data.scales.length) {
    return (
      <Panel>
        <Empty title={ut("nm.noCurves")} hint={`${ut("nm.curveMinPrefix")} ${data.minWindow} ${ut("nm.curveMinSuffix")}`} />
      </Panel>
    );
  }
  const scale = data.scales.find((s) => s.code === code) ?? data.scales[0]!;
  const lines = scale.bySex
    .filter((b) => b.enough)
    .map((b) => ({
      sex: b.sex,
      halfWidth: b.points[0]?.halfWidth ?? null,
      points: b.points.map((p) => ({ age: p.age, value: p.percentiles.find((q) => Math.abs(q.q - 0.5) < 1e-6)?.value ?? null, n: p.n })),
    }));
  return (
    <Panel
      title={ut("mc.nmCurvesTitle").replace("{scale}", `${scale.code}, ${scale.title}`)}
      icon={<ShellIcon name="chart-line" />}
      sub={scale.normalization === "tscore" ? ut("nm.tScores") : undefined}
      actions={
        data.scales.length > 1 ? (
          <MenuButton
            label={ut("mc.nmScale")}
            trigger={(p) => (
              <button
                type="button"
                {...p}
                className="inline-flex h-9 min-h-0 cursor-pointer items-center gap-1.5 rounded-[18px] border-0 bg-sunk pl-3 pr-2.5 text-small font-semibold text-text-2 hover:bg-sunk-2"
              >
                {ut("mc.nmScale")}
                <b className="font-extrabold text-text">{scale.code}</b>
                <Ic.chevronDown size={13} />
              </button>
            )}
          >
            {(close) =>
              data.scales.map((s) => (
                <button
                  key={s.code}
                  type="button"
                  role="menuitemradio"
                  aria-checked={s.code === scale.code}
                  className={menuItem}
                  onClick={() => {
                    close();
                    setCode(s.code);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{`${s.code}, ${s.title}`}</span>
                  {s.code === scale.code ? <Ic.check size={15} className="text-violet-ink" /> : null}
                </button>
              ))
            }
          </MenuButton>
        ) : undefined
      }
    >
      {lines.length ? (
        <div className="grid grid-cols-[minmax(0,1fr)_280px] items-center gap-6 max-[1180px]:grid-cols-1">
          <AgeChart lines={lines} />
          <div className="flex flex-col gap-3">
            <p className="m-0 text-body text-text">{ut("mc.nmCurvesLead")}</p>
            {lines.map((l) => (
              <p key={l.sex} className="m-0 text-small text-muted">
                <SexMark sex={l.sex}>{ut(l.sex === "male" ? "nm.menCap" : "nm.womenCap")}</SexMark>
                {l.halfWidth !== null ? `: ${ut("nm.windowPm")}${l.halfWidth} ${ut("nm.years")}` : null}
              </p>
            ))}
            <p className="m-0 text-small text-muted">{`${ut("nm.curveMinPrefix")} ${data.minWindow} ${ut("nm.curveMinSuffix")}`}</p>
          </div>
        </div>
      ) : (
        <Empty compact title={ut("nm.noCurves")} hint={`${ut("nm.curveMinPrefix")} ${data.minWindow} ${ut("nm.curveMinSuffix")}`} />
      )}
    </Panel>
  );
}

/**
 * Медіана за віком: ось по данным (T-баллы живут около 50, ось с нуля
 * сплющила бы разницу в 5 T в волосок), круг — чоловіки, квадрат — жінки,
 * число у последней точки. Подсказка — у каждой точки (title).
 */
function AgeChart({
  lines,
}: {
  lines: { sex: "male" | "female"; points: { age: number; value: number | null; n: number }[] }[];
}) {
  const { ut } = useLang();
  const [W, ref] = useChartWidth(640);
  const H = 220;
  const P = { top: 14, right: 64, bottom: 26, left: 40 };
  const all = lines.flatMap((l) => l.points);
  const values = all.map((p) => p.value).filter((v): v is number => v !== null);
  const ages = all.map((p) => p.age);
  if (!values.length) return null;
  const axis = axisFor({ lo: Math.min(...values), hi: Math.max(...values) });
  const a0 = Math.min(...ages);
  const a1 = Math.max(...ages);
  const pw = Math.max(40, W - P.left - P.right);
  const ph = H - P.top - P.bottom;
  const xAt = (age: number) => P.left + (a1 > a0 ? ((age - a0) / (a1 - a0)) * pw : pw / 2);
  const yAt = (v: number) => P.top + ph - ((v - axis.min) / Math.max(axis.max - axis.min, Number.EPSILON)) * ph;
  const color = (sex: "male" | "female") => (sex === "male" ? "var(--c1)" : "var(--c2)");
  const step = Math.max(1, Math.ceil((a1 - a0) / 8 / 5) * 5);
  const ticksX: number[] = [];
  for (let a = Math.ceil(a0 / step) * step; a <= a1; a += step) ticksX.push(a);
  return (
    <div ref={ref} className="min-w-0">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ut("mc.nmCurvesAria")} className="block">
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={P.left} x2={P.left + pw} y1={yAt(t)} y2={yAt(t)} stroke="var(--divider)" />
            <text x={P.left - 8} y={yAt(t) + 4} textAnchor="end" className="fill-muted text-[11px] tabular-nums">
              {t}
            </text>
          </g>
        ))}
        {ticksX.map((a) => (
          <text key={a} x={xAt(a)} y={H - 6} textAnchor="middle" className="fill-muted text-[11px] tabular-nums">
            {a}
          </text>
        ))}
        {lines.map((l) => {
          const pts = l.points.filter((p) => p.value !== null) as { age: number; value: number; n: number }[];
          const d = pts.map((p, i) => `${i ? "L" : "M"}${xAt(p.age).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(" ");
          const last = pts.at(-1);
          return (
            <g key={l.sex}>
              <path d={d} fill="none" stroke={color(l.sex)} strokeWidth={2} strokeLinejoin="round" />
              {pts.map((p) => (
                <g key={p.age}>
                  <title>{`${ut(l.sex === "male" ? "nm.menCap" : "nm.womenCap")}, ${p.age}: ${f1(p.value)} (n = ${p.n})`}</title>
                  <Marker shape={l.sex === "male" ? "circle" : "square"} x={xAt(p.age)} y={yAt(p.value)} r={l.sex === "male" ? 4 : 3.6} color={color(l.sex)} />
                </g>
              ))}
              {last ? (
                <text x={xAt(last.age) + 8} y={yAt(last.value) + 4} className="fill-text text-[11.5px] font-bold tabular-nums">
                  {f1(last.value)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <ChartLegend
        items={lines.map((l) => ({
          key: l.sex,
          label: ut(SEX_KEY[l.sex]),
          color: color(l.sex),
          kind: "line" as const,
          shape: l.sex === "male" ? ("circle" as const) : ("square" as const),
        }))}
      />
    </div>
  );
}
