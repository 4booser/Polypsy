import type { ScheduleTemplateView, UiKey } from "@quizzy/shared";
import { cx } from "../../ui/cx";
import { Ic } from "../../ui/icons";
import { Button, ErrorText, Input } from "../../ui/primitives";
import { useLang } from "../../lang";
import { type HoursProblem, weekProblems } from "./model";

/** Что сказать о промежутке с ошибкой (schedule/model.ts) */
export const PROBLEM_KEY: Record<HoursProblem, UiKey> = {
  order: "uit.form.endBeforeStart",
  slot: "uit.sched.slotRange",
};

/*
 * Неделя перечислена один раз, а не литералом [1..7] в каждом месте.
 *
 * Мест этих несколько — чтение недели, группы в правке, кнопки дней в
 * простой неделе, столбцы календаря, — и каждое обязано перечислять ровно те
 * же дни в том же порядке. Недостача одного дня в одном из них выглядела бы
 * не поломкой, а расписанием без субботы: ни ошибки, ни пустого места.
 */
export const WEEK = [1, 2, 3, 4, 5, 6, 7];

/** Полные имена дней: правка недели и подписи полей для диктора */
export const WEEKDAY_KEY: Record<number, UiKey> = {
  1: "sched.mon",
  2: "sched.tue",
  3: "sched.wed",
  4: "sched.thu",
  5: "sched.fri",
  6: "sched.sat",
  7: "sched.sun",
};

/** Короткие подписи дней: срез длинного названия даёт «Че» и «Су» */
export const SHORT_KEY: Record<number, UiKey> = {
  1: "wd.1",
  2: "wd.2",
  3: "wd.3",
  4: "wd.4",
  5: "wd.5",
  6: "wd.6",
  7: "wd.7",
};

export type Row = Omit<ScheduleTemplateView, "id">;

/** Часы по умолчанию у дня, в котором приёма ещё не было */
const DEFAULT_HOURS = { startsAt: "09:00", endsAt: "13:00", slotMinutes: 50 };

/** Минуты от полуночи и обратно: HH:MM сравнивается строкой, а складывается только числом */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

function fromMinutes(total: number): string {
  const clamped = Math.max(0, Math.min(total, 23 * 60 + 59));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

/**
 * Часы для ещё одного приёмного промежутка в дне.
 *
 * Второй промежуток в дне заводят ровно по одной причине — обеденный перерыв,
 * — поэтому он начинается после конца предыдущего, а не с тех же девяти утра.
 * Прежняя кнопка «добавить часы» подставляла 09:00–13:00 независимо ни от
 * чего: в дне с приёмом до часу это давало второй промежуток поверх первого.
 * Вреда базе от него нет (слоты сходятся по уникальному ключу), но человек
 * получал строку, которую сначала надо стереть, и только потом заполнить.
 *
 * Если день упёрся в полночь, подставляются часы по умолчанию: промежуток
 * нулевой длины сервер отвергает целиком, вместе со всей неделей.
 */
export function nextHours(day: Row[]): { startsAt: string; endsAt: string; slotMinutes: number } {
  const last = day[day.length - 1];
  if (!last) return { ...DEFAULT_HOURS };
  const startsAt = fromMinutes(toMinutes(last.endsAt) + 60);
  const endsAt = fromMinutes(toMinutes(startsAt) + 240);
  if (endsAt <= startsAt) return { ...DEFAULT_HOURS };
  return { startsAt, endsAt, slotMinutes: last.slotMinutes };
}

/*
 * Ширины столбцов заданы один раз, и шапка складывается из тех же кусков,
 * что и строки, а не повторяет их числами.
 *
 * Повторение уже разъезжалось: в столбце дня стояло 150px у шапки и 132px у
 * чтения недели, и подпись «День» висела над пустотой. Здесь шапка — это
 * `DAY_COLUMN + INTERVAL_COLUMNS`, а строка дня — `DAY_COLUMN` и вложенная
 * сетка `INTERVAL_COLUMNS` с тем же зазором gap-2. Разойтись им нечем: числа
 * одни и те же, поправка в одном месте.
 */
const DAY_COLUMN = "104px";
// с · по · длительность · снять
const INTERVAL_COLUMNS = "minmax(0,1fr) minmax(0,1fr) 84px 40px";

/**
 * Правка недели: день — заголовок группы, а не значение в строке.
 *
 * Было так: плоский список промежутков, и в каждом — выпадающий список дня.
 * У специалиста с обедом понедельник стоял в списке дважды подряд, и это
 * читалось не как «понедельник, два приёма», а как «две одинаковые строки,
 * в одной из которых, наверное, опечатка». Сортировки не было вовсе: два
 * понедельника могли оказаться через четверг друг от друга.
 *
 * Теперь дней ровно семь, каждый назван один раз и стоит на своём месте.
 * Выпадающий список дня исчез вместе с возможностью выбрать день неверно:
 * промежуток заводится внутри дня и принадлежит ему по построению.
 *
 * Дни без приёма показываются наравне с остальными: «принимаю ли я в
 * субботу» — вопрос, на который отсутствие строки не отвечает, а отвечает
 * надпись «не приймаю».
 */
export function WeekEdit({ rows, onChange }: { rows: Row[]; onChange: (next: Row[]) => void }) {
  const { ut } = useLang();
  /* ошибки — у своей строки: «конец раньше начала» без номера строки в неделе из десяти не найти */
  const problems = weekProblems(rows);

  return (
    <div className="min-w-0">
      {/*
        Шапка стоит НАД столбцами, а не сбоку от полей: неделю читают сверху
        вниз, «во сколько я начинаю» — это столбец, и подпись у столбца одна.
      */}
      <div
        className="grid items-end gap-2 pb-1.5 text-caption font-bold text-muted"
        style={{ gridTemplateColumns: `${DAY_COLUMN} ${INTERVAL_COLUMNS}` }}
      >
        <span>{ut("sched.weekday")}</span>
        <span>{ut("sched.from")}</span>
        <span>{ut("sched.to")}</span>
        <span>{ut("sched.slotMinutes")}</span>
        <span />
      </div>
      {WEEK.map((weekday) => (
        <DayGroup
          key={weekday}
          weekday={weekday}
          /*
           * Промежутки дня идут в том порядке, в каком лежат в неделе, и НЕ
           * сортируются по времени начала: иначе строка уезжала бы из-под
           * курсора посреди набора. Сервер отдаёт шаблоны упорядоченными, и
           * сохранение выправляет порядок.
           */
          day={rows.flatMap((row, at) => (row.weekday === weekday ? [{ row, at, problem: problems.get(at) ?? null }] : []))}
          onChange={(at, next) => onChange(rows.map((r, j) => (j === at ? next : r)))}
          onRemove={(at) => onChange(rows.filter((_, j) => j !== at))}
          onAdd={(hours) => onChange([...rows, { weekday, ...hours }])}
        />
      ))}
    </div>
  );
}

function DayGroup({
  weekday,
  day,
  onChange,
  onRemove,
  onAdd,
}: {
  weekday: number;
  /** Промежутки дня вместе с их местом в общем списке недели (правка идёт по нему) и ошибкой, если есть */
  day: { row: Row; at: number; problem: HoursProblem | null }[];
  onChange: (at: number, next: Row) => void;
  onRemove: (at: number) => void;
  onAdd: (hours: { startsAt: string; endsAt: string; slotMinutes: number }) => void;
}) {
  const { ut } = useLang();
  const name = ut(WEEKDAY_KEY[weekday]!);

  return (
    <div
      className="grid items-start gap-x-2 border-t border-divider py-2"
      style={{ gridTemplateColumns: `${DAY_COLUMN} minmax(0,1fr)` }}
    >
      <span className={cx("py-2.5 text-body", day.length ? "font-bold text-text" : "text-muted")}>{name}</span>
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        {day.map(({ row, at, problem }) => (
          <div key={at} className="flex w-full flex-col gap-1">
            <div className="grid w-full items-center gap-2" style={{ gridTemplateColumns: INTERVAL_COLUMNS }}>
              {/*
                Подписи полей есть, но спрятаны от глаз: столбец подписан в
                шапке, а для диктора шапка — это далеко. Именем дня они
                начинаются намеренно: без него диктор читает десять пар полей
                «З», «До» подряд, и понять, в чьём дне стоит курсор, нельзя.
              */}
              <Input
                aria-label={`${name}, ${ut("sched.from")}`}
                type="time"
                value={row.startsAt}
                onChange={(e) => onChange(at, { ...row, startsAt: e.target.value })}
              />
              <Input
                aria-label={`${name}, ${ut("sched.to")}`}
                aria-invalid={problem === "order" || undefined}
                type="time"
                value={row.endsAt}
                onChange={(e) => onChange(at, { ...row, endsAt: e.target.value })}
              />
              <Input
                aria-label={`${name}, ${ut("sched.slotMinutes")}`}
                aria-invalid={problem === "slot" || undefined}
                type="number"
                min={5}
                max={480}
                value={row.slotMinutes}
                onChange={(e) => onChange(at, { ...row, slotMinutes: Number(e.target.value) })}
              />
              <Button
                aria-label={`${ut("sched.remove")}: ${name}, ${row.startsAt}–${row.endsAt}`}
                title={ut("sched.remove")}
                size="icon"
                variant="quiet"
                icon={<Ic.x />}
                onClick={() => onRemove(at)}
              />
            </div>
            {/* что не так — под той строкой, где не так: сохранение недели при этом погашено */}
            {problem ? <ErrorText>{ut(PROBLEM_KEY[problem])}</ErrorText> : null}
          </div>
        ))}
        {day.length === 0 ? <span className="py-2.5 text-small text-muted">{ut("sched.dayOff")}</span> : null}
        <Button
          aria-label={`${ut("sched.addRow")}: ${name}`}
          size="xs"
          variant="ghost"
          icon={<Ic.plus />}
          onClick={() => onAdd(nextHours(day.map((d) => d.row)))}
        >
          {ut("sched.addRow")}
        </Button>
      </div>
    </div>
  );
}
