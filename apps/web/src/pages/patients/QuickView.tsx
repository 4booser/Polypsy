import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { PatientListItem, UiKey } from "@quizzy/shared";
import { api } from "../../api";
import { severityKey } from "../../format";
import { useLang } from "../../lang";
import { ActivityList, AlertChip, AlertStrip, Callout, DrawerSection, Ic, KV, Loading, TextAction, Tooltip } from "../../ui";
import { Button, ButtonLink, SeverityTag } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { DESTINATION_KEY, STATUS_KEY, URGENCY_KEY } from "../referrals/model";
import type { PaneParts } from "./actions";
import { useSettledValue, type Via } from "../../components/settledSelection";
import { eventView } from "./events";
import { instrumentsOf } from "./instruments";
import { ageOf, CLINICAL_DOMAIN_KEY, ddmm, hhmm, kitSeverity, whenShort } from "./model";
import { clinicalPicture } from "../patientCard/clinical";
import { ChangeWords, ScoreText } from "../patientCard/words";

/*
 * «Хто це» — быстрый просмотр человека из реестра (кадр patients-quick-view):
 * ящик рядом с таблицей, ↑↓ ходят по строкам, страница стоит на месте.
 *
 * Не вторая карта, а ответ на вопрос «открывать ли карту»: что открыто по
 * человеку (сигнал, неявка, черновик, учёт), чем меряли и куда сдвинулось,
 * когда следующий приём и как связаться, что было недавно. Всё прочее —
 * в карточке и справе, куда ведут кнопки внизу.
 */

export function useQuickViewPane({
  person,
  via = "click",
  position,
  onStep,
  onWrite,
  onAssign,
  locale,
}: {
  person: PatientListItem | null;
  /** Чем сменили человека: шаг J/K и стрелками — его записи ждут, пока курсор остановится */
  via?: Via;
  /** Место строки в реестре: «Рядок 1 з 20, ризик спершу» */
  position: { at: number; of: number; sort: string } | null;
  onStep: (d: 1 | -1) => void;
  onWrite: () => void;
  onAssign: () => void;
  locale: string;
}): PaneParts {
  const { ut } = useLang();
  const navigate = useNavigate();
  const id = person?.id ?? "";
  /*
   * Сводка, карточка, динамика и хронология — чтения, которые сервер пишет
   * в журнал. Шаг клавишами их не грузит, пока курсор не простоит
   * SETTLE_MS: строка, мимо которой прошли, — не прочитанная. Шапка (имя,
   * подразделение, строка открытого из реестра) видна сразу.
   */
  const settledId = useSettledValue(person?.id ?? null, via);
  const enabled = !!person && settledId === person.id;
  /* keep: false — данные прежнего человека не стоят под именем следующего (#177) */
  const dyn = useResource(() => api.dynamics(id), [id], { enabled, keep: false });
  const sum = useResource(() => api.caseSummary(id), [id], { enabled, keep: false });
  const card = useResource(() => api.patientCard(id), [id], { enabled, keep: false });
  const tl = useResource(() => api.timeline(id), [id], { enabled, keep: false });
  const instruments = useMemo(() => instrumentsOf(dyn.data), [dyn.data]);
  const picture = useMemo(
    () => clinicalPicture(dyn.data, card.data?.domains).flatMap((g) => g.rows),
    [dyn.data, card.data?.domains],
  );
  const now = Date.now();
  const words = { today: ut("plist.today"), tomorrow: ut("plist.tomorrow") };

  if (!person) return { title: ut("pt.whoIsThis"), body: <p className="m-0 py-4 text-small text-muted">{ut("pt.pickRow")}</p> };

  const age = ageOf(person.birthYear, now);
  const sub = [
    age !== null ? `${age} ${ut("pg.yearSuffix")}` : null,
    person.sex === "male" ? ut("adm.male").toLowerCase() : person.sex === "female" ? ut("adm.female").toLowerCase() : null,
    person.unit,
  ]
    .filter(Boolean)
    .join(", ");

  const alerts = sum.data?.openAlerts ?? [];
  const drafts = (sum.data?.conclusions ?? []).filter((c) => !c.signedAt);
  const openRefs = (sum.data?.referrals ?? []).filter((r) => r.status === "created" || r.status === "accepted");
  const lastAt = instruments.map((i) => i.lastAt ?? "").sort().at(-1);
  const measures = instruments.reduce((n, i) => n + i.responseCount, 0);

  const strip = (
    <AlertStrip>
      {person.lastNoShowAt ? (
        <AlertChip
          kind="warn"
          icon={<Ic.calendar />}
          label={ut("plist.noShow").replace("{d}", ddmm(person.lastNoShowAt, locale))}
          to={`/patients/${id}?tab=timeline&kind=visit`}
        />
      ) : null}
      {drafts.map((c) => (
        <AlertChip
          key={c.responseId}
          icon={<Ic.pen />}
          label={ut("qv.draft")}
          detail={c.surveyTitle}
          draft
          to={`/responses/${c.responseId}/conclusion`}
        />
      ))}
      {person.dispensary ? (
        <AlertChip
          kind={person.dispensary.overdue ? "warn" : "neutral"}
          icon={<Ic.eye />}
          label={person.dispensary.overdue ? ut("plist.checkOverdue") : ut("plist.onRecord")}
          detail={person.dispensary.groupLabel}
        />
      ) : null}
      {openRefs.length ? (
        <AlertChip
          icon={<Ic.arrowRight />}
          label={ut("ref.title")}
          detail={String(openRefs.length)}
          to={`/patients/${id}?tab=referrals`}
        />
      ) : null}
    </AlertStrip>
  );
  const anyOpen = alerts.length || person.lastNoShowAt || drafts.length || person.dispensary || openRefs.length;

  return {
    title: person.name,
    sub,
    icon: <Ic.user />,
    headerExtra: position ? (
      <div className="flex items-center gap-2 text-small text-muted">
        <Ic.table size={14} />
        <span>
          {ut("qv.row")
            .replace("{n}", String(position.at + 1))
            .replace("{of}", String(position.of))
            .replace("{sort}", position.sort)}
        </span>
        <span className="ml-auto flex gap-0.5">
          <Tooltip label={ut("qv.prev")} kbd="K">
            <Button variant="quiet" size="icon-sm" aria-label={ut("qv.prev")} disabled={position.at <= 0} onClick={() => onStep(-1)}>
              <Ic.arrowUp />
            </Button>
          </Tooltip>
          <Tooltip label={ut("qv.next")} kbd="J">
            <Button
              variant="quiet"
              size="icon-sm"
              aria-label={ut("qv.next")}
              disabled={position.at >= position.of - 1}
              onClick={() => onStep(1)}
            >
              <Ic.arrowDown />
            </Button>
          </Tooltip>
        </span>
      </div>
    ) : undefined,
    footer: (
      <>
        <ButtonLink variant="primary" to={`/patients/${id}`}>
          <Ic.external size={16} className="mr-2" />
          {ut("pt.openCard")}
        </ButtonLink>
        <Tooltip label={ut("plist.write")}>
          <Button size="icon" aria-label={ut("plist.write")} onClick={onWrite}>
            <Ic.message />
          </Button>
        </Tooltip>
        <Tooltip label={ut("pg.assignTest")}>
          <Button size="icon" aria-label={ut("pg.assignTest")} onClick={onAssign}>
            <Ic.clipboard />
          </Button>
        </Tooltip>
      </>
    ),
    body: (
      <>
        <DrawerSection title={ut("kit.openItems")}>
          {alerts.length ? (
            <Callout
              kind="risk"
              title={alerts.length > 1 ? ut("plist.signals").replace("{n}", String(alerts.length)) : ut("evt.signal")}
              actions={
                <Button variant="risk" size="xs" onClick={() => navigate(`/alerts?patient=${id}`)}>
                  {ut("plist.review")}
                </Button>
              }
            >
              {alerts.slice(0, 3).map((a) => (
                <span key={a.id} className="line-clamp-2 block">
                  {a.surveyTitle}: {a.label}, {ddmm(a.at, locale)} {hhmm(a.at, locale)}
                </span>
              ))}
            </Callout>
          ) : null}
          {anyOpen ? <div className={alerts.length ? "mt-2.5" : ""}>{strip}</div> : null}
          {!anyOpen && sum.data ? <p className="m-0 text-small text-text-2">{ut("qv.nothingOpen")}</p> : null}
          {!sum.data && !sum.error ? <Loading rows={1} bare /> : null}
          {sum.error ? <p className="m-0 text-small text-risk-ink">{sum.error}</p> : null}
        </DrawerSection>

        <DrawerSection
          title={ut("dyn.instruments")}
          sub={
            lastAt
              ? ut("qv.measuresSub").replace("{n}", String(measures)).replace("{d}", ddmm(lastAt, locale))
              : undefined
          }
        >
          {dyn.error ? (
            <p className="m-0 text-small text-risk-ink">{dyn.error}</p>
          ) : !dyn.data ? (
            <Loading rows={3} bare />
          ) : !instruments.length ? (
            <p className="m-0 text-small text-muted">{ut("pt.noCompleted")}</p>
          ) : (
            /*
             * Те же строки и те же слова, что «Клінічна картина» рабочего
             * места: домен, балл, полоса и сдвиг словом («значуще
             * погіршення»), тяжёлое первым (patientCard/clinical.ts).
             */
            <ul className="m-0 list-none p-0">
              {picture.slice(0, 6).map((r) => (
                <li key={r.key} className="border-t border-divider py-2 first:border-t-0 first:pt-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <b className="min-w-0 truncate text-[13.5px] font-extrabold text-text" title={r.surveyTitle}>
                      {r.code}
                    </b>
                    <span className="truncate text-caption text-muted">{ut(CLINICAL_DOMAIN_KEY[r.domain])}</span>
                    <span className="ml-auto shrink-0">
                      <ScoreText p={r.last} />
                    </span>
                  </div>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    {r.last.severity || r.last.bandLabel ? (
                      <SeverityTag level={kitSeverity(r.last.severity)} small className="!h-auto min-h-[22px] max-w-full !whitespace-normal py-[3px] leading-[14px]">
                        {r.last.bandLabel ?? ut(severityKey[r.last.severity ?? "none"])}
                      </SeverityTag>
                    ) : null}
                    <ChangeWords r={r} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DrawerSection>

        <DrawerSection title={ut("qv.brief")}>
          <KV
            w={128}
            rows={(
              [
                [
                  ut("plist.nextVisit"),
                  person.nextVisit ? (
                    <b className="font-bold">{whenShort(person.nextVisit.at, now, locale, words).text}</b>
                  ) : (
                    /* как в реестре: «не записано» — состояние, а не тревога */
                    <span className="text-muted">{ut("plist.notBooked")}</span>
                  ),
                ],
                [ut("plist.phone"), card.data?.phone ?? person.phone ?? "—"],
                [ut("plist.email"), person.email],
                [
                  ut("plist.lead"),
                  card.data?.lead ? `${card.data.lead.name}${card.data.lead.mine ? `, ${ut("qv.you")}` : ""}` : (person.leadName ?? ut("plist.noLead")),
                ],
                card.data?.groups.length ? [ut("sn.patientGroups"), card.data.groups.map((g) => g.title).join(", ")] : null,
                person.dispensary
                  ? [
                      ut("disp.title"),
                      `${person.dispensary.groupLabel}, ${ut("plist.dueOn").replace("{d}", ddmm(person.dispensary.nextDueAt, locale))}`,
                    ]
                  : null,
                openRefs.length
                  ? [
                      ut("ref.title"),
                      <span key="refs" className="flex flex-col gap-0.5">
                        {openRefs.map((r) => (
                          <span key={r.id}>
                            {ut(DESTINATION_KEY[r.destination])}, {ut(URGENCY_KEY[r.urgency]).toLowerCase()},{" "}
                            <span className="text-muted">{ut(STATUS_KEY[r.status]).toLowerCase()}</span>
                          </span>
                        ))}
                      </span>,
                    ]
                  : null,
              ] as ([string, React.ReactNode] | null)[]
            ).filter((r): r is [string, React.ReactNode] => r !== null)}
          />
        </DrawerSection>

        <DrawerSection
          title={ut("qv.recent")}
          right={<TextAction to={`/patients/${id}?tab=timeline`}>{ut("qv.allTimeline")}</TextAction>}
        >
          {tl.error ? (
            <p className="m-0 text-small text-risk-ink">{tl.error}</p>
          ) : !tl.data ? (
            <Loading rows={3} bare />
          ) : !tl.data.length ? (
            <p className="m-0 text-small text-muted">{ut("tl.empty")}</p>
          ) : (
            <div className="-mx-[18px] -mb-2">
              <ActivityList
                events={tl.data
                  .filter((e) => Date.parse(e.at) <= now)
                  .slice(0, 4)
                  .map((e) => {
                    const v = eventView(e, ut as (k: UiKey, f?: string) => string);
                    return {
                      date: ddmm(e.at, locale),
                      time: hhmm(e.at, locale),
                      icon: v.icon,
                      tone: v.tone,
                      text: (
                        <>
                          <b>{v.head}</b>
                          {v.rest ? ` ${v.rest}` : ""}
                        </>
                      ),
                    };
                  })}
              />
            </div>
          )}
        </DrawerSection>
      </>
    ),
  };
}
