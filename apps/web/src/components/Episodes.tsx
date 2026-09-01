import { useState } from "react";
import { api, openInTab } from "../api";
import { day } from "../format";
import { Empty, useAction } from "../ui";
import { Panel } from "../ui/layout";
import { Button, Field, Input, Num, Select } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import type { UiKey } from "@quizzy/shared";

const OUTCOME_KEY: Record<string, UiKey> = {
  improved: "ep.outImproved",
  stable: "ep.outStable",
  worse: "ep.outWorse",
  referred: "ep.outReferred",
  dropped: "ep.outDropped",
  transferred: "ep.outTransferred",
};

/**
 * Обращения человека.
 *
 * Единица, которой не хватало: приёмы, заключения и направления лежали рядом,
 * но не были связаны, и «с чем человек приходил в марте и чем это кончилось»
 * приходилось складывать в голове.
 *
 * Счётчики приходят с сервера собранными. Считать их тремя запросами с экрана
 * значило бы вернуть человека к тому же складыванию, только быстрее.
 */
export function Episodes({ patientId, appointmentId }: { patientId: string; appointmentId?: string }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.episodes(patientId), [patientId]);
  const reload = res.reload;

  const [reason, setReason] = useState("");
  const [closing, setClosing] = useState<string | null>(null);
  const [outcomeKind, setOutcomeKind] = useState("improved");
  const [outcome, setOutcome] = useState("");

  const items = res.data?.items ?? [];
  const open = items.find((e) => !e.closedAt) ?? null;

  return (
    <Panel title={ut("ep.title")}>
      <div className="flex flex-col gap-3 p-4">
        {/*
          Открыть можно только когда открытого нет. Правило написано рядом с
          кнопкой, а не спрятано в отказе сервера: человек должен понимать,
          почему кнопки нет, до того как начнёт её искать.
        */}
        {!open ? (
          <div className="flex flex-col gap-2">
            <Field label={ut("ep.reason")} hint={ut("ep.reasonHint")}>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.openEpisode({ patientId, reason: reason.trim() || null });
                  setReason("");
                  await reload();
                })
              }
            >
              {ut("ep.open")}
            </Button>
          </div>
        ) : (
          <p className="text-caption text-muted">{ut("ep.oneOpen")}</p>
        )}

        {/*
          Карта целиком — здесь же, рядом с обращениями: человека собирают в
          один документ ровно тогда, когда смотрят его обращения, а не ищут
          отдельную кнопку на четвёртом экране.
        */}
        <button className="btn" onClick={() => openInTab(`/api/reports/patients/${patientId}/chart`)}>
          {ut("ep.chart")}
        </button>

        <Dispensary patientId={patientId} />

        {items.length === 0 ? <Empty title={ut("ep.none")} /> : null}

        {items.map((e) => (
          <div key={e.id} className="rounded-md border border-hairline p-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-caption text-muted">
                {e.closedAt
                  ? `${ut("ep.closedAt")} ${day(e.closedAt)}`
                  : `${ut("ep.openSince")} ${day(e.openedAt)}`}
              </span>
              {e.leadName ? <span className="text-caption text-muted">{e.leadName}</span> : null}
              <span className="ml-auto text-caption text-muted">
                <Num>{e.visits}</Num> {ut("ep.visits")} · <Num>{e.conclusions}</Num>{" "}
                {ut("ep.conclusions")} · <Num>{e.referrals}</Num> {ut("ep.referrals")}
              </span>
            </div>

            {e.reason ? <p className="mt-1 text-body">{e.reason}</p> : null}
            {e.outcomeKind ? (
              <p className="mt-1 text-caption">
                {ut(OUTCOME_KEY[e.outcomeKind] ?? "ep.outStable")}
                {e.outcome ? ` · ${e.outcome}` : ""}
              </p>
            ) : null}

            <div className="mt-2 flex flex-wrap gap-2">
              {/*
                Выписка — только у закрытого и у идущего: это лист, который
                подшивают, и его берут по факту, а не «на всякий случай».
              */}
              <button className="btn" onClick={() => openInTab(`/api/reports/episodes/${e.id}`)}>
                {ut("ep.extract")}
              </button>

              {appointmentId && !e.closedAt ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    run(() => api.attachVisit(e.id, appointmentId).then(reload), ut("ep.attached"))
                  }
                >
                  {ut("ep.attachVisit")}
                </Button>
              ) : null}

              {!e.closedAt ? (
                <Button size="sm" variant="ghost" onClick={() => setClosing(e.id)}>
                  {ut("ep.close")}
                </Button>
              ) : null}
            </div>

            {closing === e.id ? (
              <div className="mt-2 flex flex-col gap-2">
                {/*
                  Исход — разряд плюс слова. «Улучшение» без пояснения через
                  год не читается, а пояснение без разряда не считается.
                */}
                <Field label={ut("ep.outcome")}>
                  <Select value={outcomeKind} onChange={(ev) => setOutcomeKind(ev.target.value)}>
                    {Object.entries(OUTCOME_KEY).map(([k, key]) => (
                      <option key={k} value={k}>
                        {ut(key)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={ut("ep.outcomeWords")}>
                  <Input value={outcome} onChange={(ev) => setOutcome(ev.target.value)} />
                </Field>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await api.closeEpisode(e.id, outcomeKind, outcome.trim() || null);
                      setClosing(null);
                      setOutcome("");
                      await reload();
                    })
                  }
                >
                  {ut("ep.close")}
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </Panel>
  );
}


/**
 * Диспансерный учёт.
 *
 * Держали в голове и в бумажном журнале — и теряли: просрочка не была видна
 * никому, пока кто-нибудь случайно не вспомнит. Здесь срок виден рядом с
 * человеком, а просрочка попадает в общую очередь работы.
 */
function Dispensary({ patientId }: { patientId: string }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.dispensary(patientId), [patientId]);
  const reload = res.reload;
  const [group, setGroup] = useState("");
  const [months, setMonths] = useState(3);

  const d = res.data;
  if (!d) return null;

  if (!d.on) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-hairline p-3">
        <p className="text-micro uppercase tracking-[var(--tracking-label)] text-faint">
          {ut("disp.title")}
        </p>
        <p className="text-caption text-muted">{ut("disp.notOn")}</p>
        <Field label={ut("disp.group")} hint={ut("disp.groupHint")}>
          <Input value={group} onChange={(e) => setGroup(e.target.value)} />
        </Field>
        <Field label={ut("disp.every")}>
          <Input
            type="number"
            min={1}
            max={36}
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
          />
        </Field>
        <Button
          size="sm"
          disabled={busy || !group.trim()}
          onClick={() =>
            run(async () => {
              await api.setDispensary({ patientId, groupLabel: group.trim(), intervalMonths: months });
              setGroup("");
              await reload();
            })
          }
        >
          {ut("disp.put")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-hairline p-3">
      <p className="text-micro uppercase tracking-[var(--tracking-label)] text-faint">
        {ut("disp.title")}
      </p>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span>{d.groupLabel}</span>
        <span className="text-caption text-muted">
          {ut("disp.next")} <Num>{d.nextDueAt ? day(d.nextDueAt) : "—"}</Num>
        </span>
        {d.lastSeenAt ? (
          <span className="text-caption text-muted">
            {ut("disp.lastSeen")} <Num>{day(d.lastSeenAt)}</Num>
          </span>
        ) : null}
        {/*
          Просрочка числом дней, а не пометкой: «на три дня» и «на полгода» —
          разный разговор, и одинаковым знаком их делать нельзя.
        */}
        {(d.overdueDays ?? 0) > 0 ? (
          <span className="text-caption text-accent">
            {ut("disp.overdue")} <Num>{d.overdueDays}</Num>
          </span>
        ) : null}
      </div>
      <p className="text-caption text-muted">{ut("disp.seenNote")}</p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => run(() => api.dispensarySeen(patientId).then(reload))}
        >
          {ut("disp.seen")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => run(() => api.dispensaryRemove(patientId).then(reload))}
        >
          {ut("disp.remove")}
        </Button>
      </div>
    </div>
  );
}
