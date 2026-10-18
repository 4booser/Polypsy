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
import { eventView } from "./events";
import { changeOf, instrumentsOf, shownDelta, shownThreshold } from "./instruments";
import { ageOf, ddmm, hhmm, kitSeverity, shownSeries, shownValue, whenShort } from "./model";

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
  position,
  onStep,
  onWrite,
  onAssign,
  locale,
}: {
  person: PatientListItem | null;
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
  const enabled = !!person;
  /* keep: false — данные прежнего человека не стоят под именем следующего (#177) */
  const dyn = useResource(() => api.dynamics(id), [id], { enabled, keep: false });
  const sum = useResource(() => api.caseSummary(id), [id], { enabled, keep: false });
  const card = useResource(() => api.patientCard(id), [id], { enabled, keep: false });
  const tl = useResource(() => api.timeline(id), [id], { enabled, keep: false });
  const instruments = useMemo(() => instrumentsOf(dyn.data), [dyn.data]);
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
          to={`/patients/${id}/case/timeline`}
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
          to={`/patients/${id}/case`}
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
        <ButtonLink to={`/patients/${id}/case`}>{ut("pcard.clinical")}</ButtonLink>
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
            <table className="w-full table-fixed border-separate border-spacing-0 text-small">
              <colgroup>
                <col />
                <col className="w-[132px]" />
                <col className="w-[118px]" />
              </colgroup>
              <thead>
                <tr>
                  {[ut("plist.instrument"), ut("qv.now"), ut("dyn.fromStart")].map((h, n) => (
                    <th
                      key={h}
                      className={`h-8 border-b border-divider bg-panel-2 px-2 text-caption font-bold text-muted first:pl-2.5 ${n === 1 ? "text-right" : "text-left"}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {instruments.slice(0, 6).map((i) => {
                  const s = i.main;
                  const v = shownValue(s.last.rawScore, s.last.normalization);
                  const delta = changeOf(s);
                  const ratio = s.last.normalization === "ratio";
                  const shown = delta === null ? null : shownDelta(s, delta);
                  const thr = shownThreshold(s);
                  const reliable = shown !== null && thr !== null && Math.abs(shown) >= thr && shown !== 0;
                  const good = reliable && !!s.better && (s.better === "down" ? shown! < 0 : shown! > 0);
                  const was = shownSeries(s.history.slice(-2), s.last.normalization);
                  return (
                    <tr key={i.surveyId}>
                      <td className="border-b border-divider py-2 pl-2.5 pr-2 align-top">
                        <b className="block truncate font-extrabold text-text" title={i.title}>
                          {i.code}
                        </b>
                        <span className="block truncate text-caption text-muted" title={s.scale.title}>
                          {s.scale.title}
                        </span>
                        {was.length ? (
                          <span className="block text-caption tabular-nums text-text-2">{ut("kit.was").replace("{v}", was.join(" → "))}</span>
                        ) : null}
                      </td>
                      <td className="border-b border-divider px-2 py-2 text-right align-top">
                        <b className="text-[16px] font-extrabold tabular-nums text-text">
                          {v.text}
                          {v.unit ? <small className="text-caption text-muted">{v.unit}</small> : null}
                        </b>
                        {s.last.severity || s.last.bandLabel ? (
                          <span className="mt-1 flex justify-end">
                            <SeverityTag level={kitSeverity(s.last.severity)} small className="max-w-full overflow-hidden text-ellipsis">
                              {s.last.bandLabel ?? ut(severityKey[s.last.severity ?? "none"])}
                            </SeverityTag>
                          </span>
                        ) : null}
                      </td>
                      <td className="border-b border-divider px-2 py-2 align-top">
                        {shown === null ? (
                          <span className="text-caption text-muted">{i.responseCount > 1 ? "—" : ut("kit.courseStart")}</span>
                        ) : (
                          <span className="flex flex-col">
                            <b className={`text-[13.5px] font-extrabold tabular-nums ${good ? "text-good" : reliable ? "text-warn" : "text-text"}`}>
                              {shown > 0 ? `+${shown}` : shown < 0 ? `−${Math.abs(shown)}` : "0"}
                              {ratio ? ut("dyn.pp") : ""}
                            </b>
                            <span className={`text-caption ${good ? "font-bold text-good" : reliable ? "font-bold text-warn" : "text-text-2"}`}>
                              {thr === null
                                ? ut("qv.noThreshold")
                                : reliable
                                  ? good
                                    ? ut("kit.reliablyBetter")
                                    : s.better
                                      ? ut("kit.reliablyWorse")
                                      : ut("pt.reliable")
                                  : ut("kit.withinError")}
                            </span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
                    <span className="font-semibold text-warn">{ut("plist.notBooked")}</span>
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
          right={<TextAction to={`/patients/${id}/case/timeline`}>{ut("qv.allTimeline")}</TextAction>}
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
