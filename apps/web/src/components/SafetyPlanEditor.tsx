import { useEffect, useState } from "react";
import type { SafetyPlanContent } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { useAction } from "../ui";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { Panel } from "../ui/layout";

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

export function SafetyPlanEditor({ userId }: { userId: string }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.safetyPlans(userId), [userId]);
  const [draft, setDraft] = useState<SafetyPlanContent>(EMPTY);
  const [open, setOpen] = useState(false);

  const active = res.data?.versions.find((v) => v.active) ?? null;

  useEffect(() => {
    if (active) setDraft(active.content);
  }, [active]);

  const setList = (key: ListKey, i: number, value: string) =>
    setDraft((d) => ({ ...d, [key]: d[key].map((x, k) => (k === i ? value : x)) }));
  const addList = (key: ListKey) => setDraft((d) => ({ ...d, [key]: [...d[key], ""] }));
  const dropList = (key: ListKey, i: number) =>
    setDraft((d) => ({ ...d, [key]: d[key].filter((_, k) => k !== i) }));

  const setPerson = (key: PeopleKey, i: number, patch: { name?: string; contact?: string }) =>
    setDraft((d) => ({
      ...d,
      [key]: d[key].map((p, k) => (k === i ? { ...p, ...patch } : p)),
    }));
  const addPerson = (key: PeopleKey) =>
    setDraft((d) => ({ ...d, [key]: [...d[key], { name: "", contact: "" }] }));
  const dropPerson = (key: PeopleKey, i: number) =>
    setDraft((d) => ({ ...d, [key]: d[key].filter((_, k) => k !== i) }));

  const save = () =>
    void run(async () => {
      // пустые строки не сохраняем: они бы стали пустыми пунктами в кризисе
      const clean: SafetyPlanContent = {
        warningSigns: draft.warningSigns.filter((x) => x.trim()),
        copingStrategies: draft.copingStrategies.filter((x) => x.trim()),
        distractions: draft.distractions.filter((x) => x.trim()),
        reasonsToLive: draft.reasonsToLive.filter((x) => x.trim()),
        people: draft.people.filter((p) => p.name.trim()),
        professionals: draft.professionals.filter((p) => p.name.trim()),
        meansRestriction: draft.meansRestriction.trim(),
      };
      await api.saveSafetyPlan(userId, clean);
      res.reload();
      setOpen(false);
    }, ut("sp.saved"));

  if (!res.data) return null;

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
              {draft[key].map((value, i) => (
                <div className="row tight" key={i}>
                  <input
                    value={value}
                    onChange={(e) => setList(key, i, e.target.value)}
                    placeholder={ut("sp.ownWords")}
                  />
                  <button className="chip-x" onClick={() => dropList(key, i)} aria-label={ut("ui.remove")}>
                    ✕
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
              {draft[key].map((p, i) => (
                <div className="row tight" key={i}>
                  <input
                    value={p.name}
                    onChange={(e) => setPerson(key, i, { name: e.target.value })}
                    placeholder={ut("sp.who")}
                  />
                  <input
                    value={p.contact}
                    onChange={(e) => setPerson(key, i, { contact: e.target.value })}
                    placeholder={ut("sp.contact")}
                  />
                  <button className="chip-x" onClick={() => dropPerson(key, i)} aria-label={ut("ui.remove")}>
                    ✕
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
