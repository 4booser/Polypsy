import { Link } from "react-router-dom";
import type { DataCheck } from "@quizzy/shared";
import { api } from "../../../api";
import { Kpi } from "../../../charts/clinical";
import { dateTime } from "../../../format";
import { useLang } from "../../../lang";
import { Screen } from "../../../ui";
import { Num } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import {
  CHECK_KIND,
  CHECK_TEXT,
  KIND_UNIT,
  bySurveyHref,
  checkSummary,
  exampleHref,
  extraRows,
} from "./model";
import { KPI_GRID, LevelTag, Note } from "./parts";

/**
 * «Якість даних» — несостыковки записей по всей базе (lib/dataChecks.ts).
 *
 * Не то же, что вкладка «Якість» аналитики методики: там — как люди
 * заполняют одну методику (доходимость, дрейф, тест-ретест), здесь — не
 * разошлись ли между собой сами записи: прохождение без версии, балл на
 * шкале чужой редакции, подсчёт без полос. Ссылка на ту вкладку стоит
 * внизу сводки, чтобы два вопроса не путали и не искали одно в другом.
 *
 * Порядок проверок — серверный: сначала то, что уже врёт, потом то, что
 * начнёт. Сработавшая проверка — разделом строки с примерами и разбивкой,
 * чистая — одной строкой «Чисто»: двенадцать пустых разделов заслонили бы
 * две настоящие находки.
 *
 * Ничего не чинит и кнопок «исправить» не несёт: клиническая запись не
 * правится молча, а чинить её — работа того, кто видит протокол целиком.
 */
export default function OpsDataQuality() {
  const res = useResource(() => api.opsDataQuality(), []);
  return <Screen res={res}>{(data) => <QualityBody checkedAt={data.checkedAt} checks={data.checks} />}</Screen>;
}

export function QualityBody({ checkedAt, checks }: { checkedAt: string; checks: readonly DataCheck[] }) {
  const { ut } = useLang();
  const sum = checkSummary(checks);

  return (
    <>
      <RuleSection title={ut("opsd.q.summary")} hint={ut("opsd.q.summaryHint")}>
        <div className={KPI_GRID}>
          {/*
            Янтарь — у ошибок и предупреждений, и только когда они есть: это
            ровно «требует внимания». «До відома» и чистые не требуют ничего.
          */}
          <Kpi
            label={ut("opsd.q.errors")}
            value={sum.error}
            tone={sum.error > 0 ? "attention" : "plain"}
            hint={ut("opsd.q.errorsHint")}
          />
          <Kpi
            label={ut("opsd.q.warnings")}
            value={sum.warning}
            tone={sum.warning > 0 ? "attention" : "plain"}
            hint={ut("opsd.q.warningsHint")}
          />
          <Kpi label={ut("opsd.q.infos")} value={sum.info} hint={ut("opsd.q.infosHint")} />
          <Kpi label={ut("opsd.q.clean")} value={sum.clean} hint={fill(ut("opsd.q.checkedAt"), { at: dateTime(checkedAt) })} />
        </div>
        <Note>
          {ut("opsd.q.surveyQuality")}{" "}
          <Link to="/analytics/tests?view=quality" className="font-bold text-primary no-underline hover:underline">
            {ut("opsd.q.surveyQualityLink")} →
          </Link>
        </Note>
      </RuleSection>

      <RuleSection title={ut("opsd.q.checks")}>
        <ul className="m-0 list-none p-0">
          {checks.map((c) => (
            <CheckRow key={c.key} check={c} />
          ))}
        </ul>
      </RuleSection>
    </>
  );
}

function CheckRow({ check }: { check: DataCheck }) {
  const { ut } = useLang();
  const text = CHECK_TEXT[check.key];
  const unit = ut(KIND_UNIT[CHECK_KIND[check.key]]);

  if (check.count === 0) {
    return (
      <li className="flex min-h-[44px] flex-wrap items-center gap-x-[16px] gap-y-[4px] border-b border-hairline py-[8px]">
        <span className="min-w-0 flex-1 basis-[240px] text-[15px] leading-[20px] text-text-2">{ut(text.title)}</span>
        <span className="text-[13px] text-muted">{ut("opsd.q.cleanOne")}</span>
      </li>
    );
  }

  const extras = extraRows(check.extra);
  return (
    <li className="border-b border-hairline py-[16px]">
      {/*
        Строка консоли: имя 17/700, за ним уровень словом и число. Число —
        моноширинное и справа: взгляд ищет «сколько», сравнивая строки
        одну под другой.
      */}
      <div className="flex flex-wrap items-baseline gap-x-[16px] gap-y-[6px]">
        <span className="min-w-0 flex-1 basis-[260px] text-[17px] font-bold leading-[22px] text-primary">{ut(text.title)}</span>
        <LevelTag level={check.level} />
        <span className="shrink-0 text-[13px] text-muted">
          <Num className="text-[17px] font-bold text-text">{check.count}</Num> {unit}
        </span>
      </div>
      <p className="m-0 mt-[6px] max-w-[760px] text-[13px] leading-[18px] text-muted">
        <span className="font-bold text-text-2">{ut("opsd.q.danger")}: </span>
        {ut(text.danger)}
      </p>

      <div className="mt-[12px] grid grid-cols-1 gap-x-[45px] gap-y-[12px] min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <span className="block text-[13px] font-bold leading-[16px] text-muted">{ut("opsd.q.examples")}</span>
          {/* голые идентификаторы: ни имени, ни ответа — права проверит экран, куда ведёт ссылка */}
          <ul className="m-0 mt-[6px] flex list-none flex-wrap gap-x-[14px] gap-y-[4px] p-0">
            {check.examples.map((e) => (
              <li key={e.id} className="min-w-0">
                <Link
                  to={exampleHref(e)}
                  title={e.id}
                  className="font-mono text-[12px] text-primary no-underline tabular-nums hover:underline"
                >
                  {e.id.slice(0, 8)}
                </Link>
              </li>
            ))}
          </ul>
          {extras.length ? (
            <dl className="m-0 mt-[10px] flex flex-wrap gap-x-[18px] gap-y-[4px] text-[13px] leading-[18px]">
              {extras.map((x) => (
                <div key={x.key} className="flex items-baseline gap-[6px]">
                  <dt className="text-muted">{ut(x.label)}</dt>
                  <dd className="m-0">
                    <Num className="text-text-2">{x.value}</Num>
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>

        {check.bySurvey.length ? (
          <div className="min-w-0">
            <span className="block text-[13px] font-bold leading-[16px] text-muted">{ut("opsd.q.bySurvey")}</span>
            <ul className="m-0 mt-[6px] list-none p-0">
              {check.bySurvey.map((b) => (
                <li key={b.surveyId} className="flex items-baseline justify-between gap-[12px] py-[2px] text-[13px] leading-[18px]">
                  <Link
                    to={bySurveyHref(check.key, b.surveyId)}
                    className="min-w-0 truncate text-primary no-underline hover:underline"
                  >
                    {b.title}
                  </Link>
                  <Num className="shrink-0 text-muted">{b.count}</Num>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </li>
  );
}
