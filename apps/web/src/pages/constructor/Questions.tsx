import { useState, type KeyboardEvent, type ReactElement } from "react";
import type { Issue } from "@quizzy/shared";
import { EditLangSwitch, Loc, useEditLang } from "./fields";
import { CnIc } from "./icons";
import {
  TYPES,
  duplicateQuestion,
  missingLang,
  moveQuestion,
  newUid,
  optionKey,
  questionsWithOwnAnswers,
  sharedOptions,
  type Draft,
  type DraftOption,
  type DraftQuestion,
} from "./model";
import { useLang } from "../../lang";
import { Callout, Ic, Tooltip } from "../../ui";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { Button, ErrorText, Field, Input, Select, Switch, Tag } from "../../ui/primitives";

/** Разделы конструктора — колонка «Структура» слева (макет methods-constructor) */
export type Section = "main" | "settings" | "questions" | "answers" | "scales" | "bands" | "json";

type SetDraft = (f: (d: Draft) => Draft) => void;

/** Вопрос несёт критический вариант: ответ им поднимет сигнал риска */
export const isCritical = (q: DraftQuestion) => q.options.some((o) => o.riskFlag);

/**
 * Пункты методики — свёрнутые строки и один раскрытый редактор (макет
 * methods-constructor).
 *
 * Открыт один пункт за раз: на двухстах пунктах МЛО раскрытые карточки не
 * листались, а прокручивались минутами. Строка свёрнутого пункта — одна
 * кнопка с именем «N текст … Розгорнути питання»: два элемента с одним
 * действием диктор прочёл бы дважды.
 *
 * Предпросмотр справа идёт за раскрытым пунктом: раскрытие само сообщает
 * номер (onFocusQuestion), свёрнутый пункт фокус не принимает.
 */
export function Questions({
  draft,
  setDraft,
  open,
  setOpen,
  onFocusQuestion,
  itemIssues,
  goto,
  onRemove,
  onAdd,
  onPaste,
}: {
  draft: Draft;
  setDraft: SetDraft;
  open: string | null;
  setOpen: (uid: string | null) => void;
  onFocusQuestion: (index: number) => void;
  /** Замечания проверки структуры по номеру пункта */
  itemIssues: Map<number, Issue[]>;
  goto: (s: Section) => void;
  /** Удалить пункт — экран удаляет и даёт «Скасувати» сообщением */
  onRemove: (index: number) => void;
  onAdd: () => void;
  onPaste: () => void;
}) {
  const { ut } = useLang();

  if (draft.questions.length === 0) {
    return (
      <Panel>
        <div className="flex flex-col items-center px-4 pb-4 pt-4 text-center">
          <span className="inline-grid size-12 place-items-center rounded-[14px] bg-violet-tint text-violet-ink">
            <CnIc.listOrdered size={22} />
          </span>
          <p className="m-0 mt-3 text-[16px] font-extrabold text-text">{ut("ce.noItems")}</p>
          <p className="m-0 mt-1 max-w-[440px] text-body text-text-2">{ut("ce.noItemsHint")}</p>
          <div className="mt-4 w-full max-w-[520px] text-left">
            <FirstQuestion
              onSeed={(title) =>
                setDraft((d) => ({
                  ...d,
                  questions: [
                    {
                      uid: newUid(),
                      type: (d.mode ?? "specific") === "specific" ? "yesno" : "single",
                      title,
                      required: true,
                      options: (d.mode ?? "specific") === "specific" ? sharedOptions(d.answers) : [],
                    },
                  ],
                }))
              }
            />
          </div>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <Button icon={<Ic.plus />} onClick={onAdd}>
              {ut("cq.addQuestion")}
            </Button>
            <Button variant="ghost" icon={<CnIc.paste />} onClick={onPaste}>
              {ut("co.bulkPaste")}
            </Button>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <ol className="m-0 flex list-none flex-col gap-2.5 p-0" aria-label={ut("co.questions")}>
      {draft.questions.map((q, i) =>
        open === q.uid ? (
          <li key={q.uid}>
            <QuestionEditor
              draft={draft}
              q={q}
              i={i}
              setDraft={setDraft}
              issues={itemIssues.get(i + 1) ?? []}
              onCollapse={() => setOpen(null)}
              onFocus={() => onFocusQuestion(i)}
              goto={goto}
              onRemove={() => onRemove(i)}
            />
          </li>
        ) : (
          <li key={q.uid}>
            <QuestionRow
              q={q}
              i={i}
              warn={(itemIssues.get(i + 1) ?? []).length > 0}
              onOpen={() => {
                setOpen(q.uid);
                onFocusQuestion(i);
              }}
            />
          </li>
        ),
      )}
    </ol>
  );
}

/** Свёрнутый пункт: номер, текст, пометки, вид — и шеврон (.qcol макета) */
function QuestionRow({ q, i, warn, onOpen }: { q: DraftQuestion; i: number; warn: boolean; onOpen: () => void }) {
  const { ut } = useLang();
  const lang = useEditLang();
  const title = q.title[lang] || "";
  const type = TYPES.find(([v]) => v === q.type);
  return (
    <button
      type="button"
      aria-expanded={false}
      onClick={onOpen}
      className={cx(
        "flex h-[52px] w-full cursor-pointer items-center gap-2.5 rounded-panel border border-border bg-panel pl-3 pr-2.5 text-left shadow-panel",
        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)] hover:bg-panel-2",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-ring",
      )}
    >
      <span className="w-6 shrink-0 text-body font-extrabold tabular-nums text-muted">{i + 1}</span>
      <span className={cx("min-w-0 flex-1 truncate text-body", title ? "text-text" : "italic text-muted")}>
        {title || ut("co.previewNoText")}
      </span>
      {isCritical(q) ? (
        <Tag tone="danger" icon={<CnIc.siren />}>
          {ut("ce.critical")}
        </Tag>
      ) : null}
      {warn ? <Tag tone="attention">{ut("ce.hasIssues")}</Tag> : null}
      {q.required ? null : <Tag>{ut("ce.optional")}</Tag>}
      <span className="shrink-0 whitespace-nowrap text-caption text-muted max-[1100px]:hidden">{type ? ut(type[1]) : q.type}</span>
      <span className="sr-only">{ut("cn.expand")}</span>
      <span aria-hidden className="inline-grid size-8 shrink-0 place-items-center rounded-[9px] text-muted">
        <Ic.chevronDown size={16} />
      </span>
    </button>
  );
}

/** Раскрытый пункт (.qed макета): шапка с действиями, текст, вид, ответы, сигнал риска */
function QuestionEditor({
  draft,
  q,
  i,
  setDraft,
  issues,
  onCollapse,
  onFocus,
  goto,
  onRemove,
}: {
  draft: Draft;
  q: DraftQuestion;
  i: number;
  setDraft: SetDraft;
  issues: Issue[];
  onCollapse: () => void;
  onFocus: () => void;
  goto: (s: Section) => void;
  onRemove: () => void;
}) {
  const { ut } = useLang();
  const lang = useEditLang();
  const mode = draft.mode ?? "specific";
  const n = draft.questions.length;
  const headId = `cn-q-${q.uid}`;
  const upd = (patch: Partial<DraftQuestion>) =>
    setDraft((d) => ({ ...d, questions: d.questions.map((x) => (x.uid === q.uid ? { ...x, ...patch } : x)) }));
  /*
   * Перестановка и копия — через модель: ключ шкалы ссылается на пункт
   * номером, и номера в нём переписываются вместе со списком (model.ts).
   */
  const move = (delta: number) => setDraft((d) => moveQuestion(d, i, delta));
  const other = lang === "uk" ? "ru" : "uk";
  const missing = missingLang(draft, other);

  /* Alt+↑/↓ — пункт выше или ниже, не уходя из поля */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    move(e.key === "ArrowUp" ? -1 : 1);
  };

  const iconBtn = (label: string, icon: ReactElement, onClick: () => void, disabled = false, kbd?: string) => (
    <Tooltip label={label} kbd={kbd}>
      <Button variant="quiet" size="icon-sm" aria-label={label} onClick={onClick} disabled={disabled}>
        {icon}
      </Button>
    </Tooltip>
  );

  return (
    <section
      aria-labelledby={headId}
      onFocusCapture={onFocus}
      onKeyDown={onKeyDown}
      className="rounded-panel bg-panel shadow-[0_0_0_1.5px_var(--vring),var(--shadow-panel)]"
    >
      <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-divider py-2 pl-3 pr-2.5">
        <span className="w-6 shrink-0 text-body font-extrabold tabular-nums text-violet-ink">{i + 1}</span>
        <h2 id={headId} className="m-0 whitespace-nowrap text-section font-extrabold tracking-[-0.015em] text-text">
          {ut("ce.questionN")} {i + 1}
        </h2>
        {isCritical(q) ? (
          <Tag tone="danger" icon={<CnIc.siren />}>
            {ut("ce.criticalItem")}
          </Tag>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          <Switch checked={q.required} onChange={(v) => upd({ required: v })} label={ut("cq.required")} className="mr-1.5" />
          <span aria-hidden className="mx-1.5 h-[22px] w-px bg-divider" />
          {iconBtn(ut("cq.moveUp"), <Ic.arrowUp size={15} />, () => move(-1), i === 0, "Alt ↑")}
          {iconBtn(ut("cq.moveDown"), <Ic.arrowDown size={15} />, () => move(1), i === n - 1, "Alt ↓")}
          {iconBtn(ut("cq.duplicate"), <CnIc.copy size={15} />, () => setDraft((d) => duplicateQuestion(d, i)))}
          {iconBtn(ut("ce.removeItem"), <CnIc.trash size={15} />, onRemove)}
          <Tooltip label={ut("cn.collapse")}>
            <Button variant="quiet" size="icon-sm" aria-label={ut("cn.collapse")} aria-expanded onClick={onCollapse}>
              <Ic.chevronDown size={16} className="rotate-180" />
            </Button>
          </Tooltip>
        </span>
      </div>

      <div className="px-4 pb-4 pt-3.5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <EditLangSwitch />
          <span className="text-small text-muted">
            {missing.length
              ? `${ut("ce.bothLangs")}; ${ut(other === "ru" ? "ce.missingRu" : "ce.missingUk")}: ${listNumbers(missing, ut("cst.andMore"))}`
              : ut("ce.bothLangsDone")}
          </span>
        </div>
        <Loc label={ut("cn.questionText")} value={q.title} onChange={(v) => upd({ title: v })} multiline rows={2} />
        <div className="grid grid-cols-[minmax(0,1fr)_190px] gap-x-3.5 max-[1100px]:grid-cols-1">
          <Loc label={ut("ce.help")} hint={ut("ce.helpHint")} value={q.help} onChange={(v) => upd({ help: v })} />
          <Field label={ut("cn.questionType")}>
            <Select value={q.type} onChange={(e) => upd({ type: e.target.value })}>
              {TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {ut(l)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {q.type === "info" ? null : mode === "complex" ? (
          <OwnAnswers options={q.options} onChange={(options) => upd({ options })} />
        ) : (
          <SharedAnswers draft={draft} q={q} onChange={(options) => upd({ options })} goto={goto} />
        )}

        {isCritical(q) ? (
          <Callout
            kind="risk"
            icon={<CnIc.shieldAlert />}
            className="mt-3"
            actions={
              <Button variant="ghost" size="xs" onClick={() => goto("settings")}>
                {ut("ce.setupSafety")}
              </Button>
            }
          >
            {ut("ce.criticalOpens")}
            {draft.alertEscalateMinutes
              ? `; ${ut("ce.criticalEscalates")} ${draft.alertEscalateMinutes} ${ut("ce.minutesShort")}`
              : `; ${ut("ce.criticalNoEscalation")}`}
            {(draft.safetyPlan?.[lang] || draft.safetyPlan?.uk || draft.safetyPlan?.ru || "").trim()
              ? `; ${ut("ce.criticalPlan")}.`
              : `; ${ut("ce.criticalNoPlan")}.`}
          </Callout>
        ) : null}

        {issues.length ? (
          <div className="mt-3 flex flex-col gap-1">
            {issues.map((it, k) => (
              <ErrorText key={k} tone="warn">
                {it.message}
              </ErrorText>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** «7, 12, 30 і ще 4» — номера пунктов, первые пять */
function listNumbers(ns: number[], more: string): string {
  const head = ns.slice(0, 5).join(", ");
  return ns.length > 5 ? `${head} ${more} ${ns.length - 5}` : head;
}

/** Переключатель «критичний»: красный по праву — ответ поднимает сигнал риска для человека */
function CriticalSwitch({ option, onChange }: { option: DraftOption; onChange: (v: boolean) => void }) {
  const { ut } = useLang();
  return (
    <Switch
      checked={!!option.riskFlag}
      onChange={onChange}
      label={
        <span className={option.riskFlag ? "font-extrabold text-risk-ink" : "text-muted"}>
          {option.riskFlag ? ut("ce.critical") : ut("ce.ordinary")}
        </span>
      }
      className="text-small [&_button[aria-checked=true]]:bg-risk"
    />
  );
}

/**
 * Подпись и уровень сигнала у критического ответа: без подписи проверка
 * структуры предупреждает (val.riskWithoutLabel), а специалист видит в
 * сигнале безымянный ответ. Уровень не задан — «високий»: так его читает и
 * сервер.
 */
function RiskRow({ option, onChange }: { option: DraftOption; onChange: (patch: Partial<DraftOption>) => void }) {
  const { ut } = useLang();
  const lang = useEditLang();
  return (
    <div className="ml-[30px] mt-1.5 grid grid-cols-[minmax(0,1fr)_170px] gap-2.5 pb-1 max-[1100px]:grid-cols-1">
      <Field label={ut("ce.riskLabel")} inline>
        <Input
          className="h-[34px]"
          value={option.riskLabel?.[lang] ?? ""}
          onChange={(e) => onChange({ riskLabel: { ...(option.riskLabel ?? {}), [lang]: e.target.value } })}
        />
      </Field>
      <Field label={ut("ce.riskSeverity")} inline>
        <Select
          className="h-[34px]"
          value={option.riskSeverity ?? "severe"}
          onChange={(e) => onChange({ riskSeverity: e.target.value as "moderate" | "severe" })}
        >
          <option value="severe">{ut("ce.riskSevere")}</option>
          <option value="moderate">{ut("ce.riskModerate")}</option>
        </Select>
      </Field>
    </div>
  );
}

/**
 * Конкретный тест: варианты пункта — общий набор теста («Відповіді»). Текст
 * и порядок правятся в своём разделе: правка в пункте разошлась бы с набором,
 * а ключ шкал ссылается на коды набора. Здесь — то, что у пункта своё:
 * позначка «критичний» (как у пункта 9 PHQ-9 или 3 СР-45). Правка набора её
 * не стирает (model.ts, applyAnswers).
 */
function SharedAnswers({
  draft,
  q,
  onChange,
  goto,
}: {
  draft: Draft;
  q: DraftQuestion;
  onChange: (o: DraftOption[]) => void;
  goto: (s: Section) => void;
}) {
  const { ut } = useLang();
  const lang = useEditLang();
  const own = questionsWithOwnAnswers({ ...draft, questions: [q] }) > 0 && q.options.length > 0;
  const set = (k: number, patch: Partial<DraftOption>) => onChange(q.options.map((o, i) => (i === k ? { ...o, ...patch } : o)));
  const grid = "grid grid-cols-[20px_minmax(0,1fr)_150px] items-center gap-2.5 max-[1100px]:grid-cols-[20px_minmax(0,1fr)_118px]";
  return (
    <div className="mt-1.5">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-caption font-bold text-muted">{ut("cn.answers")}</span>
        <span className="text-micro text-muted">{ut("ce.criticalHere")}</span>
      </div>
      <div className="overflow-hidden rounded-[12px] border border-border">
        <div className={cx(grid, "bg-panel-2 px-2.5 py-2 text-[11.5px] font-bold leading-[14px] text-muted")}>
          <span>№</span>
          <span>{ut("cn.answerText")}</span>
          <span>{ut("ce.criticalCol")}</span>
        </div>
        {q.options.map((o, k) => (
          <div key={optionKey(o, k)} className="border-t border-divider px-2.5 py-1.5">
            <div className={grid}>
              <span className="text-caption font-extrabold tabular-nums text-muted">{k + 1}</span>
              <span className="flex h-[34px] min-w-0 items-center truncate rounded-control bg-sunk px-3 text-body text-text">
                {o.text[lang] || o.text.uk || o.text.ru || "—"}
              </span>
              <CriticalSwitch option={o} onChange={(v) => set(k, { riskFlag: v })} />
            </div>
            {o.riskFlag ? <RiskRow option={o} onChange={(patch) => set(k, patch)} /> : null}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2.5 border-t border-divider px-2.5 py-1.5 text-caption text-muted">
          <Button variant="ghost" size="xs" icon={<CnIc.pencilLine />} onClick={() => goto("answers")}>
            {ut("ce.editSet")}
          </Button>
          <span className="ml-auto">{own ? ut("ce.ownSet") : ut("ce.sharedSetHint")}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Ответы пункта с баллом — комплексный тест: таблица «№ · текст · бал ·
 * критичний · прибрати» (макет methods-constructor).
 */
function OwnAnswers({ options, onChange }: { options: DraftOption[]; onChange: (o: DraftOption[]) => void }) {
  const { ut } = useLang();
  const lang = useEditLang();
  const set = (k: number, patch: Partial<DraftOption>) => onChange(options.map((o, i) => (i === k ? { ...o, ...patch } : o)));
  const add = () => onChange([...options, { uid: newUid(), text: { uk: "", ru: "" }, score: options.length }]);
  const grid = "grid grid-cols-[20px_minmax(0,1fr)_64px_150px_32px] items-center gap-2.5 max-[1100px]:grid-cols-[20px_minmax(0,1fr)_64px_118px_32px]";
  return (
    <div className="mt-1.5">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-caption font-bold text-muted">{ut("cn.answers")}</span>
        <span className="text-micro text-muted">{ut("ce.answersHint")}</span>
      </div>
      <div className="overflow-hidden rounded-[12px] border border-border">
        <div className={cx(grid, "bg-panel-2 px-2.5 py-2 text-[11.5px] font-bold leading-[14px] text-muted")}>
          <span>№</span>
          <span>{ut("cn.answerText")}</span>
          <span className="text-center">{ut("cq.score")}</span>
          <span>{ut("ce.criticalCol")}</span>
          <span />
        </div>
        {options.map((o, k) => (
          <div key={optionKey(o, k)} className="border-t border-divider px-2.5 py-1.5">
            <div className={grid}>
              <span className="text-caption font-extrabold tabular-nums text-muted">{k + 1}</span>
              <Field label={`${ut("cn.answerText")} ${k + 1}`} inline>
                <Input
                  className="h-[34px]"
                  value={o.text[lang] ?? ""}
                  onChange={(e) => set(k, { text: { ...o.text, [lang]: e.target.value } })}
                />
              </Field>
              <Field label={`${ut("cq.score")} ${k + 1}`} inline>
                <Input
                  type="number"
                  step="any"
                  className="h-[34px] px-1 text-center font-extrabold tabular-nums"
                  value={o.score ?? 0}
                  onChange={(e) => set(k, { score: Number(e.target.value) })}
                />
              </Field>
              <CriticalSwitch option={o} onChange={(v) => set(k, { riskFlag: v })} />
              <Tooltip label={ut("cn.removeOption")}>
                <Button
                  variant="quiet"
                  size="icon-sm"
                  aria-label={`${ut("cn.removeOption")}: ${o.text[lang] || k + 1}`}
                  onClick={() => onChange(options.filter((_, i) => i !== k))}
                >
                  <Ic.x size={15} />
                </Button>
              </Tooltip>
            </div>
            {o.riskFlag ? <RiskRow option={o} onChange={(patch) => set(k, patch)} /> : null}
          </div>
        ))}
        <div className="flex items-center gap-2.5 border-t border-divider px-2.5 py-1.5 text-caption text-muted">
          <Button variant="ghost" size="xs" icon={<Ic.plus />} onClick={add}>
            {ut("ce.answer")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Первый пункт пустого теста — поле, в котором его сразу и набирают. Пункт
 * заводится по выходу из поля или Enter, а не на каждую букву: иначе первая
 * же буква пересобрала бы список и отобрала фокус у того, кто печатает.
 * Пустое поле пункта не заводит.
 */
function FirstQuestion({ onSeed }: { onSeed: (title: Record<string, string>) => void }) {
  const { ut } = useLang();
  const lang = useEditLang();
  const [text, setText] = useState("");
  const seed = () => {
    if (text.trim()) onSeed({ uk: "", ru: "", [lang]: text });
  };
  return (
    <Field label={ut("cn.questionText")} hint={ut("ce.firstItemHint")}>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={seed}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            seed();
          }
        }}
      />
    </Field>
  );
}
