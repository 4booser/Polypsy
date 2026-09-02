import { useState } from "react";
import { api, openInTab } from "../api";
import { Screen } from "../ui";
import { Page, Panel } from "../ui/layout";
import { Button, Field, Input, Num } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";

/** Первое число месяца и сегодня — период, который спрашивают чаще всего */
function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * Отчёт отделения за период.
 *
 * То, что сейчас считают руками в конце месяца. Ручной подсчёт занимает
 * вечер и ошибается молча — пересчитать его некому.
 */
export default function DepartmentReportPage() {
  const { ut } = useLang();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [range, setRange] = useState({ from: monthStart(), to: new Date().toISOString().slice(0, 10) });

  const res = useResource(() => api.departmentReport(range.from, range.to), [range.from, range.to]);

  return (
    <Screen res={res} rows={3}>
      {(data) => (
        <Page
          title={ut("dep.title")}
          toolbar={
            <div className="flex flex-wrap items-end gap-2">
              <Field label={ut("dep.from")}>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label={ut("dep.to")}>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <Button size="sm" onClick={() => setRange({ from, to })}>
                {ut("dep.build")}
              </Button>
              {/*
                Печатный лист считает та же функция, что и экран: два расчёта
                одного числа однажды разойдутся, а подпишут бумажное.
              */}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  openInTab(`/api/reports/department?from=${range.from}&to=${range.to}`)
                }
              >
                {ut("dep.print")}
              </Button>
            </div>
          }
        >
          {/*
            Семь чисел — не список, а три группы, и рядами они разложены
            по смыслу, а не по тому, сколько влезает в строку. Плоская сетка
            в три столбца ставила «первичных» под «принято приёмов» случайно
            и оставляла в последнем ряду пустой блок на два места.

            Группа «из них по виду приёма» подписана именно так: это разрез
            принятых, а не ещё два самостоятельных числа рядом.
          */}
          <Panel>
            {/*
              «Принято приёмов» и «людей» стоят рядом и подписаны по-разному
              намеренно: один человек за месяц приходит несколько раз, и
              сложить эти числа нельзя. Подпись под ними это и говорит.
            */}
            <Group title={ut("dep.groupVolume")}>
              <Cell label={ut("dep.received")} value={data.received} />
              <Cell label={ut("dep.people")} value={data.people} />
              <Cell label={ut("dep.attached")} value={data.attached} />
            </Group>
            <Group title={ut("dep.groupKind")} columns={2}>
              <Cell label={ut("dep.primary")} value={data.primary} />
              <Cell label={ut("dep.repeat")} value={data.repeat} />
            </Group>
            {/*
              Отмены стоят рядом с неявками, а не отдельно: и то и другое —
              освободившееся время, но отменённое время можно было отдать
              другому, а потерянное на неявке — нет. Числа рядом показывают,
              сколько из потерянного было потеряно молча.
            */}
            <Group title={ut("dep.groupLost")} columns={2}>
              <Cell label={ut("dep.noShow")} value={data.noShow} />
              <Cell label={ut("dep.cancelled")} value={data.cancelled} />
            </Group>
            <p className="px-4 pb-2 pt-3 text-caption text-muted">{ut("dep.peopleNote")}</p>
            <p className="px-4 pb-4 text-caption text-muted">
              {ut("dep.floorNote").replace("{floor}", String(data.floor))}
            </p>
          </Panel>
        </Page>
      )}
    </Screen>
  );
}

function Group({
  title,
  columns = 3,
  children,
}: {
  title: string;
  columns?: 2 | 3;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-hairline first:border-t-0">
      <h2 className="px-4 pt-4 text-micro uppercase tracking-[var(--tracking-label)] text-faint">
        {title}
      </h2>
      <div
        className={`m-4 grid gap-px bg-border ${
          columns === 2 ? "grid-cols-2" : "grid-cols-3 max-[900px]:grid-cols-2"
        }`}
      >
        {children}
      </div>
    </section>
  );
}

function Cell({ label, value }: { label: string; value: number | null }) {
  const { ut } = useLang();
  return (
    <div className="bg-surface-2 p-4">
      {/*
        Подавленное число печатается словом «мало», а не прочерком и не нулём.
        Прочерк читается как «нет данных», ноль — как «никого», а правда в
        том, что людей мало и назвать их число нельзя.
      */}
      <Num className="block text-stat leading-none">
        {value === null ? <span className="text-muted text-body">{ut("dep.suppressed")}</span> : value}
      </Num>
      <span className="mt-2 block text-caption text-muted">{label}</span>
    </div>
  );
}
