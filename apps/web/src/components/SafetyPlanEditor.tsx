import { useEffect, useRef, useState } from "react";
import type { SafetyPlanContent } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { Callout, Ic, NotLoaded, useAction } from "../ui";
import { useLang } from "../lang";
import { useResource, type Resource } from "../useResource";
import { Panel } from "../ui/layout";
import { Button, Input, Tag, Textarea } from "../ui/primitives";

import { freshKey, withKeys, withoutKeys, type Keyed } from "../ui/rowKeys";
import { staleMessage } from "./versioned";
import { printOnly } from "../print";

/**
 * Личный план безопасности (Стэнли–Браун).
 *
 * Не путать с `safetyPlan` методики: там инструкция инструмента, одинаковая
 * для всех, кто попал в полосу риска, — что делать персоналу. Здесь план
 * конкретного человека: что делать ему самому, когда рядом никого нет.
 *
 * Порядок разделов не произвольный — он воспроизводит порядок действий в
 * кризисе: сначала то, что человек может сделать один, потом отвлечение,
 * потом люди, и лишь затем профессиональная помощь. Так план работает даже
 * тогда, когда сил на звонок ещё нет.
 */

const EMPTY: SafetyPlanContent = {
  warningSigns: [],
  copingStrategies: [],
  distractions: [],
  people: [],
  professionals: [],
  meansRestriction: "",
  reasonsToLive: [],
};

type ListKey = "warningSigns" | "copingStrategies" | "distractions" | "reasonsToLive";
type PeopleKey = "people" | "professionals";
type Person = SafetyPlanContent["people"][number];

/**
 * План в редакторе: те же разделы, но каждая строка со своим ключом.
 *
 * Строки плана — голые строки и пары «кто · как связаться», без
 * идентификаторов, и ключом React был номер строки. Удаление средней строки
 * сдвигало список: поле удалённой оставалось тем же узлом и показывало текст
 * следующей, а курсор и история правки поля (Ctrl+Z) доставались чужой
 * строке. Ключ выдаётся при открытии редактора и на сервер не уходит
 * (rowsToPlan).
 */
export type PlanRows = { [K in ListKey]: Keyed<string>[] } & { [K in PeopleKey]: Keyed<Person>[] } & {
  meansRestriction: string;
};

export function planToRows(c: SafetyPlanContent): PlanRows {
  return {
    warningSigns: withKeys(c.warningSigns),
    copingStrategies: withKeys(c.copingStrategies),
    distractions: withKeys(c.distractions),
    reasonsToLive: withKeys(c.reasonsToLive),
    people: withKeys(c.people),
    professionals: withKeys(c.professionals),
    meansRestriction: c.meansRestriction,
  };
}

/** Обратно в план для сервера; пустые строки не сохраняем — они стали бы пустыми пунктами в кризисе */
export function rowsToPlan(d: PlanRows): SafetyPlanContent {
  return {
    warningSigns: withoutKeys(d.warningSigns).filter((x) => x.trim()),
    copingStrategies: withoutKeys(d.copingStrategies).filter((x) => x.trim()),
    distractions: withoutKeys(d.distractions).filter((x) => x.trim()),
    reasonsToLive: withoutKeys(d.reasonsToLive).filter((x) => x.trim()),
    people: withoutKeys(d.people).filter((p) => p.name.trim()),
    professionals: withoutKeys(d.professionals).filter((p) => p.name.trim()),
    meansRestriction: d.meansRestriction.trim(),
  };
}

export function SafetyPlanEditor({ userId }: { userId: string }) {
  /* источник черновика: сам не перечитывается — правку не затрёт (useResource, manual) */
  const res = useResource(() => api.safetyPlans(userId), [userId], { manual: true });
  return <SafetyPlanBody userId={userId} res={res} />;
}

/**
 * Блок плана по загрузке — без запроса внутри (test/loadStates.test.tsx).
 *
 * До ответа блока нет, как и было (он стоит в карте среди прочих, и скелет
 * на его месте только двигал бы соседей). Отказ — есть: раньше на отказе
 * блок исчезал целиком, вместе с янтарной меткой «плану немає», и у
 * человека из группы риска карта молча выглядела так, будто плана и не
 * должно быть.
 */
export function SafetyPlanBody({
  userId,
  res,
}: {
  userId: string;
  res: Pick<Resource<Awaited<ReturnType<typeof api.safetyPlans>>>, "data" | "error" | "loading" | "reload">;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [draft, setDraft] = useState<PlanRows>(() => planToRows(EMPTY));
  const [open, setOpen] = useState(false);
  /*
   * Отказ 409 — план сохранил кто-то другой, пока редактор был открыт
   * (волна 15): фраза сервера. Набранное не трогается, пока человек сам не
   * нажмёт «Перечитати», — план перечитывается целиком, и правка пропадёт.
   */
  const [stale, setStale] = useState<string | null>(null);
  /* «Друк» — только этот блок: лист отдают самому человеку, остальной карте на нём не место (#180) */
  const planRef = useRef<HTMLDivElement>(null);

  const active = res.data?.versions.find((v) => v.active) ?? null;

  useEffect(() => {
    if (active) setDraft(planToRows(active.content));
  }, [active]);

  /* строки находятся по ключу, а не по номеру: номер между нажатием и обновлением мог уже сдвинуться */
  const setList = (key: ListKey, rowKey: string, value: string) =>
    setDraft((d) => ({ ...d, [key]: d[key].map((x) => (x.key === rowKey ? { ...x, value } : x)) }));
  const addList = (key: ListKey) => setDraft((d) => ({ ...d, [key]: [...d[key], { key: freshKey(), value: "" }] }));
  const dropList = (key: ListKey, rowKey: string) =>
    setDraft((d) => ({ ...d, [key]: d[key].filter((x) => x.key !== rowKey) }));

  const setPerson = (key: PeopleKey, rowKey: string, patch: { name?: string; contact?: string }) =>
    setDraft((d) => ({
      ...d,
      [key]: d[key].map((p) => (p.key === rowKey ? { ...p, value: { ...p.value, ...patch } } : p)),
    }));
  const addPerson = (key: PeopleKey) =>
    setDraft((d) => ({ ...d, [key]: [...d[key], { key: freshKey(), value: { name: "", contact: "" } }] }));
  const dropPerson = (key: PeopleKey, rowKey: string) =>
    setDraft((d) => ({ ...d, [key]: d[key].filter((p) => p.key !== rowKey) }));

  /*
   * Сохранение называет версию, которую показывал редактор (0 — плана не
   * было): поверх чужой сервер ответит 409, а не сделает действующей версию
   * того, кто нажал вторым.
   */
  const save = () =>
    void run(async () => {
      try {
        await api.saveSafetyPlan(userId, rowsToPlan(draft), active?.version ?? 0);
      } catch (e) {
        const message = staleMessage(e);
        if (message === null) throw e;
        setStale(message);
        return false;
      }
      setStale(null);
      res.reload();
      setOpen(false);
    }, ut("sp.saved"));

  if (!res.data) return res.error ? <NotLoaded res={res} /> : null;

  return (
    /*
     * Внимания требует ровно одно: плана нет у того, кому он нужен. Это и
     * отмечено — янтарной пилюлей «плану немає» рядом с заголовком. Красный
     * в наборе занят риском для человека, и рамка вокруг блока читалась бы
     * так, будто сам план — тревожный факт.
     */
    <div ref={planRef}>
      <Panel
        title={ut("sp.title")}
        icon={<Ic.shieldCheck />}
        tone={active ? "good" : "warn"}
        hint={ut("sp.hint")}
        sub={
          active ? (
            `${ut("sp.version")} ${active.version}, ${day(active.reviewedAt ?? active.createdAt)}`
          ) : (
            <Tag tone="attention">{ut("sp.none")}</Tag>
          )
        }
        actions={
          <>
            <Button size="xs" variant={open ? "quiet" : "secondary"} onClick={() => setOpen((v) => !v)}>
              {open ? ut("common.close") : active ? ut("sp.revise") : ut("sp.create")}
            </Button>
            {active ? (
              <Button size="xs" variant="ghost" icon={<Ic.download />} onClick={() => printOnly(planRef.current)}>
                {ut("sp.print")}
              </Button>
            ) : null}
          </>
        }
      >
        {!open && active ? <PlanView content={active.content} /> : null}

        {open ? (
          <div className="flex flex-col gap-4">
            {(
              [
                ["warningSigns", "sp.warningSigns"],
                ["copingStrategies", "sp.coping"],
                ["distractions", "sp.distractions"],
                ["reasonsToLive", "sp.reasons"],
              ] as const
            ).map(([key, label]) => (
              <section key={key} className="flex flex-col gap-2">
                <h3 className="m-0 text-h3 font-extrabold text-text">{ut(label)}</h3>
                {draft[key].map((row) => (
                  <div className="flex items-center gap-2" key={row.key}>
                    <Input
                      className="flex-1"
                      value={row.value}
                      onChange={(e) => setList(key, row.key, e.target.value)}
                      placeholder={ut("sp.ownWords")}
                    />
                    <Button size="icon" variant="quiet" onClick={() => dropList(key, row.key)} aria-label={ut("ui.remove")}>
                      <Ic.x />
                    </Button>
                  </div>
                ))}
                <Button size="xs" variant="ghost" className="self-start" onClick={() => addList(key)}>
                  + {ut("sp.addLine")}
                </Button>
              </section>
            ))}

            {(
              [
                ["people", "sp.people"],
                ["professionals", "sp.professionals"],
              ] as const
            ).map(([key, label]) => (
              <section key={key} className="flex flex-col gap-2">
                <h3 className="m-0 text-h3 font-extrabold text-text">{ut(label)}</h3>
                {draft[key].map(({ key: rowKey, value: p }) => (
                  <div className="flex items-center gap-2" key={rowKey}>
                    <Input
                      className="flex-1"
                      value={p.name}
                      onChange={(e) => setPerson(key, rowKey, { name: e.target.value })}
                      placeholder={ut("sp.who")}
                    />
                    <Input
                      className="flex-1"
                      value={p.contact}
                      onChange={(e) => setPerson(key, rowKey, { contact: e.target.value })}
                      placeholder={ut("sp.contact")}
                    />
                    <Button size="icon" variant="quiet" onClick={() => dropPerson(key, rowKey)} aria-label={ut("ui.remove")}>
                      <Ic.x />
                    </Button>
                  </div>
                ))}
                <Button size="xs" variant="ghost" className="self-start" onClick={() => addPerson(key)}>
                  + {ut("sp.addLine")}
                </Button>
              </section>
            ))}

            <section className="flex flex-col gap-2">
              <h3 className="m-0 text-h3 font-extrabold text-text">{ut("sp.means")}</h3>
              {/* единственный раздел, который снижает риск, а не помогает его пережить */}
              <p className="m-0 text-small text-text-2">{ut("sp.meansHint")}</p>
              <Textarea
                rows={2}
                aria-label={ut("sp.means")}
                value={draft.meansRestriction}
                onChange={(e) => setDraft((d) => ({ ...d, meansRestriction: e.target.value }))}
              />
            </section>

            {stale ? (
              <Callout
                kind="warn"
                role="alert"
                title={stale}
                actions={
                  <Button
                    variant="quiet"
                    size="xs"
                    disabled={busy}
                    onClick={() => {
                      setStale(null);
                      res.reload();
                    }}
                  >
                    {ut("integrity.reread")}
                  </Button>
                }
              >
                {ut("sp.rereadHint")}
              </Callout>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={busy} onClick={save}>
                {ut("sp.saveVersion")}
              </Button>
              <Button variant="quiet" onClick={() => setOpen(false)}>
                {ut("common.cancel")}
              </Button>
            </div>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

function PlanView({ content }: { content: SafetyPlanContent }) {
  const { ut } = useLang();
  const heading = "m-0 mb-1.5 text-caption font-bold text-muted";
  const list = "m-0 flex list-decimal flex-col gap-1 pl-5 text-body text-text";
  const block = (label: string, items: string[]) =>
    items.length ? (
      <section>
        <h3 className={heading}>{label}</h3>
        <ol className={list}>
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ol>
      </section>
    ) : null;
  const people = (label: string, items: SafetyPlanContent["people"]) =>
    items.length ? (
      <section>
        <h3 className={heading}>{label}</h3>
        <ul className="m-0 list-none p-0">
          {items.map((p, i) => (
            <li key={i} className="flex items-center gap-3 border-t border-divider py-1.5 text-body first:border-t-0 first:pt-0">
              <b className="min-w-0 flex-1 font-extrabold text-text">{p.name}</b>
              <span className="whitespace-nowrap font-bold text-text-2">{p.contact}</span>
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  return (
    <div className="flex flex-col gap-4">
      {block(ut("sp.warningSigns"), content.warningSigns)}
      {block(ut("sp.coping"), content.copingStrategies)}
      {block(ut("sp.distractions"), content.distractions)}
      {people(ut("sp.people"), content.people)}
      {people(ut("sp.professionals"), content.professionals)}
      {content.meansRestriction ? (
        <Callout kind="warn" title={ut("sp.means")}>
          {content.meansRestriction}
        </Callout>
      ) : null}
      {block(ut("sp.reasons"), content.reasonsToLive)}
    </div>
  );
}
