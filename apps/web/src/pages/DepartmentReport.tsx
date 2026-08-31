import { useState } from "react";
import { api } from "../api";
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
            </div>
          }
        >
          <Panel>
            <div className="grid gap-px bg-border max-[900px]:grid-cols-2 grid-cols-3">
              {/*
                «Принято приёмов» и «людей» стоят рядом и подписаны по-разному
                намеренно: один человек за месяц приходит несколько раз, и
                сложить эти числа нельзя. Подпись под ними это и говорит.
              */}
              <Cell label={ut("dep.received")} value={data.received} />
              <Cell label={ut("dep.people")} value={data.people} />
              <Cell label={ut("dep.attached")} value={data.attached} />
              <Cell label={ut("dep.primary")} value={data.primary} />
              <Cell label={ut("dep.repeat")} value={data.repeat} />
              <Cell label={ut("dep.noShow")} value={data.noShow} />
              {/*
                Отмены стоят рядом с неявками, а не отдельно: и то и другое —
                освободившееся время, но отменённое время можно было отдать
                другому, а потерянное на неявке — нет. Числа рядом показывают,
                сколько из потерянного было потеряно молча.
              */}
              <Cell label={ut("dep.cancelled")} value={data.cancelled} />
            </div>
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
