import { useEffect, useState } from "react";
import type { SafetyPlanContent } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { NotLoaded, useAction } from "../ui";
import { IconClose } from "../ui/glyphs";
import { useLang } from "../lang";
import { useResource, type Resource } from "../useResource";
import { Panel } from "../ui/layout";
import { freshKey, withKeys, withoutKeys, type Keyed } from "../ui/rowKeys";

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

  const save = () =>
    void run(async () => {
      await api.saveSafetyPlan(userId, rowsToPlan(draft));
      res.reload();
      setOpen(false);
    }, ut("sp.saved"));

  if (!res.data) return res.error ? <NotLoaded res={res} /> : null;

  return (
    /*
     * Красной рамки у блока больше нет.
     *
     * Она стояла всегда — и когда план есть, и когда его нет, — то есть
     * сообщала не о состоянии дел, а о названии раздела. Красный в этой
     * системе занят выраженностью состояния человека; рамка вокруг блока
     * выглядела так, будто сам план безопасности — тревожный факт.
     *
     * Внимания требует ровно одно: плана нет у того, кому он нужен. Именно
     * это и отмечено — янтарной полосой слева и меткой рядом с заголовком.
     * Когда план есть, блок обычный.
     */
    <Panel
      className={active ? undefined : "border-l-2 border-l-[var(--accent)]"}
      title={ut("sp.title")}
      hint={ut("sp.hint")}
      actions={
        <>
          {active ? (
            <span className="text-caption text-muted">
              {ut("sp.version")} {active.version} · {day(active.reviewedAt ?? active.createdAt)}
            </span>
          ) : (
            <span className="badge accent">{ut("sp.none")}</span>
          )}
          <button onClick={() => setOpen((v) => !v)}>
            {open ? ut("common.close") : active ? ut("sp.revise") : ut("sp.create")}
          </button>
          {active ? <button onClick={() => window.print()}>{ut("sp.print")}</button> : null}
        </>
      }
    >
      {!open && active ? <PlanView content={active.content} /> : null}

      {open ? (
        <div className="sp-edit">
          {(
            [
              ["warningSigns", "sp.warningSigns"],
              ["copingStrategies", "sp.coping"],
              ["distractions", "sp.distractions"],
              ["reasonsToLive", "sp.reasons"],
            ] as const
          ).map(([key, label]) => (
            <section key={key}>
              <h3>{ut(label)}</h3>
              {draft[key].map((row) => (
                <div className="row tight" key={row.key}>
                  <input
                    value={row.value}
                    onChange={(e) => setList(key, row.key, e.target.value)}
                    placeholder={ut("sp.ownWords")}
                  />
                  <button className="chip-x" onClick={() => dropList(key, row.key)} aria-label={ut("ui.remove")}>
                    <IconClose />
                  </button>
                </div>
              ))}
              <button className="ghost" onClick={() => addList(key)}>
                + {ut("sp.addLine")}
              </button>
            </section>
          ))}

          {(
            [
              ["people", "sp.people"],
              ["professionals", "sp.professionals"],
            ] as const
          ).map(([key, label]) => (
            <section key={key}>
              <h3>{ut(label)}</h3>
              {draft[key].map(({ key: rowKey, value: p }) => (
                <div className="row tight" key={rowKey}>
                  <input
                    value={p.name}
                    onChange={(e) => setPerson(key, rowKey, { name: e.target.value })}
                    placeholder={ut("sp.who")}
                  />
                  <input
                    value={p.contact}
                    onChange={(e) => setPerson(key, rowKey, { contact: e.target.value })}
                    placeholder={ut("sp.contact")}
                  />
                  <button className="chip-x" onClick={() => dropPerson(key, rowKey)} aria-label={ut("ui.remove")}>
                    <IconClose />
                  </button>
                </div>
              ))}
              <button className="ghost" onClick={() => addPerson(key)}>
                + {ut("sp.addLine")}
              </button>
            </section>
          ))}

          <section>
            <h3>{ut("sp.means")}</h3>
            {/* единственный раздел, который снижает риск, а не помогает его пережить */}
            <p className="hint">{ut("sp.meansHint")}</p>
            <textarea
              rows={2}
              value={draft.meansRestriction}
              onChange={(e) => setDraft((d) => ({ ...d, meansRestriction: e.target.value }))}
            />
          </section>

          <div className="row">
            <button className="primary" disabled={busy} onClick={save}>
              {ut("sp.saveVersion")}
            </button>
            <button className="ghost" onClick={() => setOpen(false)}>
              {ut("common.cancel")}
            </button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function PlanView({ content }: { content: SafetyPlanContent }) {
  const { ut } = useLang();
  const block = (label: string, items: string[]) =>
    items.length ? (
      <section>
        <h3>{label}</h3>
        <ol className="sp-list">
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ol>
      </section>
    ) : null;

  return (
    <div className="sp-view">
      {block(ut("sp.warningSigns"), content.warningSigns)}
      {block(ut("sp.coping"), content.copingStrategies)}
      {block(ut("sp.distractions"), content.distractions)}
      {content.people.length ? (
        <section>
          <h3>{ut("sp.people")}</h3>
          <ol className="sp-list">
            {content.people.map((p, i) => (
              <li key={i}>
                {p.name} <span className="muted">{p.contact}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {content.professionals.length ? (
        <section>
          <h3>{ut("sp.professionals")}</h3>
          <ol className="sp-list">
            {content.professionals.map((p, i) => (
              <li key={i}>
                {p.name} <span className="muted">{p.contact}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {content.meansRestriction ? (
        <section>
          <h3>{ut("sp.means")}</h3>
          <p>{content.meansRestriction}</p>
        </section>
      ) : null}
      {block(ut("sp.reasons"), content.reasonsToLive)}
    </div>
  );
}
