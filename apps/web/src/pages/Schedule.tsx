import { useEffect, useState } from "react";
import type { ScheduleTemplateView, UiKey } from "@quizzy/shared";
import { api } from "../api";
import { Empty, Screen, useAction } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button, Field, Input, Num, Select } from "../ui/primitives";
import { cx } from "../ui/cx";
import { useLang } from "../lang";
import { useResource } from "../useResource";

/** Короткие подписи дней: срез длинного названия даёт «Че» и «Су» */
const SHORT_KEY: Record<number, UiKey> = {
  1: "wd.1",
  2: "wd.2",
  3: "wd.3",
  4: "wd.4",
  5: "wd.5",
  6: "wd.6",
  7: "wd.7",
};

/*
 * Неделя перечислена один раз, а не литералом [1..7] в каждом месте.
 *
 * Мест этих три — чтение недели, группы в правке, кнопки дней в простой
 * неделе, — и каждое обязано перечислять ровно те же дни в том же порядке.
 * Недостача одного дня в одном из них выглядела бы не поломкой, а
 * расписанием без субботы: ни ошибки, ни пустого места.
 */
const WEEK = [1, 2, 3, 4, 5, 6, 7];

const WEEKDAY_KEY: Record<number, UiKey> = {
  1: "sched.mon",
  2: "sched.tue",
  3: "sched.wed",
  4: "sched.thu",
  5: "sched.fri",
  6: "sched.sat",
  7: "sched.sun",
};

type Row = Omit<ScheduleTemplateView, "id">;

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

/**
 * Обычная неделя специалиста.
 *
 * Расписание читают как картину недели, и правят так же: «по вторникам с
 * девяти до часу, по четвергам с двух». Поэтому неделя задаётся целиком и
 * сохраняется одной кнопкой, а не строка за строкой: правка по одной строке
 * позволила бы половине изменений доехать, а половине нет — и человек
 * остался бы с расписанием, которого не задумывал.
 */
export default function SchedulePage() {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.schedule(), []);
  const reload = res.reload;

  const [rows, setRows] = useState<Row[] | null>(null);
  /*
   * Неделю по умолчанию читают, а не правят.
   *
   * Раньше экран открывался таблицей из шестидесяти полей ввода — по шесть
   * на каждую из десяти строк. Настраивают расписание раз в год, а смотрят
   * на него постоянно: «во сколько я во вторник», «принимаю ли в пятницу».
   * Читать это по выпадающим спискам нельзя, а случайно изменить — можно.
   *
   * Из трёх способов открыть правку выбран режим на всю неделю. Чего стоили
   * остальные:
   *
   *  — Правка одного дня на месте (нажал на четверг — четверг стал полями).
   *    Выглядит дешевле всего, но сохранять приходится по дню, а сервер
   *    такого не умеет и уметь не должен: PUT /api/clinic/schedule стирает
   *    ВСЕ шаблоны специалиста и кладёт присланные заново. Сохранение по дню
   *    означало бы семь запросов, каждый из которых заново гоняет syncSlots
   *    по сетке на восемь недель вперёд и может пометить занятое время вне
   *    расписания. Оборвись связь на четвёртом — человек остался бы с
   *    неделей, которую никто не задумывал, и с семью разными числами
   *    «помечено занятых» вместо одного.
   *
   *  — Правка дня в отдельном окне. Сохранение можно было бы накапливать и
   *    слать одним запросом, но окно закрывает собой неделю — а именно на
   *    неё и смотрят, решая, куда переставить часы. «Перенести приём со
   *    среды на четверг» в таком окне делается вслепую.
   *
   *  — Режим правки на всю неделю (выбран). Стоит одного лишнего нажатия
   *    перед правкой и того, что до сохранения на экране висит несохранённое
   *    состояние. Взамен: один запрос, одно «сохранить», одна общая отмена и
   *    неделя целиком перед глазами, пока её правят, — ровно та единица, в
   *    которой её и мыслят, и в которой её принимает сервер.
   */
  const [editing, setEditing] = useState(false);
  const [result, setResult] = useState<{ added: number; removed: number; flagged: number } | null>(
    null,
  );
  useEffect(() => {
    if (res.data) {
      setRows(res.data.templates.map(({ id: _id, ...rest }) => rest));
    }
  }, [res.data]);

  return (
    <Screen res={res} rows={4}>
      {(data) => (
        <Page
          title={ut("sched.title")}
          sub={ut("sched.horizon").replace("{weeks}", String(data.horizonWeeks))}
        >
          <Stack>
            <Panel
              title={ut("sched.week")}
              actions={
                editing ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      // отказ возвращает то, что на сервере, а не то, что успели натыкать
                      setRows(res.data?.templates.map(({ id: _id, ...rest }) => rest) ?? []);
                      setEditing(false);
                    }}
                  >
                    {ut("sched.cancelEdit")}
                  </Button>
                  {/*
                    Кнопки «добавить часы» здесь больше нет: она стояла над
                    всей неделей и добавляла строку с понедельником, потому
                    что какой-то день выбрать была обязана. Человек метил в
                    четверг, получал понедельник и шёл исправлять день
                    выпадающим списком. Теперь часы добавляются внутри дня,
                    и выбирать день не нужно — он уже известен из того, куда
                    нажали.
                  */}
                  <Button
                    size="sm"
                    disabled={busy || rows === null}
                    onClick={() =>
                      run(async () => {
                        /*
                         * Итог показывается числами, а не словом «сохранено».
                         *
                         * Правка недели тихо переписывает сетку на два месяца
                         * вперёд, и человеку важно ровно одно: сколько
                         * занятого времени оказалось вне расписания. Без этого
                         * числа он узнает о чужом перенесённом приёме от
                         * пациента.
                         */
                        const r = await api.saveSchedule(rows ?? []);
                        await reload();
                        setResult(r);
                        setEditing(false);
                        return r;
                      }, ut("sched.saved"))
                    }
                  >
                    {ut("sched.save")}
                  </Button>
                </div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      // итог прошлого сохранения относится к прошлой неделе, а не к той, что правят сейчас
                      setResult(null);
                      setEditing(true);
                    }}
                  >
                    {ut("sched.edit")}
                  </Button>
                )
              }
            >
              {/*
                Занятое время вне расписания не исчезает при сужении часов, и
                написано это здесь, а не в справке: сузить часы задним числом —
                самый вероятный способ молча отменить чужой приём, и человек
                должен знать, что этого не произойдёт, ДО того как нажмёт.
              */}
              <p className="px-4 pb-3 text-caption text-muted">{ut("sched.offNote")}</p>
              {result ? (
                <p
                  className={`px-4 pb-3 text-caption ${result.flagged ? "text-accent" : "text-muted"}`}
                >
                  {ut("sched.result")
                    .replace("{added}", String(result.added))
                    .replace("{removed}", String(result.removed))
                    .replace("{flagged}", String(result.flagged))}
                </p>
              ) : null}

              {/*
                Пустая неделя показывается заглушкой только в чтении.
                Раньше условие стояло первым и в правке тоже: у человека без
                единого часа приёма экран правки состоял из надписи «Неделя
                пуста» и ничего больше. Завести первые часы было нельзя —
                добавлять их некуда, потому что добавление живёт внутри дня.
              */}
              {rows === null || (rows.length === 0 && !editing) ? (
                <Empty title={ut("sched.empty")} />
              ) : !editing ? (
                <WeekRead rows={rows} />
              ) : (
                <>
                  <SimpleWeek onApply={(next) => setRows(next)} />
                  <WeekEdit rows={rows} onChange={setRows} />
                </>
              )}
            </Panel>

            <Exceptions
              items={data.exceptions}
              busy={busy}
              onAdd={(input) => run(() => api.addScheduleException(input).then(reload))}
              onRemove={(id) => run(() => api.removeScheduleException(id).then(reload))}
            />
          </Stack>
        </Page>
      )}
    </Screen>
  );
}

/**
 * Неделя как текст.
 *
 * Дни идут все семь подряд, включая те, в которые приёма нет: расписание
 * читают вопросом «принимаю ли я в четверг», и день, которого просто нет в
 * списке, на этот вопрос не отвечает — его приходится искать, чтобы
 * убедиться, что не нашёл.
 */
/**
 * Обычная неделя одной строкой.
 *
 * Настраивают расписание один раз, и настраивает его человек, который знает
 * про свой приём ровно три вещи: в какие дни, с которого по который час и
 * сколько длится приём. Таблица из строк на каждый интервал спрашивала то же
 * самое пять раз подряд, и заполнить её без ошибки труднее, чем сказать
 * вслух.
 *
 * Построчная правка не убрана: обеденный перерыв и короткая пятница иначе не
 * задаются. Но она перестала быть первым, что видит человек, — и стала тем,
 * чем и является: поправкой к обычной неделе.
 */
function SimpleWeek({ onApply }: { onApply: (rows: Row[]) => void }) {
  const { ut } = useLang();
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("17:00");
  const [minutes, setMinutes] = useState(50);

  const toggle = (d: number) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));

  return (
    <div className="px-4 pb-4">
      <div className="pb-1 text-micro uppercase tracking-[var(--tracking-label)] text-faint">
        {ut("sched.simple")}
      </div>
      <p className="pb-3 text-caption text-muted">{ut("sched.simpleHint")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-1">
          {WEEK.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days.includes(d)}
              onClick={() => toggle(d)}
              className={cx(
                "h-9 rounded-sm px-3 text-small transition-colors",
                "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                days.includes(d)
                  ? "bg-surface-3 font-medium text-text"
                  : "text-muted hover:bg-surface-2 hover:text-text",
              )}
            >
              {ut(SHORT_KEY[d]!)}
            </button>
          ))}
        </div>
        <Field label={ut("sched.from")}>
          <Input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={ut("sched.to")}>
          <Input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label={ut("sched.slotMinutes")}>
          <Input
            type="number"
            min={5}
            max={480}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </Field>
        <Button
          size="sm"
          disabled={!days.length || to <= from}
          onClick={() =>
            onApply(days.map((weekday) => ({ weekday, startsAt: from, endsAt: to, slotMinutes: minutes })))
          }
        >
          {ut("sched.apply")}
        </Button>
      </div>
      <p className="pt-2 text-caption text-faint">{ut("sched.applyWarn")}</p>
    </div>
  );
}

function WeekRead({ rows }: { rows: Row[] }) {
  const { ut } = useLang();

  return (
    <div className="px-4 pb-4">
      {WEEK.map((weekday) => {
        const day = rows
          .filter((r) => r.weekday === weekday)
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        return (
          <div
            key={weekday}
            /* столбец дня тот же, что в правке: нажатие «изменить неделю» не должно сдвигать дни вбок */
            className="grid items-baseline gap-x-2 border-t border-hairline py-2 first:border-t-0"
            style={{ gridTemplateColumns: `${DAY_COLUMN} minmax(0,1fr)` }}
          >
            <span className={day.length ? "font-medium" : "text-faint"}>
              {ut(WEEKDAY_KEY[weekday]!)}
            </span>
            {day.length === 0 ? (
              <span className="text-caption text-faint">{ut("sched.dayOff")}</span>
            ) : (
              <div className="flex flex-col gap-0.5">
                {day.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-baseline gap-x-3 text-caption">
                    <Num>
                      {r.startsAt}–{r.endsAt}
                    </Num>
                    <span className="text-muted">
                      {ut("sched.perSlot").replace("{n}", String(r.slotMinutes))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
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
const DAY_COLUMN = "132px";
// с · по · длительность · снять
const INTERVAL_COLUMNS = "116px 116px 92px 1fr";

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
 * промежуток заводится внутри дня и принадлежит ему по построению. Заодно
 * это убрало из строки самый широкий элемент — а с ним и четвёртую часть
 * полей ввода на экране.
 *
 * Дни без приёма показываются наравне с остальными. Пропускать их нельзя по
 * той же причине, что и в чтении: «принимаю ли я в субботу» — вопрос, на
 * который отсутствие строки не отвечает, а отвечает надпись «не принимаю».
 */
export function WeekEdit({ rows, onChange }: { rows: Row[]; onChange: (next: Row[]) => void }) {
  const { ut } = useLang();

  return (
    <>
      <div className="border-t border-hairline px-4 pt-3 text-micro uppercase tracking-[var(--tracking-label)] text-faint">
        {ut("sched.byDay")}
      </div>
      <div className="overflow-x-auto px-4 pb-4">
        <div className="min-w-[560px]">
          {/*
            Шапка стоит НАД столбцами, а не сбоку от полей.

            Подписи жили в каждой строке рядом со своим полем: десять строк
            давали сорок повторённых слов, и ни одна колонка не совпадала с
            соседней — ширину задавала длина подписи, а она у «С» и у
            «Приём, мин» разная. Неделю же читают сверху вниз: «во сколько я
            начинаю» — это столбец, а не строка. Значит, подпись у столбца
            должна быть одна и стоять у него над головой.
          */}
          <div
            className="grid items-end gap-2 pb-1 text-micro uppercase tracking-[var(--tracking-label)] text-faint"
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
               * Промежутки дня идут в том порядке, в каком лежат в неделе, и
               * НЕ сортируются по времени начала.
               *
               * В чтении сортировка есть и нужна. Здесь она означала бы, что
               * строка уезжает из-под курсора: поправил начало с 14:00 на
               * 08:00 — и поле, в котором набираешь, прыгнуло выше соседнего.
               * Сервер отдаёт шаблоны уже упорядоченными, так что при входе в
               * правку порядок и так верный; разъезжается он только на время
               * самой правки и выправляется сохранением.
               */
              day={rows.flatMap((row, at) => (row.weekday === weekday ? [{ row, at }] : []))}
              onChange={(at, next) => onChange(rows.map((r, j) => (j === at ? next : r)))}
              onRemove={(at) => onChange(rows.filter((_, j) => j !== at))}
              onAdd={(hours) => onChange([...rows, { weekday, ...hours }])}
            />
          ))}
        </div>
      </div>
    </>
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
  /** Промежутки дня вместе с их местом в общем списке недели: правка идёт по нему */
  day: { row: Row; at: number }[];
  onChange: (at: number, next: Row) => void;
  onRemove: (at: number) => void;
  onAdd: (hours: { startsAt: string; endsAt: string; slotMinutes: number }) => void;
}) {
  const { ut } = useLang();
  const name = ut(WEEKDAY_KEY[weekday]!);

  return (
    <div
      className="grid items-start gap-x-2 border-t border-hairline py-1.5 first:border-t-0"
      style={{ gridTemplateColumns: `${DAY_COLUMN} minmax(0,1fr)` }}
    >
      <span className={cx("py-2 text-small", day.length ? "font-medium" : "text-faint")}>{name}</span>
      <div className="flex flex-col items-start gap-1">
        {day.map(({ row, at }) => (
          <div
            key={at}
            className="grid w-full items-center gap-2"
            style={{ gridTemplateColumns: INTERVAL_COLUMNS }}
          >
            {/*
              Подписи полей есть, но спрятаны от глаз: столбец подписан в
              шапке, а для диктора шапка — это далеко. Именем дня они
              начинаются намеренно: без него диктор читает десять пар полей
              «С», «До» подряд, и понять, в чьём дне стоит курсор, нельзя.
            */}
            <Input
              aria-label={`${name} · ${ut("sched.from")}`}
              type="time"
              value={row.startsAt}
              onChange={(e) => onChange(at, { ...row, startsAt: e.target.value })}
            />
            <Input
              aria-label={`${name} · ${ut("sched.to")}`}
              type="time"
              value={row.endsAt}
              onChange={(e) => onChange(at, { ...row, endsAt: e.target.value })}
            />
            <Input
              aria-label={`${name} · ${ut("sched.slotMinutes")}`}
              type="number"
              min={5}
              max={480}
              value={row.slotMinutes}
              onChange={(e) => onChange(at, { ...row, slotMinutes: Number(e.target.value) })}
            />
            <Button
              className="justify-self-start"
              aria-label={`${ut("sched.remove")} · ${name} ${row.startsAt}–${row.endsAt}`}
              size="sm"
              variant="ghost"
              onClick={() => onRemove(at)}
            >
              {ut("sched.remove")}
            </Button>
          </div>
        ))}
        {day.length === 0 ? (
          <span className="py-2 text-caption text-faint">{ut("sched.dayOff")}</span>
        ) : null}
        <Button
          aria-label={`${ut("sched.addRow")} · ${name}`}
          size="sm"
          variant="ghost"
          onClick={() => onAdd(nextHours(day.map((d) => d.row)))}
        >
          {ut("sched.addRow")}
        </Button>
      </div>
    </div>
  );
}

function Exceptions({
  items,
  busy,
  onAdd,
  onRemove,
}: {
  items: { id: string; date: string; kind: "off" | "extra"; startsAt: string | null; endsAt: string | null; note: string | null }[];
  busy: boolean;
  onAdd: (input: { date: string; kind: "off" | "extra"; startsAt?: string | null; endsAt?: string | null; note?: string | null }) => void;
  onRemove: (id: string) => void;
}) {
  const { ut } = useLang();
  const [date, setDate] = useState("");
  const [kind, setKind] = useState<"off" | "extra">("off");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");

  return (
    <Panel title={ut("sched.exceptions")}>
      <div className="flex flex-wrap items-end gap-2 px-4 pb-3">
        <Field label={ut("sched.date")}>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label={ut("sched.kind")}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as "off" | "extra")}>
            <option value="off">{ut("sched.excOff")}</option>
            <option value="extra">{ut("sched.excExtra")}</option>
          </Select>
        </Field>
        {/*
          Часы для «не принимаю» необязательны: пустые означают весь день.
          Для дополнительных часов — обязательны, иначе непонятно, что
          добавлять; это же проверяет и сервер.
        */}
        <Field label={ut("sched.from")}>
          <Input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={ut("sched.to")}>
          <Input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label={ut("sched.note")}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Button
          size="sm"
          disabled={busy || !date || (kind === "extra" && (!from || !to))}
          onClick={() => {
            onAdd({
              date,
              kind,
              startsAt: from || null,
              endsAt: to || null,
              note: note || null,
            });
            setDate("");
            setFrom("");
            setTo("");
            setNote("");
          }}
        >
          {ut("sched.addException")}
        </Button>
      </div>

      {items.length === 0 ? (
        <Empty title={ut("sched.excNone")} />
      ) : (
        <div className="flex flex-col">
          {items.map((e) => (
            <div
              key={e.id}
              className="flex items-center gap-3 border-t border-hairline px-4 py-2 text-caption"
            >
              <span className="w-[104px] shrink-0 font-mono">{e.date}</span>
              <span className="text-muted">
                {ut(e.kind === "off" ? "sched.excOff" : "sched.excExtra")}
              </span>
              <span className="text-muted">
                {e.startsAt && e.endsAt ? `${e.startsAt}–${e.endsAt}` : ut("sched.excAllDay")}
              </span>
              {e.note ? <span className="truncate text-faint">{e.note}</span> : null}
              <Button
                className="ml-auto"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onRemove(e.id)}
              >
                {ut("sched.remove")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
