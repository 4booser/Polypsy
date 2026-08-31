import { useState } from "react";
import { UI } from "@quizzy/shared";
import { BulkPaste } from "./BulkPaste";
import { Loc, Toggle } from "./fields";
import { TYPES, newUid, type Draft, type DraftQuestion } from "./model";
import { useLang } from "../../lang";
import { Panel, Stack } from "../../ui/layout";
import { Button, Input, Select } from "../../ui/primitives";

export function Questions({
  draft,
  setDraft,
  onFocusQuestion,
}: {
  draft: Draft;
  setDraft: (f: (d: Draft) => Draft) => void;
  /**
   * Какой пункт сейчас правят. Предпросмотр идёт за ним: иначе он витрина, а
   * не инструмент — смотреть приходилось бы, перелистывая его отдельно.
   */
  onFocusQuestion?: (index: number) => void;
}) {
  const { ut } = useLang();
  const [bulk, setBulk] = useState(false);
  const upd = (i: number, q: Partial<DraftQuestion>) =>
    setDraft((d) => ({ ...d, questions: d.questions.map((x, k) => (k === i ? { ...x, ...q } : x)) }));

  const move = (i: number, delta: number) =>
    setDraft((d) => {
      const j = i + delta;
      if (j < 0 || j >= d.questions.length) return d;
      const next = [...d.questions];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...d, questions: next };
    });

  const duplicate = (i: number) =>
    setDraft((d) => {
      const copy = structuredClone(d.questions[i]!);
      const next = [...d.questions];
      next.splice(i + 1, 0, copy);
      return { ...d, questions: next };
    });

  return (
    <Stack>
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="m-0 max-w-[60ch] text-caption text-muted">
            {ut("cq.reorderHint")}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button onClick={() => setBulk(true)}>{ut("co.bulkPaste")}</Button>
            <Button
              variant="primary"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  questions: [
                    ...d.questions,
                    {
                      uid: newUid(),
                      type: "yesno",
                      title: { uk: "", ru: "" },
                      required: true,
                      options: [
                        { text: { uk: UI["bp.yes"].uk, ru: UI["bp.yes"].ru }, keyCode: "yes" },
                        { text: { uk: UI["bp.no"].uk, ru: UI["bp.no"].ru }, keyCode: "no" },
                      ],
                    },
                  ],
                }))
              }
            >
              {ut("cq.addQuestion")}
            </Button>
          </div>
        </div>
      </Panel>

      {bulk ? (
        <BulkPaste
          onClose={() => setBulk(false)}
          onAppend={(questions) => setDraft((d) => ({ ...d, questions: [...d.questions, ...questions] }))}
        />
      ) : null}

      {draft.questions.length === 0 && !bulk ? (
        <p className="text-caption text-muted">{ut("cq.noQuestions")}</p>
      ) : null}

      {draft.questions.map((q, i) => (
        /*
         * Фокус ловится на всплытии, а не на каждом поле: полей в пункте
         * десяток, и вешать обработчик на каждое — способ забыть один.
         */
        <div key={q.uid} onFocusCapture={() => onFocusQuestion?.(i)}>
          <Panel
            title={`${ut("cq.item")} ${i + 1}`}
            actions={
              <div className="flex flex-wrap items-center gap-1.5">
                <Select value={q.type} onChange={(e) => upd(i, { type: e.target.value })} className="w-[170px]">
                  {TYPES.map(([v, l]) => (
                    <option key={v} value={v}>{ut(l)}</option>
                  ))}
                </Select>
                <Button variant="quiet" size="sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={ut("cq.moveUp")} title={ut("cq.moveUp")}>↑</Button>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => move(i, 1)}
                  disabled={i === draft.questions.length - 1}
                  aria-label={ut("cq.moveDown")}
                  title={ut("cq.moveDown")}
                >
                  ↓
                </Button>
                <Button variant="quiet" size="sm" onClick={() => duplicate(i)} title={ut("cq.duplicate")}>⧉</Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setDraft((d) => ({ ...d, questions: d.questions.filter((_, k) => k !== i) }))}
                >
                  {ut("ui.delete")}
                </Button>
              </div>
            }
          >
            <Loc label={ut("cq.itemText")} value={q.title} onChange={(v) => upd(i, { title: v })} multiline />
            <Toggle label={ut("cq.required")} value={q.required} onChange={(v) => upd(i, { required: v })} />

            {q.options.length ? (
              <div className="mt-2 overflow-x-auto">
                <table>
                  <thead>
                    <tr><th>{ut("cq.option")}</th><th className="num">{ut("cq.score")}</th><th>{ut("cq.keyCode")}</th><th>{ut("cq.alarm")}</th></tr>
                  </thead>
                  <tbody>
                    {q.options.map((o, oi) => (
                      <tr key={oi}>
                        <td>
                          <div className="flex items-start gap-2">
                            <Input
                              value={o.text.uk ?? ""}
                              placeholder="українською"
                              onChange={(e) =>
                                upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, text: { ...x.text, uk: e.target.value } } : x)) })
                              }
                            />
                            <Input
                              value={o.text.ru ?? ""}
                              placeholder="по-русски"
                              onChange={(e) =>
                                upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, text: { ...x.text, ru: e.target.value } } : x)) })
                              }
                            />
                          </div>
                        </td>
                        <td className="num w-[90px]">
                          <Input
                            type="number"
                            value={o.score ?? 0}
                            onChange={(e) => upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, score: Number(e.target.value) } : x)) })}
                          />
                        </td>
                        <td className="w-[110px]">
                          <Input
                            value={o.keyCode ?? ""}
                            placeholder="yes / no"
                            onChange={(e) => upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, keyCode: e.target.value || null } : x)) })}
                          />
                        </td>
                        <td className="w-[130px]">
                          <label className="flex cursor-pointer items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={!!o.riskFlag}
                              className="size-4 shrink-0"
                              onChange={(e) => upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, riskFlag: e.target.checked } : x)) })}
                            />
                            <span className="text-caption">{ut("mark.critical")}</span>
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <Button
              className="mt-2"
              onClick={() => upd(i, { options: [...q.options, { text: { uk: "", ru: "" }, score: 0 }] })}
            >
              {ut("mb.addOption")}
            </Button>
          </Panel>
        </div>
      ))}
    </Stack>
  );
}
