import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { UiKey } from "@quizzy/shared";
import { api } from "../api";
import { Hint } from "../components/Hint";
import { NotesEditor } from "../components/NotesEditor";
import { SafetyPlanEditor } from "../components/SafetyPlanEditor";
import { locale, severityKey } from "../format";
import { useLang } from "../lang";
import { BetterTag, ChangeCell, Empty, Ic, Loading, TextAction, useAction } from "../ui";
import { Panel, SideLayout } from "../ui/layout";
import { Button, SeverityTag, Tag } from "../ui/primitives";
import { ShellIcon } from "../shell/icons";
import { useMedia } from "../shell/Rail";
import { useCaseCard } from "./CaseCard";
import { changeOf, instrumentsOf, measureDates, shownDelta, shownThreshold, valueOn, type Instrument } from "./patients/instruments";
import { ddmm, fmtNum, kitSeverity, shownNumber, shownValue, signedShown } from "./patients/model";
/*
 * Подписи направлений берутся из модели экрана направлений: держать вторую
 * копию тех же словарей — верный способ однажды показать «принято» в одном
 * месте и «прийнято» в другом.
 */
import { DESTINATION_KEY } from "./referrals/model";
import { NEXT_STATUS, StatusTag, UrgencyTag } from "./Referrals";

/**
 * Вкладка «Огляд справи» — кадр patients-case: что с человеком сейчас.
 *
 *   «Результати за методиками»: заміри по датах, тяжкість словом, зміна від
 *   старту з порогом і індекс RCI; многошкальная методика раскрывается по
 *   шкалам;
 *   «Заключення»: черновики и подписанные, с переходом к ним;
 *   «Направлення»: куда, терміновість, статус, підстава й відповідь, и
 *   следующий шаг статуса на месте;
 *   справа — план безпеки (в кризис открывают его) и записи прийому.
 *
 * Открытые тревоги — не карточкой здесь, а в строке открытого шапки
 * (CaseCard): «Розібрати» стоит там, где его видно с любой вкладки.
 */
export default function CaseSummaryTab() {
  const { ut } = useLang();
  const { data, dynamics, openReferral } = useCaseCard();
  const instruments = useMemo(() => instrumentsOf(dynamics.data), [dynamics.data]);
  /*
   * На 1280 колонка справа (план безпеки, записи прийому) оставляет таблице
   * около 780 px: две даты вместо трёх, индекс RCI — только во вкладке
   * «Динаміка», где у него своя панель.
   */
  const narrow = useMedia("(max-width: 1380px)");
  const dates = measureDates(instruments).slice(narrow ? -2 : -3);

  return (
    <SideLayout
      side={
        <>
          {/* план безопасности первым: в кризис открывают его */}
          <SafetyPlanEditor userId={data.userId} />
          <Panel icon={<ShellIcon name="notebook-pen" />}>
            <NotesEditor userId={data.userId} />
          </Panel>
        </>
      }
    >
      <Panel
        title={ut("case.results")}
        icon={<Ic.clipboard />}
        sub={
          instruments.length
            ? ut("case.resultsSub")
                .replace("{n}", String(instruments.length))
                .replace("{dates}", dates.map((d) => ddmm(`${d}T12:00:00`, locale())).join(", "))
            : undefined
        }
        actions={<TextAction to={`/patients/${data.userId}`}>{ut("dyn.allMeasures")}</TextAction>}
        flush
      >
        {dynamics.error && !dynamics.data ? (
          <div className="px-4 pb-4">
            <Loading bare error={dynamics.error} onRetry={dynamics.reload} />
          </div>
        ) : !dynamics.data ? (
          <div className="px-4 pb-4">
            <Loading rows={4} bare />
          </div>
        ) : !instruments.length ? (
          <div className="px-4">
            <Empty compact title={ut("pt.noCompleted")} hint={ut("dyn.emptyHint")} />
          </div>
        ) : (
          <ResultsTable instruments={instruments} dates={dates} index={!narrow} />
        )}
        <div className="px-4 pb-1">
          {/* подсказка стоит рядом с числом, а не в справке: вопрос возникает здесь */}
          <Hint id="rci" text="hint.rci" />
        </div>
      </Panel>

      <Conclusions />

      <Panel
        title={ut("ref.title")}
        icon={<ShellIcon name="arrow-right-left" />}
        count={data.referrals.length || null}
        actions={
          <>
            <TextAction to="/referrals">{ut("case.allReferrals")}</TextAction>
            <Button size="xs" icon={<Ic.plus />} onClick={openReferral}>
              {ut("ref.new")}
            </Button>
          </>
        }
        flush
      >
        <Referrals />
      </Panel>
    </SideLayout>
  );
}

/** Таблица «Результати за методиками»: строка — методика, раскрытие — её шкалы */
function ResultsTable({ instruments, dates, index }: { instruments: Instrument[]; dates: string[]; index: boolean }) {
  const { ut } = useLang();
  const [open, setOpen] = useState<string | null>(null);
  const th = "h-9 border-b border-divider bg-panel-2 px-2.5 text-caption font-bold text-muted whitespace-nowrap";
  const td = "border-b border-divider px-2.5 py-2.5 align-middle";
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-small">
        <thead>
          <tr>
            <th className={`${th} pl-4 text-left`}>{ut("plist.instrument")}</th>
            {dates.slice(0, -1).map((d) => (
              <th key={d} className={`${th} text-right`}>
                {ddmm(`${d}T12:00:00`, locale())}
              </th>
            ))}
            <th className={`${th} text-right text-text`}>{dates.length ? ddmm(`${dates.at(-1)}T12:00:00`, locale()) : ""}</th>
            <th className={`${th} text-left`}>{ut("sum.interpretation")}</th>
            <th className={`${th} text-left`}>{ut("case.changeFromStart")}</th>
            {index ? <th className={`${th} pr-4 text-right`}>{ut("case.index")}</th> : null}
          </tr>
        </thead>
        <tbody>
          {instruments.map((i) => {
            const s = i.main;
            const multi = i.scales.length > 1;
            const expanded = open === i.surveyId;
            const delta = changeOf(s);
            const ratio = s.last.normalization === "ratio";
            const lastDay = dates.at(-1);
            const atLast = lastDay ? valueOn(s, lastDay) : null;
            const big = shownValue(s.last.rawScore, s.last.normalization);
            const rc = s.scale.reliableChange;
            const thr = shownThreshold(s);
            return (
              <Fragment key={i.surveyId}>
                <tr className={expanded ? "bg-panel-2" : undefined}>
                  <td className={`${td} pl-2`}>
                    <span className="flex items-center gap-1.5">
                      {multi ? (
                        <Button
                          variant="quiet"
                          size="icon-sm"
                          aria-expanded={expanded}
                          aria-label={`${ut("case.scales")}: ${i.code}`}
                          onClick={() => setOpen(expanded ? null : i.surveyId)}
                        >
                          {expanded ? <Ic.chevronDown /> : <Ic.chevronRight />}
                        </Button>
                      ) : (
                        <span className="inline-block w-8" />
                      )}
                      <span className="min-w-0">
                        {/* длинное имя переносится, а «краще ↓» встаёт под ним, а не висит справа от трёх строк */}
                        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                          <b className="text-[14px] font-extrabold text-text">{i.code}</b>
                          {s.better ? <BetterTag direction={s.better} /> : null}
                        </span>
                        <span className="block max-w-[200px] truncate text-caption text-muted" title={s.scale.title}>
                          {s.scale.title}
                        </span>
                      </span>
                    </span>
                  </td>
                  {dates.slice(0, -1).map((d) => {
                    const p = valueOn(s, d);
                    return (
                      <td key={d} className={`${td} text-right tabular-nums text-text-2`}>
                        {p ? shownValue(p.rawScore, p.normalization).text : <span className="text-muted">—</span>}
                      </td>
                    );
                  })}
                  {/* последний замер методики — всегда; если он был не в день последней колонки, рядом его дата */}
                  <td className={`${td} text-right`}>
                    <b className="text-[26px] font-extrabold leading-none tracking-[-0.02em] tabular-nums text-text">
                      {big.text}
                      {big.unit ? <small className="ml-0.5 text-caption font-bold text-muted">{big.unit}</small> : null}
                    </b>
                    {lastDay && !atLast ? (
                      <small className="block text-caption tabular-nums text-muted">{ddmm(s.last.submittedAt, locale())}</small>
                    ) : null}
                  </td>
                  <td className={td}>
                    {s.last.severity || s.last.bandLabel ? (
                      <SeverityTag level={kitSeverity(s.last.severity)}>{s.last.bandLabel ?? ut(severityKey[s.last.severity ?? "none"])}</SeverityTag>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className={td}>
                    {delta !== null && thr !== null && s.better ? (
                      <ChangeCell delta={shownDelta(s, delta)} threshold={thr} better={s.better} unit={ratio ? ut("dyn.pp") : undefined} />
                    ) : (
                      <span className="text-caption text-text-2">{reasonOf(i, ut)}</span>
                    )}
                  </td>
                  {index ? (
                    <td className={`${td} whitespace-nowrap pr-4 text-right tabular-nums text-text-2`}>
                      {rc ? `RCI ${fmtNum(rc.rci, locale())}` : "—"}
                    </td>
                  ) : null}
                </tr>
                {expanded ? (
                  <tr>
                    <td colSpan={dates.length + (index ? 4 : 3)} className="border-b border-divider bg-panel-2 px-4 pb-3 pt-1">
                      <dl className="m-0 grid grid-cols-[minmax(0,220px)_minmax(0,1fr)] gap-x-4 gap-y-1.5 pl-10 text-small">
                        {i.scales.map((sc) => {
                          const raw = changeOf(sc);
                          const d = raw === null ? null : shownDelta(sc, raw);
                          const t = shownThreshold(sc);
                          const vals = sc.scale.points.slice(-3).map((p) => shownValue(p.rawScore, p.normalization).text);
                          const word =
                            d === null || t === null
                              ? null
                              : d !== 0 && Math.abs(d) >= t
                                ? sc.better
                                  ? (sc.better === "down" ? d < 0 : d > 0)
                                    ? ut("kit.reliablyBetter")
                                    : ut("kit.reliablyWorse")
                                  : ut("pt.reliable")
                                : ut("kit.withinError");
                          const good = word === ut("kit.reliablyBetter");
                          return (
                            <Fragment key={sc.scale.code}>
                              <dt className="truncate font-bold text-text" title={sc.scale.title}>
                                {sc.scale.title}
                              </dt>
                              <dd className="m-0 text-text-2">
                                {vals.join(" → ")}
                                {d !== null ? (
                                  <>
                                    , {signedShown(d)}
                                    {word ? (
                                      <>
                                        : <span className={good ? "font-bold text-good" : undefined}>{word}</span>
                                      </>
                                    ) : null}
                                    {t !== null ? <span className="text-muted"> ({ut("kit.threshold").replace("{n}", shownNumber(t))})</span> : null}
                                  </>
                                ) : null}
                              </dd>
                            </Fragment>
                          );
                        })}
                      </dl>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Почему у сдвига нет слова: один замер, разные версии/единицы, недостоверный протокол, нет основы RCI */
function reasonOf(i: Instrument, ut: (k: UiKey) => string): string {
  const s = i.main;
  if (s.scale.incomparable === "version") return ut("rch.versions");
  if (s.scale.incomparable === "units") return ut("rch.units");
  if (s.scale.incomparable === "unreliable") return ut("rch.unreliable");
  if (s.scale.points.length < 2) return ut("sum.oneMeasure");
  return ut("qv.noThreshold");
}

/** «Заключення»: черновики продолжают, подписанные открывают — каждое на своём прохождении */
function Conclusions() {
  const { ut } = useLang();
  const { data } = useCaseCard();
  const list = data.conclusions;
  return (
    <Panel title={ut("pcard.conclusions")} icon={<ShellIcon name="file-text" />} count={list.length || null}>
      {list.length === 0 ? (
        <p className="m-0 text-small text-muted">{ut("pcard.noConclusions")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {list.map((c) => (
            <li key={c.responseId} className="border-t border-divider py-3 first:border-t-0 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <b className="text-[14px] font-extrabold text-text">{c.surveyTitle}</b>
                {c.signedAt ? (
                  <Tag tone="good" icon={<Ic.check />}>
                    {ut("case.signed")}
                  </Tag>
                ) : (
                  <Tag icon={<Ic.pen />}>{ut("pcard.draft")}</Tag>
                )}
              </div>
              <p className="m-0 mt-1.5 line-clamp-3 whitespace-pre-wrap text-small text-text">{c.text}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-caption text-muted">
                <span>
                  {c.authorName}
                  {c.signedAt ? `, ${ddmm(c.signedAt, locale())}` : ""}
                </span>
                <Link
                  to={`/responses/${c.responseId}/conclusion`}
                  className="ml-auto text-small font-bold text-violet-ink no-underline hover:underline"
                >
                  {c.signedAt ? ut("case.open") : ut("case.continue")}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** «Направлення» справы: следующий шаг статуса — на месте строки */
function Referrals() {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const { data, reload } = useCaseCard();
  if (!data.referrals.length) {
    return (
      <div className="px-4 pb-1">
        {/* как выписать — видно и так: кнопка «Виписати направлення» стоит в шапке этой же панели */}
        <Empty compact title={ut("ref.none")} />
      </div>
    );
  }
  const th = "h-9 border-b border-divider bg-panel-2 px-2.5 text-left text-caption font-bold text-muted first:pl-4 last:pr-4";
  const td = "border-b border-divider px-2.5 py-2.5 align-top first:pl-4 last:pr-4";
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-small">
        <thead>
          <tr>
            <th className={th}>{ut("ref.where")}</th>
            <th className={th}>{ut("ref.urgency")}</th>
            <th className={th}>{ut("ref.status")}</th>
            <th className={th}>{ut("case.reasonAnswer")}</th>
            <th className={th}>{ut("ref.issued")}</th>
            <th className={th} aria-label={ut("kit.rowActions")} />
          </tr>
        </thead>
        <tbody>
          {data.referrals.map((r) => (
            <tr key={r.id}>
              <td className={`${td} font-bold text-text`}>{ut(DESTINATION_KEY[r.destination])}</td>
              {/* те же пилюли, что в реестре направлений: «негайно» — красным, это риск для человека */}
              <td className={td}>
                <UrgencyTag urgency={r.urgency} />
              </td>
              <td className={td}>
                <StatusTag status={r.status} />
              </td>
              <td className={`${td} max-w-[320px]`}>
                <span className="block text-text">{r.reason ?? "—"}</span>
                {r.outcomeNote ? (
                  <span className="mt-0.5 block text-caption text-good">
                    <b>{ut("ref.answer")}:</b> {r.outcomeNote}
                  </span>
                ) : null}
              </td>
              <td className={`${td} whitespace-nowrap`}>
                <span className="block text-text">{ddmm(r.createdAt, locale())}</span>
                <span className="text-caption text-muted">{r.createdByName}</span>
              </td>
              <td className={td}>
                <span className="flex justify-end gap-1.5 print:hidden">
                  {(NEXT_STATUS[r.status] ?? []).map((n) => (
                    <Button
                      key={n.value}
                      size="xs"
                      variant={n.value === "declined" ? "quiet" : "secondary"}
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          /*
                           * Перечитать и на отказе: 409 значит, что направление
                           * успел сдвинуть кто-то другой (волна 15), и кнопки
                           * должны встать по его нынешнему состоянию, а не по тому,
                           * на которое человек смотрел. Фраза отказа — от сервера.
                           */
                          try {
                            await api.updateReferral(r.id, n.value);
                          } finally {
                            reload();
                          }
                        }, ut(n.key))
                      }
                    >
                      {ut(n.key)}
                    </Button>
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
