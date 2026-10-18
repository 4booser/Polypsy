import { useState } from "react";
import { cx } from "../../ui/cx";
import { Ic } from "../../ui/icons";
import { Panel } from "../../ui/layout";
import { Button, ErrorText, Field, Input } from "../../ui/primitives";
import { useLang } from "../../lang";
import { G } from "./glyphs";
import { hoursProblem } from "./model";
import { PROBLEM_KEY, type Row, SHORT_KEY, WEEK, WEEKDAY_KEY } from "./WeekEdit";

/** Часы дня одной строкой: «09:00–12:00, 14:00–17:00» и длительность приёма */
export function dayHours(rows: readonly Row[], weekday: number): { hours: string; minutes: string } | null {
  const day = rows.filter((r) => r.weekday === weekday).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  if (!day.length) return null;
  return {
    hours: day.map((r) => `${r.startsAt}–${r.endsAt}`).join(", "),
    minutes: [...new Set(day.map((r) => r.slotMinutes))].join("/"),
  };
}

/**
 * Обычная неделя: чтение по дням и складывание одним рядком.
 *
 * Неделю по умолчанию читают, а не правят: настраивают расписание раз в год,
 * а смотрят на него постоянно — «во сколько я во вторник», «принимаю ли в
 * пятницу». Правка по дням — в панели справа («Змінити»), а здесь — то, что
 * знает о своём приёме любой человек: в какие дни, с которого по который час
 * и сколько длится приём. Обеденный перерыв и короткая пятница иначе не
 * задаются — для них правка по дням.
 */
export function RegularWeek({
  rows,
  onEdit,
  onBuild,
}: {
  rows: Row[];
  onEdit: () => void;
  /** Неделя, собранная одним рядком: экран спросит подтверждения и сохранит */
  onBuild: (rows: Row[]) => void;
}) {
  const { ut } = useLang();
  return (
    <Panel
      title={ut("sched.week")}
      icon={<G.calendarRange />}
      actions={
        <Button size="xs" icon={<Ic.pen />} onClick={onEdit}>
          {ut("v2s.change")}
        </Button>
      }
    >
      {/* все семь дней, включая выходные: отсутствие строки на вопрос «принимаю ли я в субботу» не отвечает */}
      <dl className="m-0">
        {WEEK.map((weekday) => {
          const d = dayHours(rows, weekday);
          return (
            <div
              key={weekday}
              className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-baseline gap-2.5 border-t border-divider py-[7px] text-small first:border-t-0 first:pt-0"
            >
              <dt className="font-extrabold capitalize text-text" title={ut(WEEKDAY_KEY[weekday]!)}>
                {ut(SHORT_KEY[weekday]!)}
              </dt>
              <dd className={cx("m-0 tabular-nums", d ? "text-text-2" : "text-muted")}>{d ? d.hours : ut("sched.dayOff")}</dd>
              <dd className="m-0 whitespace-nowrap text-caption text-muted">
                {d ? ut("sched.perSlot").replace("{n}", d.minutes) : null}
              </dd>
            </div>
          );
        })}
      </dl>
      <QuickWeek onBuild={onBuild} />
    </Panel>
  );
}

/**
 * Неделя одним рядком: дни, часы, длительность — и «Скласти тиждень».
 *
 * Построчная неделя спрашивала то же самое пять раз подряд, и заполнить её
 * без ошибки труднее, чем сказать вслух. Сохраняет экран — после окна
 * подтверждения: рядок заменяет все часы, что стоят сейчас.
 */
function QuickWeek({ onBuild }: { onBuild: (rows: Row[]) => void }) {
  const { ut } = useLang();
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("17:00");
  const [minutes, setMinutes] = useState(50);

  const toggle = (d: number) => setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  /* та же проверка, что у строки недели: «с 17 до 9» и приём в 0 минут не раскладываются по дням */
  const problem = hoursProblem({ startsAt: from, endsAt: to, slotMinutes: minutes });

  return (
    <div className="mt-3 rounded-[12px] bg-panel-2 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
      <b className="block text-h3 font-extrabold text-text">{ut("sched.simple")}</b>
      <div role="group" aria-label={ut("v2s.days")} className="mb-2.5 mt-2 flex flex-wrap gap-1">
        {WEEK.map((d) => {
          const on = days.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              aria-label={ut(WEEKDAY_KEY[d]!)}
              onClick={() => toggle(d)}
              className={cx(
                "h-[30px] min-w-[34px] cursor-pointer rounded-pill border-0 px-2 text-caption font-bold capitalize",
                "transition-colors duration-[var(--dur-fast)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                on ? "bg-violet text-onfill" : "bg-transparent text-text-2 hover:bg-sunk-2",
              )}
            >
              {ut(SHORT_KEY[d]!)}
            </button>
          );
        })}
      </div>
      {/*
        Каждое поле в своей ячейке: отступ под Field снимается только у
        последнего в родителе. Время — парой во всю ширину: в колонке 330 у
        поля времени с выбором часов иначе срезаются минуты.
      */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Field label={ut("sched.from")}>
            <Input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
        </div>
        <div>
          <Field label={ut("sched.to")}>
            <Input type="time" value={to} aria-invalid={problem === "order" || undefined} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <div>
          <Field label={ut("sched.slotMinutes")}>
            <Input
              type="number"
              min={5}
              max={480}
              value={minutes}
              aria-invalid={problem === "slot" || undefined}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </Field>
        </div>
        <div className="self-end">
          <Button
            className="w-full"
            disabled={!days.length || problem !== null}
            onClick={() => onBuild(days.map((weekday) => ({ weekday, startsAt: from, endsAt: to, slotMinutes: minutes })))}
          >
            {ut("sched.apply")}
          </Button>
        </div>
      </div>
      {problem ? <ErrorText className="mt-2">{ut(PROBLEM_KEY[problem])}</ErrorText> : null}
      <p className="m-0 mt-2 text-caption font-bold text-warn">{ut("sched.applyWarn")}</p>
    </div>
  );
}
