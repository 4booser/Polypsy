import { useState, type ReactNode } from "react";
import { BulkPaste } from "./BulkPaste";
import { Loc, Toggle, useEditLang } from "./fields";
import { TYPES, newUid, type Draft, type DraftOption, type DraftQuestion } from "./model";
import { useLang } from "../../lang";
import { cx } from "../../ui/cx";
import { IconCopy } from "../../ui/glyphs";
import { Button, Field, Input, Select } from "../../ui/primitives";

/**
 * Список вопросов — аккордеон по кадру f12.
 *
 * Строка: номер в рамке, «Питання» полужирным фиолетовым, под ним «короткий
 * опис питання», справа «+». Открыт один вопрос за раз, его строка серая, а
 * глиф — «−»; редактор раскрывается под строкой. Прежде каждый пункт был
 * раскрытой карточкой целиком, и на двухстах пунктах МЛО экран не листался,
 * а прокручивался минутами.
 *
 * Чего аккордеон стоит и как это оплачено:
 *  — ключ и баллы двух соседних пунктов рядом не сравнить; в конкретном тесте
 *    их и нет в вопросе — они в таблице баллов шкалы, где видны все разом;
 *  — предпросмотр идёт за фокусом, а свёрнутый пункт фокус не принимает —
 *    поэтому раскрытие само сообщает номер (onFocusQuestion), и предпросмотр
 *    не отстаёт.
 */
export function Questions({
  draft,
  setDraft,
  onFocusQuestion,
}: {
  draft: Draft;
  setDraft: (f: (d: Draft) => Draft) => void;
  /** Какой пункт сейчас правят: за ним идёт предпросмотр справа */
  onFocusQuestion?: (index: number) => void;
}) {
  const { ut } = useLang();
  const lang = useEditLang();
  const mode = draft.mode ?? "specific";
  const [open, setOpen] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);

  const text = (v: Record<string, string> | null | undefined) => v?.[lang] ?? "";

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
      const copy = { ...structuredClone(d.questions[i]!), uid: newUid() };
      const next = [...d.questions];
      next.splice(i + 1, 0, copy);
      return { ...d, questions: next };
    });

  /*
   * Новый вопрос в конкретном тесте получает общий набор ответов, в
   * комплексном — пустой список: там ответы свои у каждого вопроса (f23).
   */
  const add = () => {
    const uid = newUid();
    setDraft((d) => ({
      ...d,
      questions: [
        ...d.questions,
        {
          uid,
          type: (d.mode ?? "specific") === "specific" ? "yesno" : "single",
          title: { uk: "", ru: "" },
          required: true,
          options: (d.mode ?? "specific") === "specific" ? structuredClone(d.answers ?? []) : [],
        },
      ],
    }));
    setOpen(uid);
    onFocusQuestion?.(draft.questions.length);
  };

  const toggle = (q: DraftQuestion, i: number) => {
    const next = open === q.uid ? null : q.uid;
    setOpen(next);
    if (next) onFocusQuestion?.(i);
  };

  return (
    <section aria-labelledby="cn-questions">
      {/* в строке заголовка — один «+», как на кадре f24_1 */}
      <SectionHead id="cn-questions" title={ut("co.questions")}>
        <Button size="glyph" variant="ghost" onClick={add} aria-label={ut("cq.addQuestion")} title={ut("cq.addQuestion")}>
          +
        </Button>
      </SectionHead>

      {bulk ? (
        <div className="mb-[15px]">
          <BulkPaste
            onClose={() => setBulk(false)}
            onAppend={(questions) => setDraft((d) => ({ ...d, questions: [...d.questions, ...questions] }))}
          />
        </div>
      ) : null}

      {draft.questions.length === 0 && !bulk ? (
        <p className="m-0 text-[13px] text-muted">{ut("cq.noQuestions")}</p>
      ) : null}

      {draft.questions.length ? (
        /* карточка кадра: белая плоскость, линия #cccccc, радиус 5, строки через волосяную линию */
        <ol className="m-0 list-none rounded-[5px] border border-hairline bg-[var(--bg)] p-0">
          {draft.questions.map((q, i) => {
            const isOpen = open === q.uid;
            const bodyId = `cn-q-${q.uid}`;
            return (
              <li key={q.uid} className="border-b border-hairline last:border-b-0">
                {/*
                  Одна кнопка на всю строку, а не заголовок плюс глиф: два
                  элемента с одним действием читались бы диктору дважды, а
                  строка целиком — мишень заведомо шире 44px. «+»/«−» внутри —
                  рисунок, состояние несёт aria-expanded.
                */}
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={bodyId}
                  onClick={() => toggle(q, i)}
                  className={cx(
                    "flex w-full items-center gap-[14px] border-0 bg-transparent px-[20px] py-[12px] text-left",
                    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                  )}
                >
                  <span
                    aria-hidden
                    className="flex size-[38px] shrink-0 items-center justify-center rounded-[5px] border border-border text-[17px] font-bold text-text"
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cx("block truncate text-[17px] font-bold", isOpen ? "text-muted" : "text-primary")}>
                      <span className="sr-only">{i + 1}. </span>
                      {text(q.title) || ut("co.questions")}
                    </span>
                    <span className={cx("block truncate text-[13px]", isOpen ? "text-faint" : "text-muted")}>
                      {text(q.help) || ut("cn.shortDescription")}
                    </span>
                  </span>
                  <span aria-hidden className="w-[27px] shrink-0 text-center text-[27px] font-bold leading-none text-primary">
                    {isOpen ? "−" : "+"}
                  </span>
                  <span className="sr-only">{isOpen ? ut("cn.collapse") : ut("cn.expand")}</span>
                </button>

                {isOpen ? (
                  /*
                   * Фокус ловится на всплытии, а не на каждом поле: полей в
                   * пункте десяток, и вешать обработчик на каждое — способ
                   * забыть один.
                   */
                  <div id={bodyId} className="px-[20px] pb-[20px]" onFocusCapture={() => onFocusQuestion?.(i)}>
                    <Loc label={ut("cn.questionText")} value={q.title} onChange={(v) => upd(i, { title: v })} multiline rows={2} />
                    <Loc label={ut("cn.shortDescription")} value={q.help} onChange={(v) => upd(i, { help: v })} />

                    {mode === "complex" ? (
                      <OwnAnswers
                        options={q.options}
                        onChange={(options) => upd(i, { options })}
                      />
                    ) : null}

                    <div className="mt-[15px] flex flex-wrap items-center gap-x-[14px] gap-y-[6px]">
                      <Field label={ut("cn.questionType")} inline className="w-[190px]">
                        <Select value={q.type} onChange={(e) => upd(i, { type: e.target.value })}>
                          {TYPES.map(([v, l]) => (
                            <option key={v} value={v}>{ut(l)}</option>
                          ))}
                        </Select>
                      </Field>
                      <Toggle label={ut("cq.required")} value={q.required} onChange={(v) => upd(i, { required: v })} />
                      <span className="flex-1" />
                      <Button variant="quiet" size="sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={ut("cq.moveUp")} title={ut("cq.moveUp")}>↑</Button>
                      <Button variant="quiet" size="sm" onClick={() => move(i, 1)} disabled={i === draft.questions.length - 1} aria-label={ut("cq.moveDown")} title={ut("cq.moveDown")}>↓</Button>
                      <Button variant="quiet" size="sm" onClick={() => duplicate(i)} aria-label={ut("cq.duplicate")} title={ut("cq.duplicate")}><IconCopy /></Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => {
                          setOpen(null);
                          setDraft((d) => ({ ...d, questions: d.questions.filter((_, k) => k !== i) }));
                        }}
                      >
                        {ut("ui.delete")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {/*
        «Вставити пункти з тексту» — не в строке заголовка, где на кадре один
        «+», а строкой под списком, 13-м кеглем подсказок. Убрать совсем
        нельзя: перенос из пособия — главный путь заведения методики на
        двести пунктов, по одному их не набирает никто. Пока окно вставки
        открыто, строка не нужна. Мишень нажатия дорисована накладкой до 44,
        как у глифов: строка от этого не растёт.
      */}
      {!bulk ? (
        <p className="m-0 mt-[8px] text-[13px] text-muted">
          <button
            type="button"
            onClick={() => setBulk(true)}
            className="relative border-0 bg-transparent p-0 text-[13px] text-primary underline-offset-2 after:absolute after:inset-x-0 after:-inset-y-[12px] after:content-[''] hover:underline focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
          >
            {ut("co.bulkPaste")}
          </button>
        </p>
      ) : null}
      {/*
        Ключ шкал ссылается на номера, а не на вопросы: ↑/↓ после того, как
        таблица баллов заполнена, молча сдвигают ключ. Подсказка стоит только
        когда ключ уже есть — до того сдвигать нечего.
      */}
      {draft.scales.some((s) => s.key.length) ? (
        <p className="m-0 mt-[8px] text-[13px] text-muted">{ut("cn.reorderHint")}</p>
      ) : null}
    </section>
  );
}

/**
 * Ответы одного вопроса с баллом — комплексный тест (f23): широкое поле
 * текста, узкое поле балла, «−» у строки и «+» после последней.
 *
 * «Критичний» — отметка варианта, поднимающего тревогу немедленно. На кадре
 * её нет, но это не украшение, а защита пациента (options.risk_flag), и
 * снять её с формы значило бы завести тесты, где такой ответ проходит молча.
 */
function OwnAnswers({ options, onChange }: { options: DraftOption[]; onChange: (o: DraftOption[]) => void }) {
  const { ut } = useLang();
  const lang = useEditLang();
  const set = (k: number, patch: Partial<DraftOption>) => onChange(options.map((o, i) => (i === k ? { ...o, ...patch } : o)));
  const add = () => onChange([...options, { text: { uk: "", ru: "" }, score: 0 }]);
  return (
    <div className="mt-[15px]">
      {/* h3 под h2 раздела «Питання»: уровень не пропускается, как и в карточке шкалы */}
      <h3 className="m-0 mb-[8px] text-[17px] font-bold text-primary">{ut("cn.answers")}</h3>
      <div className="flex flex-col gap-[8px]">
        {options.map((o, k) => (
          <div key={k} className="flex items-center gap-[10px]">
            <Field label={ut("cn.answerText")} inline className="min-w-0 flex-1">
              <Input value={o.text[lang] ?? ""} onChange={(e) => set(k, { text: { ...o.text, [lang]: e.target.value } })} />
            </Field>
            <Field label={ut("cq.score")} inline className="w-[84px] shrink-0">
              <Input type="number" className="text-center" value={o.score ?? 0} onChange={(e) => set(k, { score: Number(e.target.value) })} />
            </Field>
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[13px] text-muted">
              <input type="checkbox" className="size-4" checked={!!o.riskFlag} onChange={(e) => set(k, { riskFlag: e.target.checked })} />
              {ut("mark.critical")}
            </label>
            <Button size="glyph" variant="ghost" aria-label={`${ut("cn.removeOption")}: ${o.text[lang] ?? k + 1}`} onClick={() => onChange(options.filter((_, i) => i !== k))}>
              −
            </Button>
          </div>
        ))}
        <div>
          <Button size="glyph" variant="ghost" aria-label={ut("cn.addAnswer")} title={ut("cn.addAnswer")} onClick={add}>
            +
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Заголовок раздела формы: 18/700 фиолетовым слева, глифы действий справа —
 * строка «Питання  +» и «Шкала 1  +» макета. Один компонент на все разделы,
 * чтобы отступ 28px над ним не расходился по экрану.
 */
export function SectionHead({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-[12px] mt-[28px] flex items-center justify-between gap-[14px] first:mt-0">
      <h2 id={id} className="m-0 text-[18px] font-bold leading-tight text-primary">{title}</h2>
      {children ? <div className="flex items-center gap-[14px]">{children}</div> : null}
    </div>
  );
}
