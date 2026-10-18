import { useState, type ReactNode } from "react";
import type { ConditionSummary, ConditionsResult, Severity } from "@quizzy/shared";
import { api } from "../../api";
import { ShareBar, SevDot, Sparkline } from "../../charts/clinical";
import { severityKey } from "../../format";
import { useLang } from "../../lang";
import { useLiveReload } from "../../events";
import { useResource } from "../../useResource";
import { cx } from "../../ui/cx";
import { Ic } from "../../ui/icons";
import { Loading } from "../../ui";
import { Panel } from "../../ui/layout";
import { Segmented } from "../../ui/primitives";
import { Di } from "../today/icons";
import { DOMAIN_KEY, fill, meanShift, shareState, sparkValues, spreadParts, type BandLabels } from "./model";

/**
 * Переключатель периода в строке раздела: «30 днів / 90 днів».
 *
 * Кнопки с состоянием (aria-pressed), а не вкладки: адрес не меняется.
 * Нажатая — заливкой: заливка в консоли и значит «так сейчас отобрано».
 * Им пользуются экраны техпанели (ops/Errors, ops/Requests, Vitals).
 */
export function PeriodSwitch<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-[4px]">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cx(
            "h-[36px] rounded-[5px] border-0 px-[12px] text-[15px] font-bold leading-none",
            "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
            "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
            value === v ? "bg-primary-soft text-primary" : "bg-transparent text-primary-dim hover:text-primary",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function useBandLabels(): BandLabels {
  const { ut } = useLang();
  return {
    severity: {
      none: ut(severityKey.none),
      mild: ut(severityKey.mild),
      moderate: ut(severityKey.moderate),
      severe: ut(severityKey.severe),
    } satisfies Record<Severity, string>,
    low: ut("dash.bandLow"),
    high: ut("dash.bandHigh"),
  };
}

/** Почему доли нет — словами со значком, а не прочерком */
function ShareNote({ state }: { state: "few" | "noBands" | "hidden" }) {
  const { ut } = useLang();
  return (
    <span className="flex items-start gap-2 text-small leading-[18px] text-text-2">
      <span className="mt-px inline-flex text-muted">{state === "noBands" ? <Ic.minus size={14} /> : <Di.eyeOff size={14} />}</span>
      {state === "few" ? ut("dash.tooFew") : state === "noBands" ? ut("dash.noBands") : ut("dash.shareHidden")}
    </span>
  );
}

const COLS = "grid-cols-[minmax(170px,1.15fr)_64px_minmax(200px,1.7fr)_minmax(120px,1fr)_minmax(200px,1.3fr)]";

/** Строка таблицы: напрям, люди, полоса смуг, клиническая доля, средний балл с ходом */
function Row({
  name,
  code,
  note,
  people,
  share,
  clinical,
  mean,
  all,
}: {
  name: string;
  code?: string | null;
  note?: string;
  people: number | null;
  share: ReactNode;
  clinical: ReactNode;
  mean: ReactNode;
  all?: boolean;
}) {
  return (
    <div role="row" className={cx("grid min-h-[62px] items-center gap-x-4 gap-y-0 border-t border-divider px-4 py-2.5", COLS, all && "bg-panel-2")}>
      <div role="rowheader" className="min-w-0">
        <b className="block text-[13.5px] font-extrabold leading-[18px] text-text">{name}</b>
        {code ? (
          <span className="mt-1 inline-flex h-[22px] max-w-full items-center truncate rounded-[6px] bg-sunk px-2 text-[11.5px] font-bold text-text-2">{code}</span>
        ) : null}
        {note ? <small className="mt-0.5 block text-caption leading-4 text-muted">{note}</small> : null}
      </div>
      <div role="cell" className="text-right text-[14px] font-bold text-text tabular-nums">
        {people === null ? <span className="text-muted">—</span> : people}
      </div>
      <div role="cell" className="min-w-0">
        {share}
      </div>
      <div role="cell" className="min-w-0">
        {clinical}
      </div>
      <div role="cell" className="min-w-0">
        {mean}
      </div>
    </div>
  );
}

function Clinical({ spread, people }: { spread: ConditionSummary["spread"]; people: number | null }) {
  const { ut } = useLang();
  if (shareState(spread, people) !== "shown") return <span className="text-muted">—</span>;
  return (
    <span className="flex items-baseline gap-2.5">
      <b className="text-[18px] font-extrabold tracking-[-0.01em] text-text tabular-nums">{spread.clinical.percent} %</b>
      {spread.clinical.count !== null ? (
        <small className="text-caption text-muted">{fill(ut("dashA.peopleN"), { n: spread.clinical.count })}</small>
      ) : null}
    </span>
  );
}

/** Одно направление строкой таблицы — отдельно ради проверки без браузера */
export function DomainRow({ d }: { d: ConditionSummary }) {
  const { ut } = useLang();
  const labels = useBandLabels();
  const name = ut(DOMAIN_KEY[d.domain]);
  const state = shareState(d.spread, d.people);
  const parts = spreadParts(d.spread, labels);
  const spark = sparkValues(d.weeks);
  const shift = meanShift(d.weeks);
  const few = state === "few";
  const better = shift === null ? null : d.higherIsWorse ? shift < 0 : shift > 0;

  return (
    <Row
      name={name}
      code={d.primary?.title ?? d.sources[0]?.title}
      people={few ? null : d.people}
      share={
        state === "shown" && parts.length ? (
          <ShareBar parts={parts} legend={false} label={`${name}: ${ut("dash.clinical")}`} />
        ) : (
          <ShareNote state={state === "shown" ? "hidden" : state} />
        )
      }
      clinical={<Clinical spread={d.spread} people={d.people} />}
      mean={
        !few && d.primary && d.primary.meanPercent !== null ? (
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <b className="text-[14px] font-extrabold text-text tabular-nums">{d.primary.meanPercent} %</b>
              {spark.length > 1 ? <Sparkline values={spark} width={92} /> : null}
              {shift !== null && shift !== 0 ? (
                <span className={cx("text-small font-extrabold tabular-nums", better ? "text-good" : "text-warn")}>
                  {fill(ut("dashA.pp"), { d: shift > 0 ? `+${shift}` : `−${Math.abs(shift)}` })}
                </span>
              ) : null}
            </div>
            <small className="block text-caption text-muted">
              {ut("dashA.ofMaxShort")}, {d.higherIsWorse ? ut("dash.higherWorse") : ut("dash.higherBetter")}
            </small>
          </div>
        ) : (
          <span className="text-muted">—</span>
        )
      }
    />
  );
}

/** Тело віджета по уже загруженным данным — отдельно, чтобы его можно было нарисовать в проверке */
export function ConditionsBody({ data }: { data: ConditionsResult }) {
  const { ut } = useLang();
  const labels = useBandLabels();
  if (data.domains.length === 0) {
    return (
      <div className="px-4 pb-4">
        <p className="m-0 text-small text-muted">{ut("dash.nothingMeasured")}</p>
        {data.empty.length ? (
          <p className="m-0 mt-2 text-small text-muted">
            {ut("dash.noMeasures")}: {data.empty.map((k) => ut(DOMAIN_KEY[k])).join(", ")}
          </p>
        ) : null}
      </div>
    );
  }
  const overallState = shareState(data.overall.spread, data.overall.people);
  const overallParts = spreadParts(data.overall.spread, labels);
  return (
    <>
      <div className="overflow-x-auto">
        <div role="table" aria-label={ut("dash.conditions")} className="min-w-[860px]">
          <div role="row" className={cx("grid h-9 items-center gap-x-4 gap-y-0 bg-panel-2 px-4 text-caption font-bold text-muted", COLS)}>
            <span role="columnheader">{ut("dashA.colDomain")}</span>
            <span role="columnheader" className="text-right">
              {ut("dash.people")}
            </span>
            <span role="columnheader">{ut("dashA.colShare")}</span>
            <span role="columnheader">{ut("dash.bandHigh")}</span>
            <span role="columnheader">{ut("dashA.colMean")}</span>
          </div>
          <Row
            all
            name={ut("dash.overall")}
            note={ut("dash.overallHint")}
            people={data.overall.people}
            share={
              overallState === "shown" && overallParts.length ? (
                <ShareBar parts={overallParts} legend={false} label={`${ut("dash.overall")}: ${ut("dash.clinical")}`} />
              ) : (
                <ShareNote state={overallState === "shown" ? "hidden" : overallState} />
              )
            }
            clinical={<Clinical spread={data.overall.spread} people={data.overall.people} />}
            mean={<span className="text-small text-muted">{ut("dashA.noSum")}</span>}
          />
          {data.domains.map((d) => (
            <DomainRow key={d.domain} d={d} />
          ))}
          {data.empty.map((k) => (
            <Row
              key={k}
              name={ut(DOMAIN_KEY[k])}
              people={null}
              share={<span className="text-small text-muted">{ut("dash.noMeasures")}</span>}
              clinical={<span className="text-muted">—</span>}
              mean={<span className="text-muted">—</span>}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-divider px-4 py-2.5 text-caption text-text-2">
        {(["none", "mild", "moderate", "severe"] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5 font-semibold">
            <SevDot severity={s} />
            {labels.severity[s]}
          </span>
        ))}
        <span className="ml-auto inline-flex items-center gap-1.5 text-muted">
          <Ic.info size={13} />
          {ut("dashA.condFoot")}
        </span>
      </div>
    </>
  );
}

type Days = "30" | "90";

/**
 * Віджет «Стан пацієнтів за напрямами» — со своей загрузкой: смена периода
 * не перезапрашивает очередь и счётчики, а отказ этого маршрута (нет права
 * analytics.read) не гасит весь экран — віджет говорит об отказе сам.
 */
export function ConditionsWidget() {
  const { ut } = useLang();
  const [days, setDays] = useState<Days>("90");
  const res = useResource(() => api.dashboardConditions(Number(days)), [days]);
  useLiveReload(["response.submitted"], res.reload);

  return (
    <Panel
      title={ut("dash.conditions")}
      icon={<Di.activity />}
      sub={fill(ut("dashA.condSub"), { n: days })}
      actions={
        <Segmented
          label={ut("dash.rangeLabel")}
          value={days}
          onChange={setDays}
          items={[
            { key: "30", label: ut("dash.range30d") },
            { key: "90", label: ut("dash.range90d") },
          ]}
        />
      }
      flush
    >
      {res.data ? (
        <ConditionsBody data={res.data} />
      ) : res.error ? (
        <div className="px-4 pb-4">
          <Loading bare error={res.error} onRetry={res.reload} />
        </div>
      ) : (
        <p className="m-0 px-4 pb-4 text-small text-muted" role="status" aria-busy="true">
          {ut("common.loading")}
        </p>
      )}
    </Panel>
  );
}
