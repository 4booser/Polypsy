import { useMemo } from "react";
import { Link } from "react-router-dom";
import { pointValueTop } from "@quizzy/shared";
import { CourseChart, CourseLegend } from "../../charts/course";
import { CourseSpark } from "../../charts/courseGrid";
import { courseEventsFromTimeline, courseFromDynamics, cutoffOf, laneEvents, signalsOn } from "../../charts/courseModel";
import { day, severityKey, timeOfDay } from "../../format";
import { useLang } from "../../lang";
import { Ic, Loading, TextAction, Tooltip } from "../../ui";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { withCount } from "../../ui/plural";
import { Button, SeverityTag, Tag } from "../../ui/primitives";
import { api } from "../../api";
import { useResource } from "../../useResource";
import { basisText, openSuggestions } from "../methods/passport";
import { shortDate, splitCode } from "../methods/model";
import { DESTINATION_KEY, URGENCY_KEY } from "../referrals/model";
import { CLINICAL_DOMAIN_KEY, capital, initialsName, shownSeriesText } from "../patients/model";
import { InlineAction } from "./Banner";
import { chartNames, signalGroups, type PictureGroup, type PictureRow } from "./clinical";
import { daysBetween, dm, wdm } from "./format";
import { Pi } from "./icons";
import type { CardView } from "./types";
import { ChangeWords, ScoreText } from "./words";

/*
 * «Огляд» рабочего места — что с человеком и что дальше, за десять секунд.
 *
 *   слева  — «Клінічна картина»: по строке на методику, сгруппированные по
 *            клиническим доменам (депресія, тривога, травма, сон…), — балл с
 *            максимумом, полоса словом, сдвиг от первого замера словом
 *            («значуще погіршення»), дата и ход линией. Тяжёлое и рисковое —
 *            первым. Строка ведёт в «Динаміку» этой методики, балл — в протокол.
 *   справа — «Ризик і безпека» (что подняло открытый случай, кто его ведёт,
 *            план безпеки), «План» (приёмы, назначенное, направления, учёт) и
 *            «Останні записи» (последняя запись прийому и заключение).
 *
 *   ниже картины — «Курс»: малые графики до трёх методик с повторными
 *            замерами, подряд, а не переключателем (графики участка
 *            charts/course.tsx); все методики и шкалы — в «Динаміці».
 *
 * Чего здесь больше нет и почему: ленты «За останні 30 днів» (восемь строк
 * «Сигнал …» одной минуты — её дом «Хронологія», а сигналы сложены в
 * «Ризику»), «Вільних вікон поруч» (перенос — в ящике переписки), пунктов
 * (они в «Динаміці» выбранной методики).
 */

export function Overview({ v }: { v: CardView }) {
  /*
   * Две колонки, пока ширины хватает правой: на 1280 со списком (780 под
   * запись) — гибкая левая и правая 296, без списка — правая 360. Уже — одна
   * колонка, правые панели уходят вниз.
   *
   * Короткая картина (замеров нет или их два-три) — «Останні записи» встают
   * под неё, а не третьими справа: иначе левая колонка — стена пустоты рядом
   * с длинной правой.
   */
  const rows = v.picture.reduce((n, g) => n + g.rows.length, 0);
  const short = !!v.dynamics && rows <= 3;
  return (
    <div className="@container">
      <div className="grid items-start gap-4 @min-[740px]:grid-cols-[minmax(0,1fr)_296px] @min-[1040px]:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          <ClinicalPicture v={v} />
          {short ? <RecentRecords v={v} /> : null}
          <CoursePanel v={v} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <RiskPanel v={v} />
          <PlanPanel v={v} />
          {short ? null : <RecentRecords v={v} />}
        </div>
      </div>
    </div>
  );
}

/* ─────────── клінічна картина ─────────── */

const DOMAIN_KEY = CLINICAL_DOMAIN_KEY;

function ClinicalPicture({ v }: { v: CardView }) {
  const { ut, lang } = useLang();
  if (!v.dynamics) {
    return (
      <Panel title={ut("ws.picture")} icon={<Pi.chartSpline />}>
        <Loading rows={5} bare error={v.dynamicsError} onRetry={v.reloadDynamics} />
      </Panel>
    );
  }
  const groups = v.picture;
  const methods = new Set(groups.flatMap((g) => g.rows.map((r) => r.surveyId))).size;
  const lastAt = groups.flatMap((g) => g.rows.map((r) => r.last.submittedAt)).sort().at(-1);
  return (
    <Panel
      title={ut("ws.picture")}
      icon={<Pi.chartSpline />}
      sub={lastAt ? `${withCount(ut("ws.methodsN"), methods, lang)} · ${ut("ws.lastMeasure").replace("{d}", dm(lastAt))}` : undefined}
      flush
    >
      {!groups.length ? (
        <NoMeasures v={v} />
      ) : (
        <div className="@container/pic border-t border-divider">
          {groups.map((g) => (
            <DomainGroup key={g.domain} g={g} v={v} />
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Замеров нет: что назначено и что сделать — строкой и кнопкой, без стены пустоты */
function NoMeasures({ v }: { v: CardView }) {
  const { ut } = useLang();
  const pending = v.assignments;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-t border-divider px-4 py-4">
      <span className="min-w-0 flex-1">
        <b className="block text-body font-extrabold text-text">{ut("ws.noMeasures")}</b>
        <span className="block text-small text-text-2">
          {pending.length
            ? ut("ws.noMeasuresAssigned")
                .replace("{s}", pending.map((a) => `«${a.title}»`).join(", "))
                .replace("{d}", pending[0]!.dueAt ? ` ${ut("card.dueOn").replace("{d}", dm(pending[0]!.dueAt))}` : "")
            : ut("ws.noMeasuresHint")}
        </span>
      </span>
      {v.onAssign ? (
        <Button size="xs" icon={<Pi.clipboardPlus />} onClick={v.onAssign}>
          {ut("pg.assignTest")}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Домен — колонкой слева, методики домена — строками справа: домен читается
 * первым словом строки, а не заголовком над ней, и картина из шести доменов
 * помещается на первый экран 1280 × 800.
 */
function DomainGroup({ g, v }: { g: PictureGroup; v: CardView }) {
  const { ut } = useLang();
  return (
    <section
      aria-label={ut(DOMAIN_KEY[g.domain])}
      className="gap-0 border-b border-divider last:border-b-0 @min-[420px]/pic:grid @min-[420px]/pic:grid-cols-[104px_minmax(0,1fr)] @min-[700px]/pic:grid-cols-[132px_minmax(0,1fr)]"
    >
      <h3 className="m-0 px-4 pb-0 pt-2.5 text-caption font-extrabold leading-[16px] text-text-2 @min-[420px]/pic:pb-2.5 @min-[420px]/pic:pr-1">
        {ut(DOMAIN_KEY[g.domain])}
      </h3>
      <ul className="m-0 list-none p-0">
        {g.rows.map((r) => (
          <PictureLine key={r.key} r={r} v={v} />
        ))}
      </ul>
    </section>
  );
}

function PictureLine({ r, v }: { r: PictureRow; v: CardView }) {
  const { ut, lang } = useLang();
  const values = r.points.map((p) => p.rawScore);
  const open = () => v.goTab("dynamics", { m: r.surveyId });
  /* малый курс строки (charts/courseGrid.tsx): полосы лестницы, порог, линия замеров; числа — в соседних ячейках */
  const spark = r.points.map((p) => ({ t: Date.parse(p.submittedAt), value: p.rawScore }));
  return (
    /*
     * Узкая панель (1280 со списком) — две строки: методика, балл и полоса;
     * под ними сдвиг словами, дата и ход. Широкая — одна строка столбцами.
     */
    <li
      onClick={(e) => {
        /* строка ведёт в «Динаміку» методики; ссылки внутри — свои */
        if ((e.target as HTMLElement).closest("a,button,[tabindex]")) return;
        open();
      }}
      className={cx(
        "grid cursor-pointer items-center gap-x-2.5 gap-y-1 border-t border-divider px-4 py-2 first:border-t-0 hover:bg-panel-2",
        "grid-cols-[96px_auto_minmax(0,1fr)_auto] [grid-template-areas:'code_score_band_band''change_change_change_aside']",
        "@min-[420px]/pic:pl-0 @min-[420px]/pic:pr-3.5",
        "@min-[900px]/pic:grid-cols-[104px_88px_minmax(0,1fr)_minmax(0,232px)_auto] @min-[900px]/pic:py-2.5 @min-[900px]/pic:[grid-template-areas:'code_score_band_change_aside']",
      )}
    >
      {/*
        Код — до двух строк по границе слова («Шкала / Розенберга», «Flourishing
        / Scale»), а не обрезка: кнопка сама переполнение не режет, а
        центрирует, и узкая колонка показывала середину кода («AD PERSON»).
      */}
      <span className="flex min-w-0 items-start gap-1.5 [grid-area:code]">
        {r.signal ? (
          <Tooltip label={ut("ws.signalHere")}>
            <span
              tabIndex={0}
              role="img"
              aria-label={ut("ws.signalHere")}
              className="mt-[2px] inline-flex shrink-0 rounded-[4px] text-risk-ink outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]"
            >
              <Ic.alert size={14} />
            </span>
          </Tooltip>
        ) : null}
        <button
          type="button"
          onClick={open}
          title={r.scaleTitle && r.scaleTitle !== r.surveyTitle ? `${r.surveyTitle} — ${r.scaleTitle}` : r.surveyTitle}
          className="block min-h-0 min-w-0 cursor-pointer rounded-[4px] border-0 bg-transparent p-0 text-left text-[14px] font-extrabold leading-[18px] text-text outline-none hover:underline focus-visible:shadow-[0_0_0_2px_var(--vring)]"
        >
          <span className="line-clamp-2">{r.code}</span>
        </button>
      </span>
      <Link
        to={`/surveys/${r.surveyId}/responses/${r.last.responseId}`}
        title={ut("ws.openProtocol")}
        className="justify-self-start rounded-[6px] px-0.5 no-underline outline-none hover:bg-violet-tint focus-visible:shadow-[0_0_0_2px_var(--vring)] [grid-area:score] @min-[900px]/pic:justify-self-end"
      >
        <ScoreText p={r.last} />
      </Link>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 [grid-area:band]">
        {r.last.severity || r.last.bandLabel ? (
          <SeverityTag level={r.last.severity ?? "none"} small className="!h-auto min-h-[22px] max-w-full !whitespace-normal py-[3px] leading-[14px]">
            {r.last.bandLabel ?? ut(severityKey[r.last.severity ?? "none"])}
          </SeverityTag>
        ) : (
          <span className="text-small text-muted">{ut("ws.noBands")}</span>
        )}
        {r.unreliable ? <span className="text-caption font-bold text-warn">{ut("ws.unreliable")}</span> : null}
        {/* другие шкалы методики в этом домене — в «Динаміці» по щелчку на строку */}
        {r.folded ? <span className="text-caption text-muted">{withCount(ut("ws.moreScales"), r.folded, lang)}</span> : null}
      </span>
      <span className="min-w-0 [grid-area:change]">
        <ChangeWords r={r} />
      </span>
      <span className="flex items-center justify-end gap-2.5 justify-self-end [grid-area:aside]">
        <span className="whitespace-nowrap text-caption tabular-nums text-muted">{dm(r.last.submittedAt)}</span>
        <CourseSpark
          points={spark}
          rungs={r.rungs}
          max={pointValueTop(r.last)}
          width={80}
          height={24}
          label={`${r.code}: ${shownSeriesText(values, r.last.normalization).join(" → ")}`}
        />
      </span>
    </li>
  );
}

/* ─────────── курс ─────────── */

/**
 * «Курс»: малые графики методик с повторными замерами — один под другим, а
 * не переключателем: по соседней методике человеку могло стать хуже, и это
 * видно без нажатий. Не больше трёх, в порядке картины (тяжёлое и рисковое
 * первым); все методики и шкалы — в «Динаміці». Легенда значков — одна.
 */
const COURSE_MAX = 3;

function CoursePanel({ v }: { v: CardView }) {
  const { ut } = useLang();
  const events = useMemo(() => courseEventsFromTimeline(v.timeline ?? []), [v.timeline]);
  if (!v.dynamics) return null;
  const all = v.picture.flatMap((g) => g.rows);
  const rows = all.filter((r, i) => r.points.length > 1 && all.findIndex((x) => x.surveyId === r.surveyId) === i).slice(0, COURSE_MAX);
  if (!rows.length) return null;
  const charts = rows.map((r) => ({
    r,
    data: courseFromDynamics(r.scale, r.rungs, undefined, { surveyId: r.surveyId }),
    /* у свёрнутой методики график — её самой тяжёлой шкалы, и шапка называет шкалу */
    names: chartNames(r, !r.folded && all.filter((x) => x.surveyId === r.surveyId).length === 1),
  }));
  return (
    <Panel
      title={ut("dyn.course")}
      icon={<Pi.chartSpline />}
      actions={<TextAction onClick={() => v.goTab("dynamics")}>{ut("card.tDynamics")}</TextAction>}
    >
      <div className="flex flex-col gap-4">
        {charts.map(({ r, data, names }, i) => (
          <div key={r.key} className={cx(i > 0 && "border-t border-divider pt-4")}>
            <CourseChart title={r.code} measure={names.measure} method={names.method} {...data} events={events} size="compact" legend={false} />
          </div>
        ))}
      </div>
      <CourseLegend
        cutoff={charts.some((c) => cutoffOf(c.data.rungs)) || null}
        signal={charts.some((c) => signalsOn(c.data.points, events, c.data.scaleCode).size > 0)}
        lane={charts.flatMap((c) => laneEvents(c.data.points, events)).filter((e, i, list) => list.indexOf(e) === i)}
      />
    </Panel>
  );
}

/* ─────────── ризик і безпека ─────────── */

function RiskPanel({ v }: { v: CardView }) {
  const { ut, lang } = useLang();
  const reviewer = v.can("alerts.review");
  const cases = v.cases ?? [];
  const open = cases.length > 0;
  const groups = signalGroups(cases);
  const shown = groups.slice(0, 3);
  const lastSignal = (v.timeline ?? []).filter((e) => e.kind === "alert").sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  return (
    <Panel
      title={ut("ws.riskPanel")}
      icon={<Pi.shieldAlert />}
      tone={open ? "risk" : "neutral"}
    >
      <div className="flex flex-col gap-2.5">
        {!reviewer ? null : v.casesError && !v.cases ? (
          <p className="m-0 flex items-center gap-2 text-small font-bold text-risk-ink">
            {ut("rr.casesFailed")}
            <InlineAction onClick={v.reloadCases}>{ut("common.retry")}</InlineAction>
          </p>
        ) : !v.cases ? (
          <Loading rows={2} bare />
        ) : open ? (
          <>
            <p className="m-0 text-small text-text-2">
              {ut("ws.caseOpened").replace("{d}", `${dm(cases[0]!.openedAt)}, ${timeOfDay(cases[0]!.openedAt)}`)}
              {" · "}
              {cases[0]!.assignedToName ? (
                ut("ws.riskTaken").replace("{n}", initialsName(cases[0]!.assignedToName))
              ) : (
                <b className="font-bold text-risk-ink">{ut("ws.riskNotTaken")}</b>
              )}
            </p>
            <div>
              <p className="m-0 mb-1 text-caption font-bold text-muted">{ut("ws.triggers")}</p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {shown.map((g) => (
                  <li key={g.key} className="flex items-start gap-2 text-small leading-[18px]">
                    <i
                      aria-hidden
                      className={cx("mt-[5px] size-2 shrink-0", g.severity === "severe" ? "rotate-45 bg-risk" : "rounded-full bg-warn")}
                    />
                    <span className="line-clamp-2 min-w-0 flex-1 text-text" title={g.label}>
                      {g.label}
                    </span>
                    {g.count > 1 ? (
                      <span className="shrink-0 whitespace-nowrap text-caption text-muted">{withCount(ut("ws.times"), g.count, lang)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {groups.length > shown.length && reviewer ? (
                <InlineAction onClick={() => v.open("signal")}>{withCount(ut("ws.moreTriggers"), groups.length - shown.length, lang)}</InlineAction>
              ) : null}
            </div>
          </>
        ) : (
          <p className="m-0 text-small text-text-2">
            {ut("ws.noOpenCasesFull")}
            {lastSignal ? <span className="text-muted"> · {ut("ws.lastSignal").replace("{d}", dm(lastSignal.at))}</span> : null}
          </p>
        )}
        <PlanLine v={v} risky={open} />
      </div>
    </Panel>
  );
}

/** План безпеки: «плану немає» — только по ответу сервера; при открытом случае — янтарём */
function PlanLine({ v, risky }: { v: CardView; risky: boolean }) {
  const { ut } = useLang();
  if (!v.planKnown) {
    return v.planError ? (
      <div role="alert" className="flex items-center gap-2 rounded-[12px] bg-sunk px-3 py-2 text-small text-text-2">
        <span className="min-w-0 flex-1">
          <b className="font-bold text-text">{ut("rr.safetyPlan")}: </b>
          {v.planError}
        </span>
        <InlineAction onClick={v.reloadPlan}>{ut("common.retry")}</InlineAction>
      </div>
    ) : (
      <Loading rows={1} bare />
    );
  }
  return (
    /*
     * Две строки: «План безпеки», под ним — состояние и действие. Кнопка
     * справа от текста в узкой колонке рвала «План безопасности: не
     * составлен» на три строки.
     */
    <div className={cx("flex items-start gap-2 rounded-[12px] px-3 py-2 text-small leading-[18px]", !v.plan && risky ? "bg-warn-tint" : "bg-sunk")}>
      <Ic.shieldCheck size={15} className={cx("mt-px shrink-0", v.plan ? "text-good" : risky ? "text-warn" : "text-muted")} />
      <span className="min-w-0 flex-1">
        <b className="block font-bold text-text">{ut("rr.safetyPlan")}</b>
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span className={cx(!v.plan && risky ? "font-bold text-warn" : v.plan ? "text-text" : "text-text-2")}>
            {v.plan ? ut("ws.planVersion").replace("{v}", String(v.plan.version)) : ut("ws.planNotMade")}
            {v.plan ? <span className="font-normal text-muted"> · {day(v.plan.reviewedAt ?? v.plan.createdAt)}</span> : null}
          </span>
          <InlineAction onClick={() => v.open("plan")}>{v.plan ? ut("card.open") : ut("sp.create")}</InlineAction>
        </span>
      </span>
    </div>
  );
}

/* ─────────── план ─────────── */

function PlanItem({ icon, tone, title, sub, action }: { icon: React.ReactNode; tone?: "warn"; title: React.ReactNode; sub?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 border-t border-divider py-2 first:border-t-0 first:pt-0 last:pb-0">
      <span className={cx("mt-px inline-flex shrink-0 [&>svg]:size-4", tone === "warn" ? "text-warn" : "text-violet-ink")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cx("block text-small font-bold leading-[18px]", tone === "warn" ? "text-warn" : "text-text")}>{title}</span>
        {sub ? <span className="block text-caption leading-[16px] text-muted">{sub}</span> : null}
      </span>
      {action ? <span className="shrink-0">{action}</span> : null}
    </li>
  );
}

function PlanPanel({ v }: { v: CardView }) {
  const { ut, lang } = useLang();
  const items: React.ReactNode[] = [];
  /*
   * Ступенчатый скрининг на виду: положительная короткая форма (PHQ-2 ≥ 3)
   * предлагает полную (PHQ-9) — правилом каталога. Предложение жило только в
   * ящике «Призначити методику» и в протоколе короткой формы, и врач,
   * открывший карточку, о нём не узнавал. Здесь — строкой плана с
   * основанием; «Призначити» открывает тот же ящик, где предложение стоит
   * первым, со сроком и комментарием. Право — то же, что на очередь
   * предложений (alerts.review).
   */
  const hits = useResource(() => api.ruleHits("suggested", v.card.id), [v.card.id], {
    enabled: v.can("alerts.review"),
    keep: false,
  });
  const recommended = useMemo(() => openSuggestions(hits.data ?? []), [hits.data]);
  const upcoming = v.card.upcoming ?? [];
  const book = v.can("appointments.manage");

  if (v.next) {
    const known = upcoming.find((u) => u.id === v.next!.id) ?? null;
    const later = upcoming.filter((u) => u.id !== v.next!.id && Date.parse(u.at) > Date.parse(v.next!.at));
    items.push(
      <PlanItem
        key="next"
        icon={<Pi.calendarClock />}
        title={`${capital(wdm(v.next.at))}, ${timeOfDay(v.next.at)}`}
        sub={[
          known ? `${ut(known.kind === "primary" ? "card.nxPrimary" : "card.nxRepeat")}, ${ut(known.mode === "remote" ? "card.online" : "card.onsite")}` : null,
          v.nextIsMine ? ut("ws.withYou") : ut("ws.visitWith").replace("{n}", initialsName(v.next.specialist)),
          later.length ? ut("ws.thenOn").replace("{d}", `${wdm(later[0]!.at)}, ${timeOfDay(later[0]!.at)}`) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      />,
    );
  } else if (v.noShow) {
    items.push(
      <PlanItem
        key="noshow"
        tone="warn"
        icon={<Pi.calendarX />}
        title={ut("ws.noShowUnbooked").replace("{d}", dm(v.noShow.at))}
        sub={initialsName(v.noShow.specialist)}
        action={book ? <InlineAction onClick={() => v.open("book")}>{ut("card.bookAgain")}</InlineAction> : undefined}
      />,
    );
  } else if (v.timeline) {
    items.push(
      <PlanItem
        key="none"
        icon={<Pi.calendarPlus />}
        title={ut("ws.visitNoneFull")}
        action={book ? <InlineAction onClick={() => v.open("book")}>{ut("card.book")}</InlineAction> : undefined}
      />,
    );
  }

  for (const { hit, target } of recommended.slice(0, 2)) {
    const names = splitCode(target.title);
    const code = names.code ?? names.name;
    items.push(
      <PlanItem
        key={`s-${target.surveyId}`}
        icon={<Pi.clipboardPlus />}
        title={ut("dpc.recommended").replace("{code}", code)}
        sub={ut("dpc.basisOn").replace("{basis}", basisText(hit, lang)).replace("{date}", shortDate(hit.createdAt))}
        action={
          v.onAssign ? (
            <InlineAction onClick={v.onAssign}>{ut(target.clinician ? "dpc.administerOne" : "dpc.assignOne").replace("{code}", code)}</InlineAction>
          ) : undefined
        }
      />,
    );
  }

  for (const a of v.assignments.slice(0, 3)) {
    const overdue = a.dueAt ? Date.parse(a.dueAt) < v.now : false;
    items.push(
      <PlanItem
        key={`a-${a.id}`}
        tone={overdue ? "warn" : undefined}
        icon={<Pi.clipboardClock />}
        title={ut("ws.assignedSet").replace("{s}", a.title)}
        sub={
          a.dueAt
            ? overdue
              ? ut("card.overdueDays").replace("{n}", String(Math.max(1, daysBetween(a.dueAt, v.now))))
              : ut("card.dueOn").replace("{d}", dm(a.dueAt))
            : ut("card.assignedOn").replace("{d}", dm(a.at))
        }
      />,
    );
  }

  for (const r of v.card.openReferrals ?? []) {
    items.push(
      <PlanItem
        key={`r-${r.id}`}
        icon={<Ic.arrowRight />}
        title={`${ut("evt.referralTo")} ${ut(DESTINATION_KEY[r.destination])}`}
        sub={[capital(ut(URGENCY_KEY[r.urgency])), ut("ws.issuedOn").replace("{d}", dm(r.createdAt)), r.status === "accepted" ? ut("st.accepted") : null]
          .filter(Boolean)
          .join(" · ")}
        action={v.can("referrals.manage") ? <InlineAction onClick={() => v.goTab("referrals")}>{ut("card.open")}</InlineAction> : undefined}
      />,
    );
  }

  const d = v.card.dispensary;
  if (d) {
    items.push(
      <PlanItem
        key="disp"
        tone={d.overdue ? "warn" : undefined}
        icon={<Ic.eye />}
        title={ut("ws.dispensary").replace("{g}", d.groupLabel)}
        sub={d.overdue ? ut("ws.dispensaryOverdue").replace("{d}", dm(d.nextDueAt)) : ut("card.dueOn").replace("{d}", dm(d.nextDueAt))}
      />,
    );
  }

  return (
    <Panel title={ut("ws.plan")} icon={<Pi.listTodo />}>
      {!v.timeline && !v.timelineError ? (
        <Loading rows={2} bare />
      ) : (
        <>
          {v.timelineError ? (
            <p className="m-0 mb-2 flex items-center gap-2 text-small text-text-2">
              {ut("ws.timelineFailed")}
              <InlineAction onClick={v.reloadTimeline}>{ut("common.retry")}</InlineAction>
            </p>
          ) : null}
          {items.length ? <ul className="m-0 list-none p-0">{items}</ul> : <p className="m-0 text-small text-muted">{ut("ws.planEmpty")}</p>}
        </>
      )}
    </Panel>
  );
}

/* ─────────── останні записи ─────────── */

const NOTE_KIND = { intake: "note.intake", session: "note.session", observation: "note.observation", consult: "note.consult" } as const;

function RecentRecords({ v }: { v: CardView }) {
  const { ut } = useLang();
  const note = v.notes?.versions[0] ?? null;
  const concl = v.card.conclusions[0] ?? null;
  return (
    <Panel
      title={ut("ws.recent")}
      icon={<Pi.notebookText />}
      actions={note || concl ? <TextAction onClick={() => v.goTab("records")}>{ut("ws.allRecords")}</TextAction> : undefined}
    >
      {!v.notes && !v.notesError ? (
        <Loading rows={2} bare />
      ) : !note && !concl ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="m-0 text-small text-muted">{ut("ws.noRecords")}</p>
          {v.can("notes.write") ? (
            <Button size="xs" icon={<Pi.notebookPen />} onClick={() => v.open("note")}>
              {ut("ws.newNote")}
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {note ? (
            <RecordPeek
              title={`${ut("ws.note")} · ${ut(NOTE_KIND[note.kind]).toLowerCase()}`}
              meta={`${dm(note.signedAt ?? note.createdAt)} · ${initialsName(note.authorName)}`}
              draft={note.status === "draft"}
              text={note.text}
              action={
                note.status === "draft" && v.can("notes.write") ? (
                  <InlineAction onClick={() => v.open("note")}>{ut("card.continue")}</InlineAction>
                ) : undefined
              }
            />
          ) : null}
          {concl ? (
            <RecordPeek
              title={ut("ws.conclOf").replace("{s}", concl.surveyTitle)}
              meta={`${dm(concl.signedAt ?? concl.createdAt)} · ${initialsName(concl.authorName)}`}
              draft={concl.status === "draft"}
              text={concl.text}
              action={
                concl.status === "draft" && v.can("conclusions.write") ? (
                  <InlineAction onClick={() => v.open("concl", { responseId: concl.responseId })}>{ut("card.continue")}</InlineAction>
                ) : (
                  <Link to={`/responses/${concl.responseId}/conclusion`} className="text-small font-bold text-violet-ink">
                    {ut("card.open")}
                  </Link>
                )
              }
            />
          ) : null}
        </ul>
      )}
      {v.notesError && !v.notes ? (
        <p className="m-0 mt-2 flex items-center gap-2 text-small text-text-2">
          {ut("note.loadFailed")}
          <InlineAction onClick={v.reloadNotes}>{ut("common.retry")}</InlineAction>
        </p>
      ) : null}
    </Panel>
  );
}

function RecordPeek({ title, meta, draft, text, action }: { title: string; meta: string; draft: boolean; text: string; action?: React.ReactNode }) {
  const { ut } = useLang();
  return (
    <li className="border-t border-divider py-2.5 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-2">
        <b className="min-w-0 truncate text-small font-extrabold text-text" title={title}>
          {title}
        </b>
        {draft ? <Tag className="!h-5">{ut("card.draft")}</Tag> : null}
        <span className="ml-auto shrink-0">{action}</span>
      </div>
      <p className="m-0 mt-0.5 text-caption text-muted">{meta}</p>
      {text ? <p className="m-0 mt-1 line-clamp-2 whitespace-pre-wrap text-small leading-[18px] text-text-2">{text}</p> : null}
    </li>
  );
}
