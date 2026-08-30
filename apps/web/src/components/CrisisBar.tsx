import { createContext, useContext, useState, type ReactNode } from "react";
import { api } from "../api";
import { dateTime } from "../format";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { useAction } from "../ui";
import { useLiveReload } from "../events";

/**
 * Полоса кризисного режима.
 *
 * Режим меняет поведение системы, и человек обязан видеть, что оно изменено,
 * без открытия настроек. Изменившийся порядок очереди без объяснения читается
 * как сбой, а не как решение руководителя.
 *
 * Что именно меняется, написано прямо в полосе: режим, про который непонятно,
 * что он делает, страшнее любого потока пациентов.
 */
/*
 * Состояние режима запрашивается один раз на всё приложение.
 *
 * Показывается оно в двух местах — включателем в верхней панели и полосой во
 * всю ширину, — и это именно два вида одного состояния, а не два состояния.
 * Два независимых запроса дали бы момент, когда полоса уже есть, а
 * включатель ещё предлагает включить, — и человек не понял бы, включено или
 * нет ровно в ту минуту, когда это важнее всего.
 */
type CrisisState = Awaited<ReturnType<typeof api.crisis>>;

interface CrisisCtx {
  state: CrisisState | null;
  reload: () => void;
}

const Ctx = createContext<CrisisCtx>({ state: null, reload: () => {} });

export function CrisisProvider({ children }: { children: ReactNode }) {
  const res = useResource(() => api.crisis(), []);
  useLiveReload(["schedule.run"], res.reload);
  return <Ctx.Provider value={{ state: res.data, reload: res.reload }}>{children}</Ctx.Provider>;
}

/**
 * Включатель режима — в верхней панели.
 *
 * Отдельной строкой под панелью он висел один посреди пустой полосы во всю
 * ширину: выглядело как сломанное оформление и отнимало строку у заголовка
 * каждой страницы. Кнопка, которой пользуются раз в год, не должна занимать
 * место у той, которой пользуются каждый день.
 */
export function CrisisSwitch({ canSwitch }: { canSwitch: boolean }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const { state, reload } = useContext(Ctx);
  const [starting, setStarting] = useState(false);
  const [reason, setReason] = useState("");
  const res = { reload };

  if (!state || state.active) return null;

  /*
   * Пока режим выключен, включатель живёт в верхней панели, а не отдельной
   * строкой под ней.
   *
   * Отдельной строкой он висел один посреди пустой полосы во всю ширину —
   * выглядело так, будто оформление сломалось, и при этом занимал место
   * над заголовком каждой страницы. Кнопка, которой пользуются раз в год,
   * не должна отнимать строку у той, которой пользуются каждый день.
   */
  {
    if (!canSwitch) return null;
    return starting ? (
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="h-8 w-56"
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={ut("crisis.reason")}
        />
        <button
          className="danger min-h-8"
          disabled={busy || reason.trim().length < 3}
          onClick={() =>
            void run(async () => {
              await api.startCrisis(reason.trim());
              setStarting(false);
              setReason("");
              res.reload();
            })
          }
        >
          {ut("crisis.start")}
        </button>
        <button className="ghost min-h-8" onClick={() => setStarting(false)}>
          {ut("common.cancel")}
        </button>
      </div>
    ) : (
      <button
        className="ghost min-h-8 text-caption"
        onClick={() => setStarting(true)}
        title={ut("crisis.effects")}
      >
        {ut("crisis.start")}
      </button>
    );
  }
}

/** Полоса включённого режима — во всю ширину, под верхней панелью. */
export function CrisisBar({ canSwitch }: { canSwitch: boolean }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const { state, reload } = useContext(Ctx);
  const res = { reload };
  if (!state?.active) return null;

  return (
    <div className="crisis-bar" role="status">
      <strong>{ut("crisis.on")}</strong>
      <span>{state.reason}</span>
      <span className="muted">
        {ut("crisis.since")} {state.startedAt ? dateTime(state.startedAt) : ""}
      </span>
      <span className="muted">· {ut("crisis.effects")}</span>
      {canSwitch ? (
        <button
          className="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.endCrisis();
              res.reload();
            })
          }
        >
          {ut("crisis.end")}
        </button>
      ) : null}
    </div>
  );
}
