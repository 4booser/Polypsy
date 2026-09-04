import { useEffect, useState } from "react";
import type { ScheduleTemplateView, UiKey } from "@quizzy/shared";
import { api } from "../api";
import { Empty, Screen, useAction } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button, Field, Input, Num, Select } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";

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

const BLANK: Row = {
  weekday: 1,
  startsAt: "09:00",
  endsAt: "13:00",
  slotMinutes: 50,
};

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
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRows([...(rows ?? []), { ...BLANK }])}
                  >
                    {ut("sched.addRow")}
                  </Button>
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
                  <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
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

              {rows === null || rows.length === 0 ? (
                <Empty title={ut("sched.empty")} />
              ) : !editing ? (
                <WeekRead rows={rows} />
              ) : (
                /*
                 * Одна шапка на всю неделю, а не подписи у каждого поля.
                 *
                 * Первая редакция ставила подписи в каждой строке: десять
                 * строк давали шестьдесят повторённых слов, и колонки от
                 * строки к строке разъезжались, потому что ширина поля
                 * зависела от содержимого. Неделю смотрят по столбцам —
                 * «во сколько я начинаю» читается сверху вниз, — и столбцы
                 * обязаны стоять на месте.
                 */
                <div className="overflow-x-auto px-4 pb-4">
                  <div className="min-w-[720px]">
                    <div
                      /* px-2 — те же отступы, что у строки: иначе подпись столбца
                         стоит на десять пикселей левее своего поля */
                      className="grid items-end gap-2 px-2 pb-1 text-micro uppercase tracking-[var(--tracking-label)] text-faint"
                      style={{ gridTemplateColumns: COLUMNS }}
                    >
                      <span>{ut("sched.weekday")}</span>
                      <span>{ut("sched.from")}</span>
                      <span>{ut("sched.to")}</span>
                      <span>{ut("sched.slotMinutes")}</span>
                      <span />
                    </div>
                    <div className="flex flex-col gap-1">
                      {rows.map((row, i) => (
                        <TemplateRow
                          key={i}
                          row={row}
                          onChange={(next) => setRows(rows.map((r, j) => (i === j ? next : r)))}
                          onRemove={() => setRows(rows.filter((_, j) => j !== i))}
                        />
                      ))}
                    </div>
                  </div>
                </div>
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
function WeekRead({ rows }: { rows: Row[] }) {
  const { ut } = useLang();

  return (
    <div className="px-4 pb-4">
      {[1, 2, 3, 4, 5, 6, 7].map((weekday) => {
        const day = rows
          .filter((r) => r.weekday === weekday)
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        return (
          <div
            key={weekday}
            className="grid grid-cols-[132px_minmax(0,1fr)] items-baseline gap-x-4 border-t border-hairline py-2 first:border-t-0"
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

/** Ширины столбцов заданы один раз: шапка и строки обязаны совпадать */
// день · с · по · длительность · удалить
const COLUMNS = "150px 116px 116px 92px 1fr";

function TemplateRow({
  row,
  onChange,
  onRemove,
}: {
  row: Row;
  onChange: (next: Row) => void;
  onRemove: () => void;
}) {
  const { ut } = useLang();
  return (
    <div
      className="grid items-center gap-2 rounded-md border border-hairline px-2 py-1.5"
      style={{ gridTemplateColumns: COLUMNS }}
    >
      {/*
        Подписи есть у каждого поля, но спрятаны от глаз, а не выброшены:
        столбец подписан в шапке, а для чтения с экрана шапка — это далеко.
      */}
      <Select
        aria-label={ut("sched.weekday")}
        value={String(row.weekday)}
        onChange={(e) => onChange({ ...row, weekday: Number(e.target.value) })}
      >
        {[1, 2, 3, 4, 5, 6, 7].map((d) => (
          <option key={d} value={d}>
            {ut(WEEKDAY_KEY[d]!)}
          </option>
        ))}
      </Select>
      <Input
        aria-label={ut("sched.from")}
        type="time"
        value={row.startsAt}
        onChange={(e) => onChange({ ...row, startsAt: e.target.value })}
      />
      <Input
        aria-label={ut("sched.to")}
        type="time"
        value={row.endsAt}
        onChange={(e) => onChange({ ...row, endsAt: e.target.value })}
      />
      <Input
        aria-label={ut("sched.slotMinutes")}
        type="number"
        min={5}
        max={480}
        value={row.slotMinutes}
        onChange={(e) => onChange({ ...row, slotMinutes: Number(e.target.value) })}
      />
      <Button className="justify-self-start" size="sm" variant="ghost" onClick={onRemove}>
        {ut("sched.remove")}
      </Button>
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
