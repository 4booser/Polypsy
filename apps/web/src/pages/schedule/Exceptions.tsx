import type { ScheduleExceptionView } from "@quizzy/shared";
import { api } from "../../api";
import { Callout } from "../../ui";
import { Ic } from "../../ui/icons";
import { Panel } from "../../ui/layout";
import { Button, Field, Input, Segmented } from "../../ui/primitives";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { G } from "./glyphs";
import { type ExceptionForm, clock, exceptionProblem, gridOverlap, wallOf, weekdayOf } from "./model";
import { dayMonth } from "./WeekCalendar";
import { SHORT_KEY } from "./WeekEdit";

/** «пт 16.10» — день исключения коротко */
export function useDayLabel() {
  const { ut } = useLang();
  return (date: string) => `${ut(SHORT_KEY[weekdayOf(date)]!)} ${dayMonth(date)}`;
}

/**
 * Исключения: дни, когда расписание другое.
 *
 * Снять — сразу, без вопроса: исключение заводится обратно одной формой, а
 * снятое «не приймаю» возвращает окна, и сервер сам решает их судьбу так же,
 * как при правке недели (занятое не трогается).
 */
export function ExceptionsPanel({
  items,
  busy,
  onAdd,
  onRemove,
}: {
  items: ScheduleExceptionView[];
  busy: boolean;
  onAdd: () => void;
  onRemove: (e: ScheduleExceptionView) => void;
}) {
  const { ut } = useLang();
  const label = useDayLabel();
  return (
    <Panel
      title={ut("sched.exceptions")}
      icon={<G.calendarX />}
      count={items.length || null}
      actions={
        <Button size="xs" icon={<Ic.plus />} onClick={onAdd}>
          {ut("v2s.add")}
        </Button>
      }
    >
      {items.length === 0 ? (
        <p className="m-0 text-small text-muted">{ut("sched.excNone")}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {items.map((e) => (
            <li
              key={e.id}
              className="grid grid-cols-[62px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-divider py-2 text-small leading-[17px] first:border-t-0 first:pt-0"
            >
              <span className="font-extrabold tabular-nums text-text">{label(e.date)}</span>
              <span className="min-w-0 text-text">
                <b className="font-bold">{ut(e.kind === "off" ? "sched.excOff" : "sched.excExtra")}</b>
                {", "}
                <span className="tabular-nums">{e.startsAt && e.endsAt ? `${e.startsAt}–${e.endsAt}` : ut("sched.excAllDay")}</span>
                {e.note ? <small className="block truncate text-caption text-muted">{e.note}</small> : null}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                aria-label={`${ut("sched.remove")}: ${label(e.date)}`}
                onClick={() => onRemove(e)}
              >
                {ut("sched.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Поля нового исключения и что оно заденет.
 *
 * Записи в этот день видны до сохранения: «не приймаю» поверх записанного
 * приёма приём не отменяет, а делает его «поза розкладом», и человек должен
 * знать это до нажатия, а не узнать из числа после.
 */
export function ExceptionFields({
  form,
  set,
}: {
  form: ExceptionForm;
  set: (patch: Partial<ExceptionForm>) => void;
}) {
  const { ut } = useLang();
  const problem = exceptionProblem(form);
  const day = useResource(() => api.scheduleWeek(form.date, 1), [form.date], {
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(form.date) && form.kind === "off",
  });
  const label = useDayLabel();

  /* задетые приёмы: живые и попадающие в часы «не приймаю» (пустые часы — весь день) */
  const hit =
    form.kind === "off" && day.data
      ? day.data.appointments.filter((a) => {
          if (!["booked", "confirmed", "arrived", "in_progress"].includes(a.status)) return false;
          if (!form.from || !form.to) return true;
          const s = wallOf(a.startsAt, day.data!.tz).minutes;
          const e = s + Math.round((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60_000);
          return gridOverlap(s, e, form.from, form.to);
        })
      : [];

  return (
    <>
      <Segmented
        wide
        label={ut("sched.kind")}
        value={form.kind}
        onChange={(kind) => set({ kind })}
        items={[
          { key: "off", label: ut("v2s.kindOff") },
          { key: "extra", label: ut("v2s.kindExtra") },
        ]}
      />
      <div className="mt-3.5 grid grid-cols-2 gap-x-2.5">
        <div className="col-span-2">
          <Field label={ut("sched.date")}>
            <Input type="date" data-autofocus value={form.date} onChange={(e) => set({ date: e.target.value })} />
          </Field>
        </div>
        {/*
          Часы для «не приймаю» необязательны: пустые означают весь день.
          Для дополнительных часов — обязательны, иначе непонятно, что
          добавлять; это же проверяет и сервер.
        */}
        <div>
          <Field label={ut("sched.from")} hint={form.kind === "off" && !form.from ? ut("sched.excAllDay") : undefined}>
            <Input type="time" value={form.from} onChange={(e) => set({ from: e.target.value })} />
          </Field>
        </div>
        <div>
          <Field label={ut("sched.to")} error={problem === "order" ? ut("uit.form.endBeforeStart") : undefined}>
            <Input type="time" value={form.to} onChange={(e) => set({ to: e.target.value })} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label={ut("sched.note")} optional>
            <Input value={form.note} onChange={(e) => set({ note: e.target.value })} />
          </Field>
        </div>
      </div>
      {hit.length ? (
        <Callout kind="warn" icon={<G.calendarX />} title={ut("v2s.hitTitle").replace("{day}", label(form.date))} className="mt-1">
          <ul className="m-0 mt-1 list-none p-0">
            {hit.map((a) => (
              <li key={a.id}>
                <b className="font-bold text-text">{a.patientName}</b>{" "}
                <span className="tabular-nums">{clock(wallOf(a.startsAt, day.data!.tz).minutes)}</span>
              </li>
            ))}
          </ul>
          <p className="m-0 mt-1.5">{ut("v2s.hitNote")}</p>
        </Callout>
      ) : null}
    </>
  );
}
