import { useMemo, useState } from "react";
import { computeProfile, renderCoded, type Answer } from "@quizzy/shared";
import { useLang } from "../../lang";
import { ShellIcon } from "../../shell/icons";
import { Ic } from "../../ui";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { Button, Readout, SeverityTag } from "../../ui/primitives";
import { CnIc } from "./icons";
import { draftToSurvey, type Draft, type DraftQuestion } from "./model";
import { CodePill } from "./Scales";

/** Виды пункта, где человек выбирает вариант: их и выбирает проверка ключа */
const PICK_ONE = new Set(["single", "yesno"]);
const PICK_MANY = new Set(["multiple"]);

/**
 * Перегляд и перевірка ключа — правая колонка конструктора (макет
 * methods-constructor).
 *
 * Перегляд показывает ровно то, что увидит человек: текст, пояснение,
 * варианты, «Назад» и «Далі». Ключи, баллы и флаги риска сюда не попадают —
 * человек их не видит, и предпросмотр, показывающий больше реальности, не
 * отвечает на вопрос, ради которого существует.
 *
 * Варианты в перегляде выбираются, и выбранное считает «Перевірка ключа» тем
 * же движком, что и сервер (computeProfile из общего пакета): перенос
 * методики из пособия иначе проверялся только после публикации. Своя
 * реализация подсчёта отвечала бы на вопрос «сходятся ли две реализации», а
 * не «верен ли ключ».
 */
export function Preview({
  draft,
  at: focused,
  onPick,
}: {
  draft: Draft;
  /** Какой пункт правят: перегляд идёт за ним */
  at?: number;
  /** Нажатие на клетку ключа — открыть этот пункт и в редакторе */
  onPick?: (index: number) => void;
}) {
  const { ut, lang } = useLang();
  const [at, setAt] = useState(focused ?? 0);
  const [picked, setPicked] = useState<Map<string, string[]>>(new Map());

  /*
   * Перегляд идёт за правкой, но листать его можно и самому: внешний номер не
   * подменяет внутренний, а сдвигает его — перелистнул, и смотришь туда, пока
   * не тронешь другой пункт.
   */
  const [lastFocused, setLastFocused] = useState(focused ?? 0);
  if (focused !== undefined && focused !== lastFocused) {
    setLastFocused(focused);
    setAt(focused);
  }

  const shown = draft.questions;
  const index = Math.min(at, Math.max(0, shown.length - 1));
  const current: DraftQuestion | undefined = shown[index];
  const asked = shown.filter((q) => q.type !== "info");
  const askedIndex = asked.findIndex((q) => q.uid === current?.uid);
  const text = (value: Record<string, string> | null | undefined): string => value?.[lang] || value?.uk || value?.ru || "";
  const qid = (i: number) => `q${i + 1}`;
  const oid = (i: number, k: number) => `q${i + 1}o${k + 1}`;

  /* профиль пересчитывается на каждый выбор: методика в памяти, подсчёт — чистая функция */
  const profile = useMemo(() => {
    if (!picked.size) return null;
    const survey = draftToSurvey(draft, lang);
    const answers: Answer[] = [...picked.entries()].map(([questionId, optionIds]) => ({ questionId, optionIds }));
    try {
      return computeProfile(survey, answers);
    } catch {
      // недостроенный ключ — не повод ронять редактор
      return null;
    }
  }, [draft, lang, picked]);

  const choose = (i: number, k: number, many: boolean) =>
    setPicked((prev) => {
      const next = new Map(prev);
      const id = oid(i, k);
      const had = next.get(qid(i)) ?? [];
      next.set(qid(i), many ? (had.includes(id) ? had.filter((x) => x !== id) : [...had, id]) : [id]);
      return next;
    });

  /* критические ответы среди выбранных — «спрацює критичний пункт N» */
  const critical = shown.flatMap((q, i) =>
    q.options.some((o, k) => o.riskFlag && (picked.get(qid(i)) ?? []).includes(oid(i, k))) ? [i + 1] : [],
  );

  return (
    <div className="flex flex-col gap-4">
      <Panel title={ut("co.preview")} icon={<ShellIcon name="smartphone" />}>
        <div className="rounded-panel bg-sunk p-3.5">
          {!current ? (
            <p className="m-0 py-6 text-center text-small text-muted">{ut("co.previewEmpty")}</p>
          ) : (
            <div
              data-preview
              className="rounded-[18px] bg-panel p-3.5 shadow-[inset_0_0_0_1px_var(--border),var(--shadow-panel)]"
            >
              <div className="flex items-center justify-between gap-2 text-[11.5px] font-bold leading-none text-muted">
                <span className="min-w-0 truncate">{text(draft.title) || ut("cst.title")}</span>
                <span data-preview-at className="shrink-0 tabular-nums">
                  {index + 1} {ut("ce.of")} {shown.length}
                </span>
              </div>
              {draft.showProgress && askedIndex >= 0 ? (
                <div className="mt-2 h-1 overflow-hidden rounded-[2px] bg-track">
                  <i className="block h-full rounded-[2px] bg-violet" style={{ width: `${((askedIndex + 1) / Math.max(1, asked.length)) * 100}%` }} />
                </div>
              ) : null}
              {current.type === "info" ? (
                <p className="m-0 mt-3 whitespace-pre-line text-body text-text">{text(current.title)}</p>
              ) : (
                <>
                  <p data-preview-question className="m-0 mt-3 text-[15px] font-extrabold leading-[21px] text-text">
                    {text(current.title) || <span className="font-semibold italic text-muted">{ut("co.previewNoText")}</span>}
                  </p>
                  {text(current.help) ? <p className="m-0 mt-1 text-small text-text-2">{text(current.help)}</p> : null}
                  <PreviewAnswers
                    q={current}
                    chosen={picked.get(qid(index)) ?? []}
                    oid={(k) => oid(index, k)}
                    onChoose={(k, many) => choose(index, k, many)}
                    text={text}
                  />
                </>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button size="xs" disabled={index === 0} onClick={() => setAt(Math.max(0, index - 1))}>
                  {ut("ce.back")}
                </Button>
                <Button variant="primary" size="xs" disabled={index >= shown.length - 1} onClick={() => setAt(Math.min(shown.length - 1, index + 1))}>
                  {ut("ce.next")}
                </Button>
              </div>
            </div>
          )}
          <p className="m-0 mt-2 text-caption text-muted">{ut("co.previewHint")}</p>
        </div>
      </Panel>

      <Panel
        title={ut("co.keyCheck")}
        icon={<CnIc.calculator />}
        actions={
          picked.size ? (
            <Button variant="ghost" size="xs" icon={<CnIc.rotate />} onClick={() => setPicked(new Map())}>
              {ut("co.keyReset")}
            </Button>
          ) : null
        }
      >
        <p className="m-0 text-small text-text-2">{ut("ce.keyHint")}</p>
        {asked.length ? (
          <div className="mt-3 flex flex-wrap gap-1" role="list" aria-label={ut("ce.keyCells")}>
            {shown.map((q, i) => {
              if (q.type === "info") return null;
              const ids = picked.get(qid(i)) ?? [];
              const options = q.options.filter((_, k) => ids.includes(oid(i, k)));
              const score = options.reduce((s, o) => s + (o.score ?? 0), 0);
              const risky = options.some((o) => o.riskFlag);
              const top = Math.max(1, ...q.options.map((o) => o.score ?? 0));
              const tone = !options.length
                ? "bg-panel text-muted shadow-[inset_0_0_0_1px_var(--ctl)]"
                : risky
                  ? "bg-risk text-onfill"
                  : score <= 0
                    ? "bg-sunk text-text-2"
                    : score / top <= 1 / 3
                      ? "bg-answer-1 text-answer-1-ink"
                      : score / top <= 2 / 3
                        ? "bg-answer-2 text-answer-2-ink"
                        : "bg-answer-3 text-answer-3-ink";
              return (
                <button
                  key={q.uid}
                  type="button"
                  role="listitem"
                  aria-label={`${ut("ce.questionN")} ${i + 1}${options.length ? `: ${score}` : ""}`}
                  title={`${ut("ce.questionN")} ${i + 1}`}
                  onClick={() => {
                    setAt(i);
                    onPick?.(i);
                  }}
                  className={cx(
                    "inline-grid h-7 min-h-0 w-7 cursor-pointer place-items-center rounded-[8px] border-0 p-0 text-small font-extrabold tabular-nums",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-ring",
                    i === index && "outline outline-2 outline-offset-1 outline-violet-ring",
                    tone,
                  )}
                >
                  {options.length ? score : ""}
                </button>
              );
            })}
          </div>
        ) : null}

        {picked.size ? (
          profile?.scores.length ? (
            <div className="mt-3 flex flex-col gap-2.5">
              {profile.scores.map((sc) =>
                profile.scores.length === 1 ? (
                  <div key={sc.scaleCode} className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[26px] font-extrabold leading-none tracking-[-0.02em] tabular-nums text-text">{sc.rawScore}</span>
                    <span className="text-body font-bold tabular-nums text-muted">/{sc.maxScore}</span>
                    {sc.band ? (
                      <SeverityTag level={sc.band.severity} small>
                        {sc.band.label}
                      </SeverityTag>
                    ) : null}
                  </div>
                ) : (
                  <div key={sc.scaleCode} className="flex items-center gap-2">
                    <CodePill code={sc.scaleCode} />
                    <span className="min-w-0 flex-1 truncate text-small text-text-2">{sc.scaleTitle}</span>
                    <b className="text-body font-extrabold tabular-nums text-text">
                      {sc.rawScore}
                      <span className="font-bold text-muted">/{sc.maxScore}</span>
                    </b>
                    {sc.band ? (
                      <SeverityTag level={sc.band.severity} small>
                        {sc.band.label}
                      </SeverityTag>
                    ) : null}
                  </div>
                ),
              )}
            </div>
          ) : (
            /* шкалы есть, а балла нет — движок ждёт больше ответов (доля отвеченных); почему — в предупреждениях ниже */
            <p className="m-0 mt-3 text-small text-muted">{draft.scales.length ? ut("ce.keyNotYet") : ut("co.keyNoScales")}</p>
          )
        ) : null}
        {critical.length ? (
          <p className="m-0 mt-2 flex items-center gap-1.5 text-small font-bold text-risk-ink">
            <CnIc.siren size={14} />
            {ut("ce.criticalFires")} {critical.join(", ")}
          </p>
        ) : null}
        {profile?.warnings.length ? (
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-small text-warn">
            {/* движок отдаёт предупреждения кодами — фразу собираем на языке консоли */}
            {profile.warnings.map((w, i) => (
              <li key={i} className="flex gap-1.5">
                <Ic.alert size={14} className="mt-0.5" />
                {renderCoded(w, lang)}
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </div>
  );
}

/** Варианты пункта так, как их увидит человек: радио или флажки; прочие виды — силуэтом поля */
function PreviewAnswers({
  q,
  chosen,
  oid,
  onChoose,
  text,
}: {
  q: DraftQuestion;
  chosen: string[];
  oid: (k: number) => string;
  onChoose: (k: number, many: boolean) => void;
  text: (v: Record<string, string> | null | undefined) => string;
}) {
  const { ut } = useLang();
  const one = PICK_ONE.has(q.type);
  const many = PICK_MANY.has(q.type);
  const options = q.options.map((o, k) => ({ o, k })).filter(({ o }) => (o.kind ?? "option") === "option");
  if (one || many) {
    if (!options.length) return <p className="m-0 mt-3 text-small text-muted">{ut("co.previewNoOptions")}</p>;
    return (
      <div role={one ? "radiogroup" : "group"} aria-label={ut("ce.previewAnswer")} className="mt-3 flex flex-col gap-1.5">
        {options.map(({ o, k }) => {
          const on = chosen.includes(oid(k));
          return (
            <button
              key={o.uid ?? k}
              type="button"
              role={one ? "radio" : "checkbox"}
              aria-checked={on}
              onClick={() => onChoose(k, many)}
              className={cx(
                "flex min-h-[42px] w-full cursor-pointer items-center justify-start gap-2.5 whitespace-normal rounded-[12px] border-0 px-3 py-2 text-left text-body font-bold",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-ring",
                on ? "bg-violet-tint text-violet-ink shadow-[inset_0_0_0_1.5px_var(--v)]" : "bg-sunk text-text hover:bg-sunk-2",
              )}
            >
              <i
                aria-hidden
                className={cx(
                  "size-[18px] shrink-0 bg-panel",
                  one ? "rounded-full" : "rounded-[5px]",
                  on ? "shadow-[inset_0_0_0_5.5px_var(--v)]" : "shadow-[inset_0_0_0_1.5px_var(--ctl)]",
                )}
              />
              {text(o.text) || <span className="text-muted">—</span>}
            </button>
          );
        })}
      </div>
    );
  }
  if (options.length) {
    return (
      <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
        {options.map(({ o, k }) => (
          <li key={o.uid ?? k} className="rounded-[12px] bg-sunk px-3 py-2.5 text-body font-bold text-text">
            {text(o.text) || "—"}
          </li>
        ))}
      </ul>
    );
  }
  const range = q.minValue !== null && q.minValue !== undefined && q.maxValue !== null && q.maxValue !== undefined;
  return (
    <Readout look="fill" className="mt-3 text-muted">
      {range ? `${text(q.minLabel) || q.minValue} … ${text(q.maxLabel) || q.maxValue}` : ut("ce.previewFree")}
    </Readout>
  );
}
