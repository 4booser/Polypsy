import { useState, type ReactNode } from "react";
import { Navigate, useParams } from "react-router-dom";
import type { RespondentDynamics, ResponseDetail, Severity, SurveyFull } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { BandTrend, Figure, HBars, Kpi, ScaleProfile, SevDot, SeverityRuler, SEV_TEXT } from "../../charts/clinical";
import { num } from "../../charts/ladder";
import { dateTime, day } from "../../format";
import { useLang } from "../../lang";
import { Loading } from "../../ui";
import { cx } from "../../ui/cx";
import { Page } from "../../ui/layout";
import { Button, ButtonLink, Select } from "../../ui/primitives";
import { RuleSection } from "../../ui/section";
import { useResource } from "../../useResource";
import { ItemTimes } from "./ItemTimes";
import {
  buildAnswering,
  buildContributions,
  buildTrends,
  resultRows,
  type ResultRow,
  type ScaleContribution,
  type Shift,
  type TrendScale,
} from "./model";
import { ResponseTabs } from "./tabs";

/*
 * Графики одного прохождения — вкладка «Графіки» рядом с протоколом (f34).
 *
 * Решение заказчика 2026-09-26: «нажать на прохождение теста от
 * определённого пациента — и показало визуально графики, строго по стилю
 * проекта». Кадров у экрана нет; он собран из того, что макет уже
 * говорит о графиках («тонкие линии primary, сетка line, подписи muted,
 * цифры mono», тяжесть — текстом и тонкими метками) и из общих форм
 * charts/clinical.tsx, одних на прохождение, аналитику и сводку.
 *
 * Свиток разделов сверху вниз, каждый — только когда ему есть что показать:
 *
 *   строка состояния   → когда сдано, в каком состоянии, «Створити заключення»
 *   ── Результат        → одна шкала: линейка с подписями ступеней и текст
 *                         попавшей полосы; несколько — профиль строками и
 *                         перечень того, что значат попавшие полосы
 *   ── Динаміка         → все сданные прохождения ЭТОЙ методики этим
 *                         человеком по каждой шкале, это прохождение —
 *                         кольцом; сдвиг от прошлого раза и можно ли ему верить
 *   ── Внесок пунктів   → какие ответы дали балл, по ключу той версии
 *   ── Як відповідав    → время, быстрые ответы, смены ответа, пропуски
 *
 * Порядок — порядок вопросов разбирающего: что получилось, это лучше или
 * хуже прошлого, из чего сложилось, можно ли верить протоколу. Последний
 * вопрос стоит внизу не потому, что он неважен, а потому, что задают его,
 * когда первые три уже вызвали сомнение.
 *
 * Запросы. Прохождение — первым: из него известны номер версии методики и
 * человек. Методика той версии и динамика — следом и порознь: динамика
 * считает ошибку измерения по выборке методики и бывает заметно медленнее,
 * и ждать её ради линейки и вклада пунктов незачем. Динамика просит одну
 * методику (?survey=), иначе сервер посчитал бы альфу по всем методикам
 * человека ради одной.
 *
 * Счёт — в ./model.ts (resultRows, buildTrends, buildContributions,
 * buildAnswering) и под тестами; здесь только раскладка. Разделы
 * экспортируются поимённо ради проверки рендера на краях — без NaN в
 * координатах и со словом вместо пустоты
 * (apps/web/test/responseChartsRender.test.tsx): экран целиком для этого
 * пришлось бы поднимать с маршрутизатором, входом и сетью.
 */

export default function ResponseCharts() {
  const { ut, lang } = useLang();
  const { can } = useAuth();
  const { id: surveyId, rid } = useParams<{ id: string; rid: string }>();

  const res = useResource(() => api.responseDetail(rid!), [rid], { enabled: !!rid });
  const detail = res.data;

  /*
   * Методика ТОЙ версии, которую проходили: по её ключу считается вклад
   * пунктов, от неё же — порог «слишком быстро». Отказ не роняет экран:
   * линейка и динамика от методики не зависят, а вклад честно скажет, что
   * считать его не по чему.
   */
  const version = useResource(
    () =>
      api.survey(detail!.survey.id, detail!.survey.versionNumber).then(
        (survey): { survey: SurveyFull | null } => ({ survey }),
        () => ({ survey: null }),
      ),
    [detail?.survey.id, detail?.survey.versionNumber],
    { enabled: !!detail },
  );

  /*
   * Динамика — только когда есть кого и что сравнивать: у анонимного
   * прохождения человека нет, у методики без подсчёта нет баллов. Без права
   * patients.read маршрут динамики закрыт — запрос не отправляется вовсе
   * (сервер записал бы отказ в журнал на каждый просмотр), а раздела нет,
   * без ошибки на экране. Отказ сервера по другой причине — так же: раздел
   * пропадает, остальной экран работает.
   */
  const wantsDynamics = !!detail?.userId && detail.scores.length > 0 && can("patients.read");
  const dyn = useResource(
    () =>
      api.dynamics(detail!.userId!, detail!.survey.id).then(
        (d): { d: RespondentDynamics | null } => ({ d }),
        () => ({ d: null }),
      ),
    [detail?.userId, detail?.survey.id],
    { enabled: wantsDynamics },
  );

  /*
   * Данные прошлого адреса useResource держит, пока грузятся новые. Сверять
   * с адресом методики прохождение ДРУГОГО адреса нельзя: переход между
   * прохождениями разных методик увёл бы на адрес прежнего. Пока пришедшее
   * не то, что просили, — загрузка.
   */
  if (!detail || detail.id !== rid) return <Loading rows={8} error={res.error} onRetry={res.reload} />;
  if (surveyId && detail.survey.id !== surveyId) {
    return <Navigate to={`/surveys/${detail.survey.id}/responses/${detail.id}/charts`} replace />;
  }

  const rows = resultRows(detail, {
    of: ut("common.of"),
    norm: { raw: ut("norm.raw"), ratio: ut("norm.ratio"), tscore: ut("norm.tscore"), sten: ut("norm.sten") },
  });
  /* то же для догружаемого: при смене прохождения старые методика и динамика — ещё не ответ */
  const versionData = version.data && !version.refreshing ? version.data : null;
  const dynData = dyn.data && !dyn.refreshing ? dyn.data : null;
  const survey = versionData?.survey ?? undefined;

  return (
    <Page
      title={detail.survey.title}
      /* подпись языка текста теста — как на вкладке «Відповіді»: переключая вкладки, шапка не прыгает */
      actions={<span className="text-[17px] font-bold text-primary">{ut("top.lang")}</span>}
    >
      <ResponseTabs surveyId={detail.survey.id} responseId={detail.id} />

      {/*
        Строка состояния и кнопка заключения — над разделами, а не под ними,
        как на протоколе: протокол читают сверху вниз до конца, и кнопка ждёт
        внизу; графики смотрят выборочно, и писать заключение хочется с того
        места, где понял, что писать.
      */}
      <div className="mb-[8px] flex flex-wrap items-center justify-between gap-x-[24px] gap-y-[12px]">
        <p className="m-0 text-[15px] leading-[20px] text-muted">
          <span className="font-bold text-text-2">{ut(`rstatus.${detail.status}`, detail.status)}</span>
          {" · "}
          {dateTime(detail.submittedAt ?? detail.startedAt)}
        </p>
        <ButtonLink size="md" to={`/responses/${detail.id}/conclusion`}>
          {ut("rsp.createConclusion")}
        </ButtonLink>
      </div>

      {rows.length ? (
        <ResultSection rows={rows} />
      ) : (
        /* та же развилка, что на протоколе: подсчёт выключен — или прохождение ещё не сдано */
        <p className="m-0 mb-[24px] text-[13px] leading-[19px] text-muted">
          {!detail.survey.scoringEnabled || detail.status === "completed" ? ut("rsp.scoresOff") : ut("rsp.notSubmitted")}
        </p>
      )}

      {wantsDynamics ? (
        dynData ? (
          dynData.d ? (
            <DynamicsSection detail={detail} dyn={dynData.d} />
          ) : null
        ) : (
          <RuleSection title={ut("rch.dynamics")}>
            <Loading rows={2} />
          </RuleSection>
        )
      ) : null}

      {detail.scores.length ? (
        versionData ? (
          <ContributionSection detail={detail} survey={versionData.survey} />
        ) : (
          <RuleSection title={ut("rch.contribution")}>
            <Loading rows={2} />
          </RuleSection>
        )
      ) : null}

      {/*
        Порог «слишком быстро» — методики той версии, поэтому раздел ждёт её:
        показать сперва общий порог, а через мгновение свой, значило бы
        перекрасить быстрые столбцы на глазах. Не пришла методика — общий.
      */}
      {versionData ? (
        <AnsweringSection detail={detail} tooFastMs={survey?.tooFastMs ?? null} locale={lang} />
      ) : (
        <RuleSection title={ut("rch.answering")}>
          <Loading rows={2} />
        </RuleSection>
      )}
    </Page>
  );
}

/* ─────────── мелочи ─────────── */

/** Подстановка {n}, {m}, {t} в строку словаря */
function fill(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Полоса словом: точка ступени (форма + цвет) и подпись тем же тоном */
function BandWord({ band, className }: { band: { label: string; severity: Severity }; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-[6px]", SEV_TEXT[band.severity], className)}>
      <SevDot severity={band.severity} />
      {band.label}
    </span>
  );
}

/** Сетка малых кратных: две колонки на 1200, одна — ниже ширины двух */
const MULTIPLES = "grid gap-x-[45px] gap-y-[36px] grid-cols-[repeat(auto-fill,minmax(min(420px,100%),1fr))]";

/* ─────────── результат ─────────── */

function rulerLabel(r: ResultRow): string {
  return `${r.title}: ${r.valueText}${r.band ? ` — ${r.band.label}` : ""}`;
}

/** Можно ли рисовать линейку: есть лестница — или верх для метра */
function drawable(r: ResultRow): boolean {
  return r.rungs.length > 0 || r.meterMax !== null;
}

/**
 * Что сказать о шкале словами под графиком: полоса с описанием и
 * рекомендацией — или почему полосы нет.
 */
function ScaleNote({ r, withBand }: { r: ResultRow; withBand: boolean }) {
  const { ut } = useLang();
  if (!r.normalized) return <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("rch.notNormalized")}</p>;
  if (r.noBands) return <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("rch.noBands")}</p>;
  if (!r.band) return r.outside ? <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("rch.outside")}</p> : null;
  return (
    <div className="flex flex-col gap-[6px]">
      {withBand ? <BandWord band={r.band} className="text-[17px] font-bold leading-[22px]" /> : null}
      {r.band.description ? (
        <p className="m-0 whitespace-pre-line text-[15px] leading-[20px] text-text-2">{r.band.description}</p>
      ) : null}
      {r.band.recommendation ? (
        <p className="m-0 whitespace-pre-line text-[15px] leading-[20px] text-text-2">
          <span className="font-bold text-muted">{ut("rch.recommendation")}: </span>
          {r.band.recommendation}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Результат. Одна шкала — крупная линейка: с одного взгляда видно не
 * только ступень, но и насколько близко к соседней. Несколько — профиль
 * строками (ScaleProfile), под ним то, что значат попавшие полосы: подпись
 * ступени профиль печатает сам, а описание и рекомендацию в строку профиля
 * не уложить.
 */
export function ResultSection({ rows }: { rows: ResultRow[] }) {
  const { ut } = useLang();

  if (rows.length === 1) {
    const r = rows[0]!;
    return (
      <RuleSection title={ut("rch.result")}>
        {/*
          Линейка — во всю колонку, а не в 860, как полосы вклада ниже: у
          полос длинный текст строки, и его удобнее читать узкой колонкой, а
          у линейки текст — подписи ступеней, и на 860 они обрезались
          многоточием уже у PHQ-9 («Легка («субклінічна…»).
        */}
        <Figure title={r.title}>
          {drawable(r) ? (
            <SeverityRuler
              rungs={r.rungs}
              value={r.value}
              max={r.meterMax}
              valueLabel={r.valueText}
              label={rulerLabel(r)}
            />
          ) : (
            /* T-балл без полос: верха у шкалы нет, и метр 0…значение врал бы о «максимуме» */
            <p className="m-0 font-mono text-[30px] leading-[34px] text-primary tabular-nums">{r.valueText}</p>
          )}
          <div className="mt-[24px]">
            <ScaleNote r={r} withBand />
          </div>
        </Figure>
      </RuleSection>
    );
  }

  const notes = rows.filter(
    (r) => !r.normalized || r.noBands || r.outside || !!r.band?.description || !!r.band?.recommendation,
  );
  return (
    <RuleSection title={ut("rch.result")}>
      <ScaleProfile
        rows={rows.map((r) => ({
          key: r.scaleId,
          title: r.title,
          rungs: r.rungs,
          value: drawable(r) ? r.value : null,
          max: r.meterMax,
          valueText: r.valueText,
          band: r.band ? { label: r.band.label, severity: r.band.severity } : null,
        }))}
      />
      {notes.length ? (
        <Figure title={ut("rch.interpretation")} className="mt-[36px]">
          <dl className="m-0 grid gap-y-[18px]">
            {notes.map((r) => (
              <div
                key={r.scaleId}
                className="grid grid-cols-[minmax(96px,220px)_minmax(0,1fr)] gap-x-[24px] gap-y-[6px] max-[600px]:grid-cols-1"
              >
                <dt className="text-[15px] font-bold leading-[20px] text-primary">{r.title}</dt>
                <dd className="m-0 flex min-w-0 flex-col gap-[6px]">
                  {r.band ? <BandWord band={r.band} className="text-[15px] font-bold leading-[20px]" /> : null}
                  <ScaleNote r={r} withBand={false} />
                </dd>
              </div>
            ))}
          </dl>
        </Figure>
      ) : null}
    </RuleSection>
  );
}

/* ─────────── динамика ─────────── */

/** Больше шкал — уже не малые кратные, а выбор одной: одиннадцать графиков Міні-мульта не читаются разом */
const MAX_MULTIPLES = 6;

/**
 * Сдвиг от прошлого раза одной строкой: «+3 з 12 серп. · Легка → Помірна ·
 * більше за похибку вимірювання».
 *
 * Знак — всегда, и плюс тоже: «3» без знака читается как значение, а не
 * как разница. Хорошо это или плохо, строка не говорит: у PHQ-9 рост —
 * хуже, у WHO-5 — лучше, и знать это должна шкала, а не экран. Направление
 * читается по переходу полос — он назван словами и тоном ступени.
 */
function ShiftLine({ s }: { s: TrendScale }) {
  const { ut } = useLang();
  if (s.first) return <span>{ut("rch.firstInSeries")}</span>;
  if (!s.shift) return null;
  return <ShiftText shift={s.shift} />;
}

function ShiftText({ shift }: { shift: Shift }) {
  const { ut } = useLang();
  const sign = shift.delta > 0 ? "+" : shift.delta < 0 ? "−" : "±";
  const verdict = {
    reliable: ut("rch.reliable"),
    within: ut("rch.within"),
    noSem: ut("rch.noSem"),
    versions: ut("rch.versions"),
  }[shift.verdict];
  const moved = shift.from && shift.to && shift.from.label !== shift.to.label;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-[8px] gap-y-[2px]">
      <span>
        <b className="font-mono text-text tabular-nums">
          {sign}
          {num(Math.abs(shift.delta))}
        </b>{" "}
        {ut("rch.since")} {day(shift.prevAt)}
      </span>
      {shift.to ? (
        <>
          <span aria-hidden>·</span>
          {moved ? (
            <span className="inline-flex items-center gap-[6px]">
              <BandWord band={shift.from!} />
              <span aria-hidden>→</span>
              <BandWord band={shift.to} />
            </span>
          ) : (
            <BandWord band={shift.to} />
          )}
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span className={cx(shift.verdict === "reliable" && "font-bold text-text-2")}>{verdict}</span>
    </span>
  );
}

function TrendFigure({ s, height }: { s: TrendScale; height: number }) {
  return (
    <Figure title={s.title} caption={<ShiftLine s={s} />}>
      <BandTrend
        label={s.title}
        rungs={s.rungs}
        sem={s.sem}
        height={height}
        points={s.points.map((p) => ({
          key: p.responseId,
          t: Date.parse(p.at),
          label: day(p.at),
          value: p.value,
          band: p.band,
          focus: p.focus,
        }))}
      />
    </Figure>
  );
}

export function DynamicsSection({ detail, dyn }: { detail: ResponseDetail; dyn: RespondentDynamics }) {
  const { ut } = useLang();
  const view = buildTrends(detail, dyn);
  const [picked, setPicked] = useState<string | null>(null);

  if (view.kind === "single") {
    return (
      <RuleSection title={ut("rch.dynamics")}>
        <p className="m-0 text-[15px] leading-[20px] text-muted">{ut("rch.single")}</p>
      </RuleSection>
    );
  }

  const { scales } = view;
  const many = scales.length > MAX_MULTIPLES;
  const current = scales.find((s) => s.code === picked) ?? scales[0]!;
  const notes = [
    !view.focusInSeries ? ut("rch.notInSeries") : null,
    scales.some((s) => s.mixedVersions) ? ut("rch.mixedVersions") : null,
  ].filter(Boolean);

  return (
    <RuleSection
      title={ut("rch.dynamics")}
      hint={ut("rch.dynamicsHint")}
      actions={
        many ? (
          <Select
            aria-label={ut("rch.pickScale")}
            value={current.code}
            onChange={(e) => setPicked(e.target.value)}
            className="w-[320px] max-w-full"
          >
            {scales.map((s) => (
              <option key={s.code} value={s.code}>
                {s.title}
              </option>
            ))}
          </Select>
        ) : null
      }
    >
      {notes.length ? (
        <div className="mb-[18px] flex flex-col gap-[4px]">
          {notes.map((n) => (
            <p key={n} className="m-0 text-[13px] leading-[18px] text-muted">
              {n}
            </p>
          ))}
        </div>
      ) : null}

      {many ? (
        <>
          <TrendFigure s={current} height={260} />
          {/*
            Сдвиги всех шкал строками под выбранным графиком: график — одной
            шкалы, а вопрос «что сдвинулось с прошлого раза» — обо всех, и
            перебирать ради ответа одиннадцать пунктов списка незачем.
          */}
          <Figure title={ut("rch.shifts")} className="mt-[36px]">
            <ul className="m-0 list-none p-0">
              {scales.map((s) => (
                <li
                  key={s.code}
                  className="grid grid-cols-[minmax(96px,220px)_minmax(0,1fr)] items-baseline gap-x-[24px] border-b border-hairline py-[8px] max-[600px]:grid-cols-1"
                >
                  <span className="text-[15px] font-bold leading-[20px] text-primary">{s.title}</span>
                  <span className="text-[13px] leading-[18px] text-muted">
                    <ShiftLine s={s} />
                  </span>
                </li>
              ))}
            </ul>
          </Figure>
        </>
      ) : (
        <div className={scales.length === 1 ? "grid" : MULTIPLES}>
          {scales.map((s) => (
            <TrendFigure key={s.code} s={s} height={scales.length === 1 ? 260 : 200} />
          ))}
        </div>
      )}
    </RuleSection>
  );
}

/* ─────────── вклад пунктов ─────────── */

/** Сколько пунктов видно сразу; остальные — раскрытием */
const TOP_ITEMS = 10;

function ContributionFigure({ s, wide }: { s: ScaleContribution; wide: boolean }) {
  const { ut } = useLang();
  const [open, setOpen] = useState(false);
  const shown = open ? s.items : s.items.slice(0, TOP_ITEMS);
  const hidden = s.items.length - TOP_ITEMS;
  return (
    <Figure
      title={s.title}
      caption={s.unanswered ? fill(ut("rch.unanswered"), { n: s.unanswered, m: s.size }) : undefined}
      className={wide ? "max-w-[860px]" : undefined}
    >
      {s.items.length ? (
        <HBars
          max={s.top}
          items={shown.map((i) => ({
            key: i.questionId,
            /*
              Номер впереди — по нему пункт находится на вкладке «Відповіді».
              Пометка критического варианта — словом и до названия: название
              длинное и обрезается с конца, а пометка обрезаться не должна.
            */
            label: (
              <>
                <span className="font-mono tabular-nums">{fill(ut("rch.itemN"), { n: i.number })}</span>
                {i.critical ? <span className="font-bold text-danger"> · {ut("cases.criticalOption")}</span> : null}{" "}
                {i.title}
              </>
            ),
            value: i.value,
            text: `${num(i.value)} ${ut("common.of")} ${num(i.max)}`,
            strong: i.critical,
          }))}
        />
      ) : (
        <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("rch.noContribution")}</p>
      )}
      {hidden > 0 ? (
        <Button variant="quiet" className="mt-[10px]" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? ut("rch.less") : fill(ut("rch.more"), { n: hidden })}
        </Button>
      ) : null}
    </Figure>
  );
}

export function ContributionSection({ detail, survey }: { detail: ResponseDetail; survey: SurveyFull | null }) {
  const { ut } = useLang();
  if (!survey) {
    return (
      <RuleSection title={ut("rch.contribution")}>
        <p className="m-0 text-[13px] leading-[19px] text-muted">{ut("rch.versionMissing")}</p>
      </RuleSection>
    );
  }
  const view = buildContributions(detail, survey);
  if (view.stale) {
    return (
      <RuleSection title={ut("rch.contribution")}>
        <p className="m-0 text-[13px] leading-[19px] text-muted">{ut("rsp.staleVersion")}</p>
      </RuleSection>
    );
  }
  if (!view.scales.length) return null;
  const one = view.scales.length === 1;
  return (
    <RuleSection title={ut("rch.contribution")} hint={ut("rch.contributionHint")}>
      <div className={one ? "grid" : MULTIPLES}>
        {view.scales.map((s) => (
          <ContributionFigure key={s.scaleId} s={s} wide={one} />
        ))}
      </div>
    </RuleSection>
  );
}

/* ─────────── как отвечал ─────────── */

const LOCALES: Record<string, string> = { uk: "uk-UA", ru: "ru-RU", en: "en-GB" };

export function AnsweringSection({
  detail,
  tooFastMs,
  locale,
}: {
  detail: ResponseDetail;
  tooFastMs: number | null;
  locale: string;
}) {
  const { ut } = useLang();
  const a = buildAnswering(detail, tooFastMs);
  if (!a.items.length) return null;

  /* секунды с одним знаком и запятой того языка, на котором страница: «3,4», а не «3.4» */
  const fmt = new Intl.NumberFormat(LOCALES[locale] ?? "uk-UA", { maximumFractionDigits: 1 });
  const secs = (ms: number) => fmt.format(ms / 1000);
  const threshold = secs(a.thresholdMs);

  /* общее время — минутами, пока их больше одной: «4,2 хв» читается быстрее, чем «252 с» */
  const total: { value: string; unit: string } | null =
    a.totalMs === null
      ? null
      : a.totalMs >= 60_000
        ? { value: fmt.format(a.totalMs / 60_000), unit: ut("rch.min") }
        : { value: secs(a.totalMs), unit: ut("rch.sec") };

  const item = (n: number) => fill(ut("rch.itemN"), { n });

  return (
    <RuleSection title={ut("rch.answering")} hint={ut("rch.answeringHint")}>
      <div className="grid grid-cols-4 gap-[15px] max-[900px]:grid-cols-2">
        <Kpi label={ut("rch.totalTime")} value={total?.value ?? null} unit={total?.unit} />
        <Kpi label={ut("rch.medianTime")} value={a.medianMs === null ? null : secs(a.medianMs)} unit={ut("rch.sec")} />
        <Kpi label={ut("rch.changedCount")} value={a.changed.length} />
        <Kpi label={ut("rch.skippedCount")} value={a.unanswered} />
      </div>

      <Figure title={ut("rch.timeChart")} caption={fill(ut("rch.timeCaption"), { t: threshold })} className="mt-[32px]">
        {a.timed ? (
          <ItemTimes
            label={ut("rch.timeChart")}
            threshold={a.thresholdMs / 1000}
            thresholdLabel={ut("rch.threshold")}
            fastLabel={ut("rch.fastList")}
            aboveLabel={ut("rch.aboveAxis")}
            unit={ut("rch.sec")}
            columns={a.items.map((i) => ({
              key: i.questionId,
              label: String(i.number),
              title: item(i.number),
              value: Math.round(i.ms / 100) / 10,
              fast: i.fast,
            }))}
          />
        ) : (
          <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("rch.noTimes")}</p>
        )}
      </Figure>

      <dl className="m-0 mt-[24px] grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[24px] gap-y-[8px] text-[15px] leading-[20px] max-[600px]:grid-cols-1">
        <Listed
          term={`${ut("rch.fastList")} (${threshold} ${ut("rch.sec")})`}
          items={a.fast.map(item)}
          none={a.timed ? ut("rch.noneWord") : "—"}
        />
        <Listed
          term={ut("rch.changedList")}
          items={a.changed.map((c) => (c.times > 1 ? `${item(c.number)} ×${c.times}` : item(c.number)))}
          none={ut("rch.noneWord")}
        />
      </dl>
    </RuleSection>
  );
}

function Listed({ term, items, none }: { term: ReactNode; items: string[]; none: string }) {
  return (
    <>
      <dt className="font-bold text-muted">{term}</dt>
      <dd className={cx("m-0 min-w-0", items.length ? "font-mono text-text-2 tabular-nums" : "text-muted")}>
        {items.length ? items.join(", ") : none}
      </dd>
    </>
  );
}
