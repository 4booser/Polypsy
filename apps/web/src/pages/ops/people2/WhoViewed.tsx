import { useState } from "react";
import type { PatientPick, Role, WhoViewedReport } from "@quizzy/shared";
import { api } from "../../../api";
import { dateTime, dayFull, timeOfDay } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, useAction } from "../../../ui";
import { Button, Input } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { SearchField, metaClass, useDebounced } from "../controls";
import { ROLE_KEY, actionLabel } from "../model";
import { WhoViewedCharts } from "./charts";
import { defaultPeriod, whoViewedCsv } from "./model";
import { Empty, Section, saveText } from "./parts";

/*
 * Техпанель → «Хто переглядав» (people2, пункт 21).
 *
 * Отчёт по запросу пациента или проверяющего: кто из персонала открывал
 * данные этого человека за период — карта, прохождения, заключения, записи
 * приёма, выгрузки, вход от его имени. Сгруппировано по сотруднику и дню,
 * действия — человеческими словами (те же, что у вкладки «Аудит»).
 *
 * Печать — средствами браузера и печатными значениями токенов проекта
 * (styles/tokens.css, @media print): отбор и кнопки в печать не идут
 * (print:hidden), отчёт — идёт. CSV — из того же ответа, в браузере: сам
 * отчёт уже записан в журнал на сервере (audit.subject_report), и второй
 * поход за тем же ради файла был бы второй строкой журнала о том же.
 *
 * Право — audit.read: это чтение журнала, только в разрезе одного человека.
 */
export default function OpsWhoViewed() {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [q, setQ] = useState("");
  const settled = useDebounced(q.trim());
  const [picked, setPicked] = useState<PatientPick | null>(null);
  const [period, setPeriod] = useState(() => defaultPeriod(new Date()));
  const [report, setReport] = useState<WhoViewedReport | null>(null);

  const found = useResource(() => api.patientPick(settled), [settled], { enabled: !picked && settled.length >= 2 });
  const label = (action: string) => actionLabel(action, ut);

  const build = () =>
    void run(async () => {
      if (!picked) return false;
      setReport(await api.whoViewed(picked.id, period.from, period.to));
    });

  return (
    <>
      <div className="print:hidden">
        <p className="m-0 mb-[14px] max-w-[80ch] text-[13px] leading-[18px] text-muted">{ut("ops.who.hint")}</p>
        {picked ? (
          <div className="mb-[12px] flex flex-wrap items-center gap-x-[16px] gap-y-[6px]">
            <span className="min-w-0">
              <span className="block text-[17px] font-bold leading-[22px] text-primary [overflow-wrap:anywhere]">{picked.fullName}</span>
              <span className={metaClass}>
                {picked.email}
                {picked.birthYear ? ` · ${picked.birthYear}` : ""}
              </span>
            </span>
            <Button
              variant="quiet"
              onClick={() => {
                setPicked(null);
                setReport(null);
              }}
            >
              {ut("ops.who.change")}
            </Button>
          </div>
        ) : (
          <div className="mb-[12px] max-w-[520px]">
            <SearchField label={ut("ops.who.search")} value={q} onChange={setQ} />
            {settled.length >= 2 ? (
              found.error ? (
                <Loading error={found.error} onRetry={found.reload} />
              ) : !found.data ? (
                <Loading rows={2} />
              ) : found.data.length === 0 ? (
                <Empty>{ut("pt.nobodyFound")}</Empty>
              ) : (
                <ul className="m-0 mt-[6px] list-none p-0" aria-label={ut("ops.who.patient")}>
                  {found.data.map((p) => (
                    <li key={p.id} className="border-b border-hairline">
                      <button
                        type="button"
                        onClick={() => setPicked(p)}
                        className="block w-full cursor-pointer border-0 bg-transparent px-[4px] py-[8px] text-left outline-none hover:bg-primary-tint focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                      >
                        <span className="block text-[15px] font-bold leading-[20px] text-primary">{p.fullName}</span>
                        <span className={metaClass}>
                          {p.email}
                          {p.birthYear ? ` · ${p.birthYear}` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </div>
        )}

        <div className="mb-[18px] flex flex-wrap items-center gap-[12px]">
          <Input
            look="fill"
            type="date"
            aria-label={ut("ops.audit.from")}
            title={ut("ops.audit.from")}
            value={period.from}
            onChange={(e) => setPeriod({ ...period, from: e.target.value })}
            className="w-[180px]"
          />
          <Input
            look="fill"
            type="date"
            aria-label={ut("ops.audit.to")}
            title={ut("ops.audit.to")}
            value={period.to}
            onChange={(e) => setPeriod({ ...period, to: e.target.value })}
            className="w-[180px]"
          />
          <Button disabled={busy || !picked || !period.from || !period.to} onClick={build}>
            {ut("ops.who.build")}
          </Button>
          {report ? (
            <>
              <span className="flex-1" />
              <Button variant="ghost" onClick={() => window.print()}>
                {ut("ops.who.print")}
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  saveText(
                    whoViewedCsv(report, label, [
                      ut("ops.who.staff"),
                      ut("person.email"),
                      ut("adm.role"),
                      ut("ops.who.day"),
                      ut("ops.who.action"),
                      ut("ops.who.count"),
                      ut("ops.who.first"),
                      ut("ops.who.last"),
                      ut("ops.who.as"),
                    ]),
                    `who-viewed-${report.patient.email}-${report.from}-${report.to}.csv`,
                  )
                }
              >
                {ut("ops.audit.export")}
              </Button>
            </>
          ) : null}
        </div>
        {!picked ? <Empty>{ut("ops.who.choose")}</Empty> : null}
      </div>

      {report ? <Report report={report} label={label} /> : null}
    </>
  );
}

function Report({ report, label }: { report: WhoViewedReport; label: (action: string) => string }) {
  const { ut } = useLang();
  return (
    <article aria-label={ut("ops.who.reportTitle")}>
      <header className="mb-[16px]">
        <h2 className="m-0 text-[20px] font-bold leading-[24px] text-primary">{ut("ops.who.reportTitle")}</h2>
        <p className="m-0 mt-[6px] text-[17px] font-bold leading-[22px] text-text">
          {report.patient.fullName} <span className="font-normal text-text-2">· {report.patient.email}</span>
        </p>
        <p className={metaClass}>
          {ut("ops.who.period")}: <span className="font-mono tabular-nums">{report.from} — {report.to}</span> · {ut("ops.who.generated")}{" "}
          {dateTime(report.generatedAt)} · <span className="font-mono tabular-nums">{report.total}</span> {ut("ops.who.actions")}
        </p>
      </header>
      {/* волна 11: когда и что — графиками над разделами «кто»; пустой отчёт их не получает */}
      <WhoViewedCharts report={report} label={label} />
      {report.actors.length === 0 ? (
        <Empty>{ut("ops.who.nobody")}</Empty>
      ) : (
        report.actors.map((a) => (
          <Section
            key={a.actorId}
            className="break-inside-avoid-page"
            title={a.actorName || a.actorEmail || a.actorId}
            aside={
              <span className="text-[13px] text-muted">
                {a.actorEmail}
                {a.actorRole ? ` · ${ut(ROLE_KEY[a.actorRole as Role] ?? "adm.roleAdmin")}` : ""} ·{" "}
                <span className="font-mono tabular-nums">{a.total}</span> {ut("ops.who.actions")}
              </span>
            }
          >
            <ul className="m-0 list-none p-0">
              {a.days.map((d) => (
                <li
                  key={d.day}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,3fr)] gap-x-[20px] border-b border-hairline py-[8px] max-[900px]:grid-cols-1"
                >
                  <span className="text-[15px] font-bold leading-[20px] text-text">{dayFull(`${d.day}T12:00:00`)}</span>
                  <ul className="m-0 list-none p-0">
                    {d.actions.map((act) => (
                      <li key={`${act.action}|${act.asUserEmail ?? ""}`} className="text-[15px] leading-[21px] text-text-2">
                        {label(act.action)} <span className="font-mono tabular-nums text-muted">× {act.count}</span>{" "}
                        <span className="font-mono text-[13px] tabular-nums text-muted">
                          {timeOfDay(act.first)}
                          {act.first !== act.last ? `–${timeOfDay(act.last)}` : ""}
                        </span>
                        {act.asUserEmail ? (
                          <span className="text-[13px] text-muted">
                            {" "}
                            · {ut("ops.who.as")} {act.asUserEmail}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </Section>
        ))
      )}
    </article>
  );
}
