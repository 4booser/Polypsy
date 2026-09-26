import { useState } from "react";
import type { ConditionSummary, ConditionsResult, Severity } from "@quizzy/shared";
import { api } from "../../api";
import { Figure, ShareBar, Sparkline } from "../../charts/clinical";
import { severityKey } from "../../format";
import { useLang } from "../../lang";
import { useLiveReload } from "../../events";
import { useResource } from "../../useResource";
import { cx } from "../../ui/cx";
import { Button, Num } from "../../ui/primitives";
import { RuleSection } from "../../ui/section";
import { DOMAIN_KEY, fill, shareState, sparkValues, spreadParts, type BandLabels } from "./model";

/**
 * Переключатель периода в строке раздела: «30 днів / 90 днів».
 *
 * Кнопки с состоянием (aria-pressed), а не вкладки: адрес не меняется, и
 * пересылать коллеге «сводку за 90 дней» незачем — она и так открывается
 * целиком. Нажатая — заливкой #f0ecff, как поле фильтра (`look="fill"`):
 * заливка в консоли и значит «так сейчас отобрано». Одного цвета текста
 * мало: на 15-м кегле primary и primary-dim отличаются едва заметно, а
 * заливка читается и без цвета.
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

/**
 * Главное число блока — доля в клинических полосах — или слова, почему его нет.
 *
 * Число фиолетовым, а не янтарём: доля — состояние, а не то, что требует
 * действия сейчас (янтарь на этом экране один — у случаев на разбор).
 */
function ShareHead({ spread, people }: { spread: ConditionSummary["spread"]; people: number | null }) {
  const { ut } = useLang();
  const state = shareState(spread, people);
  if (state === "few") return <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("dash.tooFew")}</p>;
  if (state !== "shown") {
    return (
      <p className="m-0 text-[13px] leading-[18px] text-muted">
        {state === "noBands" ? ut("dash.noBands") : ut("dash.shareHidden")}
      </p>
    );
  }
  return (
    <div className="flex items-center gap-[12px]">
      <span className="font-mono text-[30px] leading-[34px] text-primary tabular-nums">
        {spread.clinical.percent}
        <span className="ml-[2px] text-[17px]">%</span>
      </span>
      <span className="text-[13px] leading-[16px] text-muted">
        {ut("dash.clinical")}
        <br />
        {ut("dash.clinicalWhat")}
      </span>
    </div>
  );
}

/** Одно направление: доля, полоса ступеней, люди, средний балл основной методики, ход */
export function DomainCard({ d }: { d: ConditionSummary }) {
  const { ut } = useLang();
  const labels = useBandLabels();
  const name = ut(DOMAIN_KEY[d.domain]);
  const parts = spreadParts(d.spread, labels);
  const spark = sparkValues(d.weeks);
  const few = shareState(d.spread, d.people) === "few";

  return (
    <article className="min-w-0 border-t border-hairline pt-[16px]">
      <h3 className="m-0 mb-[10px] text-[17px] font-bold leading-[20px] text-primary">{name}</h3>
      <ShareHead spread={d.spread} people={d.people} />
      {parts.length ? <ShareBar className="mt-[12px]" parts={parts} label={`${name}: ${ut("dash.clinical")}`} /> : null}

      {!few ? (
        <dl className="m-0 mt-[14px] grid grid-cols-[auto_minmax(0,1fr)] gap-x-[12px] gap-y-[6px] text-[13px] leading-[18px]">
          {d.people !== null ? (
            <>
              <dt className="text-muted">{ut("dash.people")}</dt>
              <dd className="m-0">
                <Num className="text-text">{d.people}</Num>
              </dd>
            </>
          ) : null}
          {d.primary && d.primary.meanPercent !== null ? (
            <>
              <dt className="text-muted">{ut("dash.mean")}</dt>
              {/*
                Средний балл — с названием методики и направлением шкалы рядом:
                «33 % від максимуму» без «вище — гірше» у благополучия читался
                бы наоборот, а без названия — как среднее по всем методикам,
                которого здесь нет.
              */}
              <dd className="m-0 min-w-0">
                <span className="font-mono font-bold text-text tabular-nums">
                  {fill(ut("dash.ofMax"), { p: d.primary.meanPercent })}
                </span>
                <span className="text-muted"> · {d.higherIsWorse ? ut("dash.higherWorse") : ut("dash.higherBetter")}</span>
                <span className="block truncate text-text-2">{d.primary.title}</span>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {!few && spark.length > 1 ? (
        <figure className="m-0 mt-[10px]">
          <Sparkline values={spark} />
          <figcaption className="text-[11px] leading-[14px] text-muted">{ut("dash.meanWeekly")}</figcaption>
        </figure>
      ) : null}

      {d.sources.length ? (
        <p className="m-0 mt-[10px] text-[11px] leading-[15px] text-muted">
          {ut("dash.sources")}: {d.sources.map((s) => s.title).join(", ")}
        </p>
      ) : null}
    </article>
  );
}

/** Все методики разом: кто где сейчас */
function Overall({ overall }: { overall: ConditionsResult["overall"] }) {
  const { ut } = useLang();
  const labels = useBandLabels();
  const parts = spreadParts(overall.spread, labels);
  return (
    <Figure title={ut("dash.overall")} caption={ut("dash.overallHint")}>
      <div className="grid grid-cols-1 items-center gap-x-[32px] gap-y-[12px] min-[700px]:grid-cols-[240px_minmax(0,1fr)]">
        <div className="flex flex-col gap-[4px]">
          <ShareHead spread={overall.spread} people={overall.people} />
          {overall.people !== null ? (
            <span className="text-[13px] text-muted">
              {ut("dash.people")}: <Num className="text-text">{overall.people}</Num>
            </span>
          ) : null}
        </div>
        {parts.length ? <ShareBar parts={parts} label={`${ut("dash.overall")}: ${ut("dash.clinical")}`} /> : null}
      </div>
    </Figure>
  );
}

/** Тело раздела по уже загруженным данным — отдельно, чтобы его можно было нарисовать в проверке */
export function ConditionsBody({ data }: { data: ConditionsResult }) {
  const { ut } = useLang();
  return (
    <>
      {data.domains.length === 0 ? (
        <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("dash.nothingMeasured")}</p>
      ) : (
        <>
          <Overall overall={data.overall} />
          {/*
            Колонки по минимальной ширине, а не числом: на 1200 встают три
            по ~380, на ноутбуке с панелью — две, на телефоне — одна. Полоса
            ступеней уже 320 теряет подписи легенды в перенос, но не в обрез.
          */}
          <div className="mt-[28px] grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-x-[32px] gap-y-[28px]">
            {data.domains.map((d) => (
              <DomainCard key={d.domain} d={d} />
            ))}
          </div>
        </>
      )}
      {/*
        Направления без замеров — одной строкой, а не пустыми блоками: шесть
        карточек «немає даних» заняли бы полэкрана и спрятали бы те две, где
        данные есть.
      */}
      {data.empty.length ? (
        <p className="m-0 mt-[24px] text-[13px] leading-[18px] text-muted">
          {ut("dash.noMeasures")}: {data.empty.map((k) => ut(DOMAIN_KEY[k])).join(", ")}
        </p>
      ) : null}
    </>
  );
}

type Days = "30" | "90";

/**
 * Раздел «Стан пацієнтів за напрямами» — со своей загрузкой.
 *
 * Своей, а не в общей загрузке сводки: смена периода не должна перезапрашивать
 * очередь и счётчики, а отказ этого маршрута (нет права analytics.read) — гасить
 * весь экран. Раздел тогда говорит об отказе сам, остальное стоит.
 */
export function ConditionsSection() {
  const { ut } = useLang();
  const [days, setDays] = useState<Days>("90");
  const res = useResource(() => api.dashboardConditions(Number(days)), [days]);
  useLiveReload(["response.submitted"], res.reload);

  return (
    <RuleSection
      title={ut("dash.conditions")}
      hint={ut("dash.conditionsHint")}
      actions={
        <PeriodSwitch
          label={ut("dash.rangeLabel")}
          value={days}
          onChange={setDays}
          options={[
            ["30", ut("dash.range30d")],
            ["90", ut("dash.range90d")],
          ]}
        />
      }
    >
      {res.data ? (
        <ConditionsBody data={res.data} />
      ) : res.error ? (
        <div className="flex flex-wrap items-center gap-[12px]">
          <p className="m-0 text-[13px] text-danger">{res.error}</p>
          <Button variant="quiet" onClick={res.reload}>
            {ut("common.retry")}
          </Button>
        </div>
      ) : (
        <p className="m-0 text-[13px] text-muted" role="status" aria-busy="true">
          {ut("common.loading")}
        </p>
      )}
    </RuleSection>
  );
}
