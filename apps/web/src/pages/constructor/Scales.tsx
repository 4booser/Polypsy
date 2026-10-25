import { useState } from "react";
import type { UiKey } from "@quizzy/shared";
import { api } from "../../api";
import { useResource } from "../../useResource";
import { ShellIcon } from "../../shell/icons";
import { EditLangSwitch, Loc, Toggle, useEditLang } from "./fields";
import { CnIc } from "./icons";
import type { Section } from "./Questions";
import {
  addRowItems,
  applyAnswers,
  keyRows,
  newScale,
  newUid,
  nextKeyCode,
  optionKey,
  parseItemList,
  questionsWithOwnAnswers,
  removeRowItem,
  setRowWeight,
  totalScale,
  type Draft,
  type DraftBand,
  type DraftScale,
} from "./model";
import { useLang } from "../../lang";
import { Ic, Tooltip } from "../../ui";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { Button, Field, Input, Select, SeverityTag } from "../../ui/primitives";
import { occurrenceKeys } from "../../ui/rowKeys";
import { choiceLabel, keepChosen } from "../../ui/choices";

type SetDraft = (f: (d: Draft) => Draft) => void;
type Batteries = { id: string; title: string; archived?: boolean }[] | null;

/** Код шкалы — пилюля моноширинным: это идентификатор, а не слово */
export function CodePill({ code, on }: { code: string; on?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex h-6 shrink-0 items-center rounded-[7px] px-2 font-mono text-[11.5px] font-bold",
        on ? "bg-violet-tint text-violet-ink" : "bg-sunk text-text-2",
      )}
    >
      {code}
    </span>
  );
}

/** Тяжесть полосы → ступень набора (sev-0…4): «виражена» — красная, остальные спокойнее */
const SEV_BAR: Record<DraftBand["severity"], string> = {
  none: "bg-sev-0",
  mild: "bg-sev-1",
  moderate: "bg-sev-2",
  severe: "bg-sev-4",
};

/** Слово тяжести полосы — то же, что в селекте «Вираженість» */
const SEV_WORD = {
  none: "cs.sevNormal",
  mild: "cs.sevMild",
  moderate: "cs.sevModerate",
  severe: "cs.sevSevere",
} as const satisfies Record<DraftBand["severity"], UiKey>;

/** Номера пунктов шкалы короткими отрезками: «1–9, 12» */
export function itemRanges(items: number[]): string {
  const sorted = [...new Set(items)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    out.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return out.join(", ");
}

/** Пункты шкалы: из ключа, а если ключ собирается по коду шкалы — из пунктов с этим кодом */
function scaleItems(s: DraftScale, draft: Draft): number[] {
  if (s.key.length) return s.key.map((k) => k.item);
  return draft.questions.flatMap((q, i) => (q.scaleCode === s.code ? [i + 1] : []));
}

/**
 * Сводка шкал под пунктами (панель «Шкали» макета): код, название, из чего
 * считается, полосы цветом тяжести — и «Правити». Стоит под пунктами, потому
 * что ключ ссылается на их номера.
 */
export function ScalesSummary({ draft, setDraft, goto }: { draft: Draft; setDraft: SetDraft; goto: (s: Section) => void }) {
  const { ut } = useLang();
  const lang = useEditLang();
  const complex = (draft.mode ?? "specific") === "complex";
  const text = (v: Record<string, string> | null | undefined) => v?.[lang] || v?.uk || v?.ru || "";
  const norm: Record<DraftScale["normalization"], string> = {
    raw: ut("cs.raw"),
    ratio: ut("cs.ratio"),
    tscore: ut("co.tScores"),
    sten: ut("cs.sten"),
  };
  return (
    <Panel
      title={complex ? ut("cn.results") : ut("ce.scales")}
      icon={<ShellIcon name="sigma" />}
      sub={ut("ce.keyFollows")}
      actions={
        complex ? null : (
          <Button
            variant="ghost"
            size="xs"
            icon={<Ic.plus />}
            onClick={() => {
              setDraft((d) => ({ ...d, scales: [...d.scales, newScale(d.scales)] }));
              goto("scales");
            }}
          >
            {ut("cn.scale")}
          </Button>
        )
      }
    >
      {draft.scales.length === 0 ? (
        <p className="m-0 text-small text-muted">{complex ? ut("ce.noBands") : ut("cn.noScales")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {draft.scales.map((s, i) => {
            const items = scaleItems(s, draft);
            return (
              <li key={s.uid} className="flex flex-wrap items-center gap-3 border-t border-divider py-2.5 first:border-t-0 first:pt-0">
                <CodePill code={s.code} on />
                <div className="min-w-0 flex-1">
                  <b className="block truncate text-h3 font-extrabold text-text">{text(s.title) || `${ut("cn.scale")} ${i + 1}`}</b>
                  <span className="block text-small text-muted">
                    {ut(s.kind === "validity" ? "cs.validity" : "cs.clinical")}, {norm[s.normalization]}
                    {items.length ? `, ${ut("ce.itemsWord")} ${itemRanges(items)}` : `, ${ut("ce.noKeyYet")}`}
                  </span>
                </div>
                {s.bands.length ? (
                  <span className="flex items-center gap-0.5" aria-hidden>
                    {s.bands.map((b, k) => (
                      <i key={optionKey(b, k)} className={cx("block h-1.5 w-4 rounded-[3px]", SEV_BAR[b.severity])} />
                    ))}
                  </span>
                ) : null}
                <span className="text-small text-muted">
                  {ut("ce.bandsShort")}: {s.bands.length}
                </span>
                <Button size="xs" icon={<CnIc.pencilLine />} onClick={() => goto(complex ? "bands" : "scales")}>
                  {ut("ce.edit")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/**
 * «Відповіді» — общий набор ответов конкретного теста: текст на языке правки
 * и «прибрати». Код ответа (yes/no/k3) выдаётся сам и на экран не выводится:
 * набранный руками код разошёлся бы с ключом (nextKeyCode). Правка набора
 * копируется во все пункты (applyAnswers).
 */
export function Answers({ draft, setDraft }: { draft: Draft; setDraft: SetDraft }) {
  const { ut } = useLang();
  const lang = useEditLang();
  const answers = draft.answers ?? [];
  const differ = questionsWithOwnAnswers(draft);
  const update = (next: Draft["answers"]) => setDraft((d) => applyAnswers(d, next ?? []));
  const grid = "grid grid-cols-[24px_minmax(0,1fr)_32px] items-center gap-2.5";

  return (
    <Panel
      title={ut("cn.answers")}
      icon={<Ic.list />}
      count={answers.length}
      actions={<EditLangSwitch />}
      hint={`${ut("cn.answersHint")}${differ ? `; ${differ} ${ut("cn.answersDiffer")}` : ""}`}
    >
      <div className="overflow-hidden rounded-[12px] border border-border">
        <div className={cx(grid, "bg-panel-2 px-2.5 py-2 text-[11.5px] font-bold leading-[14px] text-muted")}>
          <span>№</span>
          <span>{ut("cn.answerText")}</span>
          <span />
        </div>
        {answers.map((a, i) => (
          <div key={optionKey(a, i)} className={cx(grid, "border-t border-divider px-2.5 py-1.5")}>
            <span className="text-caption font-extrabold tabular-nums text-muted">{i + 1}</span>
            <Field label={`${ut("cn.answerText")} ${i + 1}`} inline>
              <Input
                className="h-[34px]"
                value={a.text[lang] ?? ""}
                onChange={(e) => update(answers.map((x, k) => (k === i ? { ...x, text: { ...x.text, [lang]: e.target.value } } : x)))}
              />
            </Field>
            <Tooltip label={ut("cn.removeOption")}>
              <Button
                variant="quiet"
                size="icon-sm"
                aria-label={`${ut("cn.removeOption")}: ${a.text[lang] || i + 1}`}
                disabled={answers.length <= 1}
                onClick={() => update(answers.filter((_, k) => k !== i))}
              >
                <Ic.x size={15} />
              </Button>
            </Tooltip>
          </div>
        ))}
        <div className="border-t border-divider px-2.5 py-1.5">
          <Button
            variant="ghost"
            size="xs"
            icon={<Ic.plus />}
            onClick={() => update([...answers, { uid: newUid(), text: { uk: "", ru: "" }, keyCode: nextKeyCode(answers.map((a) => a.keyCode)) }])}
          >
            {ut("ce.answer")}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/**
 * Шкалы конкретного теста: название, описание, «Відповідність» — ответ →
 * номера пунктов → бал (scale_items { matchKey, weight }), поправки от других
 * шкал и психометрика. Полосы — в своём разделе («Смуги результату»).
 */
export function Scales({ draft, setDraft }: { draft: Draft; setDraft: SetDraft }) {
  const { ut } = useLang();
  const lang = useEditLang();
  const text = (v: Record<string, string> | null | undefined) => v?.[lang] || v?.uk || v?.ru || "";
  const upd = (uid: string, patch: Partial<DraftScale> | ((s: DraftScale) => DraftScale)) =>
    setDraft((d) => ({
      ...d,
      scales: d.scales.map((s) => (s.uid === uid ? (typeof patch === "function" ? patch(s) : { ...s, ...patch }) : s)),
    }));
  const add = () => setDraft((d) => ({ ...d, scales: [...d.scales, newScale(d.scales)] }));
  const scaleName = (code: string) => {
    const s = draft.scales.find((x) => x.code === code);
    return s ? text(s.title) || s.code : code;
  };

  return (
    <div className="flex flex-col gap-4">
      {draft.scales.length === 0 ? (
        <Panel title={ut("ce.scales")} icon={<ShellIcon name="sigma" />}>
          <p className="m-0 text-small text-muted">{ut("cn.noScales")}</p>
        </Panel>
      ) : null}
      {draft.scales.map((s, i) => (
        <ScaleCard
          key={s.uid}
          index={i}
          scale={s}
          draft={draft}
          scaleName={scaleName}
          onChange={(patch) => upd(s.uid, patch)}
          onDelete={() => setDraft((d) => ({ ...d, scales: d.scales.filter((x) => x.uid !== s.uid) }))}
        />
      ))}
      <div>
        <Button icon={<Ic.plus />} onClick={add}>
          {ut("cs.addScale")}
        </Button>
      </div>
    </div>
  );
}

function ScaleCard({
  index,
  scale: s,
  draft,
  scaleName,
  onChange,
  onDelete,
}: {
  index: number;
  scale: DraftScale;
  draft: Draft;
  scaleName: (code: string) => string;
  onChange: (patch: Partial<DraftScale> | ((s: DraftScale) => DraftScale)) => void;
  onDelete: () => void;
}) {
  const { ut } = useLang();
  const lang = useEditLang();
  const rows = keyRows(s, draft.answers ?? []);
  const answerLabel = (matchKey: string | null) => {
    if (matchKey === null) return ut("cn.scoreByOption");
    const a = (draft.answers ?? []).find((x) => x.keyCode === matchKey);
    return a ? a.text[lang] || a.text.uk || a.text.ru || matchKey : matchKey;
  };
  const [adding, setAdding] = useState<string | null>(null);
  const [builder, setBuilder] = useState<{ from: string; coefficient: string }>({ from: "", coefficient: "0.5" });
  const others = draft.scales.filter((x) => x.uid !== s.uid && x.code);
  const title = s.title[lang] || s.title.uk || s.title.ru || `${ut("cn.scale")} ${index + 1}`;

  /* номер, перечень или диапазон: «5», «1-10, 15» — ключ из пособия набирается одной строкой */
  const commitItem = (matchKey: string | null, raw: string) => {
    const items = parseItemList(raw, draft.questions.length);
    if (items.length) onChange((cur) => addRowItems(cur, matchKey, items));
    setAdding(null);
  };

  const termKeys = occurrenceKeys(s.corrections, (c) => c.from);
  const addTerm = () => {
    const coefficient = Number(builder.coefficient);
    if (!builder.from || !Number.isFinite(coefficient)) return;
    onChange((cur) => ({ ...cur, corrections: [...cur.corrections, { from: builder.from, coefficient }] }));
    setBuilder({ from: "", coefficient: "0.5" });
  };
  const grid = "grid grid-cols-[150px_minmax(0,1fr)_72px] items-center gap-2.5 max-[1100px]:grid-cols-[110px_minmax(0,1fr)_64px]";

  return (
    <Panel
      title={
        <span className="flex min-w-0 items-center gap-2">
          <CodePill code={s.code} on />
          <span className="truncate">{title}</span>
        </span>
      }
      icon={<ShellIcon name="sigma" />}
      actions={
        <>
          <EditLangSwitch />
          <Tooltip label={ut("cn.deleteScale")}>
            <Button variant="quiet" size="icon-sm" aria-label={`${ut("cn.deleteScale")}: ${title}`} onClick={onDelete}>
              <CnIc.trash size={15} />
            </Button>
          </Tooltip>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-3.5 max-[1100px]:grid-cols-1">
        <Loc label={ut("cs.scaleTitle")} value={s.title} onChange={(v) => onChange({ title: v })} />
        <Loc label={ut("cn.scaleDescription")} value={s.description} onChange={(v) => onChange({ description: v })} />
      </div>

      {/* ── відповідність: ответ → номера пунктов → бал (ряд ключа шкалы) ── */}
      <div className="mb-1.5 mt-1 flex items-baseline justify-between gap-2">
        <h3 className="m-0 text-caption font-bold text-muted">{ut("cn.matching")}</h3>
        <span className="text-micro text-muted">{ut("ce.matchingHint")}</span>
      </div>
      <div className="overflow-hidden rounded-[12px] border border-border">
        <div className={cx(grid, "bg-panel-2 px-2.5 py-2 text-[11.5px] font-bold leading-[14px] text-muted")}>
          <span>{ut("ce.answer")}</span>
          <span>{ut("cn.itemNumbers")}</span>
          <span className="text-center">{ut("cn.points")}</span>
        </div>
        {rows.map((row) => {
          const rowKey = row.matchKey ?? "";
          const labelId = `cn-scale-${s.uid}-row-${rowKey || "score"}`;
          return (
            <div key={rowKey} role="group" aria-labelledby={labelId} className={cx(grid, "border-t border-divider px-2.5 py-1.5")}>
              <span id={labelId} className="truncate text-body font-bold text-violet-ink">
                {answerLabel(row.matchKey)}
              </span>
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                {row.items.map((n) => {
                  /*
                   * Номер за концом списка: пункт удалили, а ключ на него
                   * остался. Янтарь — «требует внимания»; проверка структуры
                   * назовёт то же самое.
                   */
                  const dangling = n > draft.questions.length;
                  return (
                    <button
                      key={n}
                      type="button"
                      aria-label={`${ut("cn.removeItem")} ${n}${dangling ? ` — ${ut("cn.danglingItem")}` : ""}`}
                      title={dangling ? ut("cn.danglingItem") : `${ut("cn.removeItem")} ${n}`}
                      onClick={() => onChange((cur) => removeRowItem(cur, row.matchKey, n))}
                      className={cx(
                        "inline-grid h-7 min-h-0 min-w-7 cursor-pointer place-items-center rounded-[8px] border-0 px-1.5 text-small font-extrabold tabular-nums",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-ring",
                        dangling ? "bg-warn-tint-2 text-warn" : "bg-violet-tint text-violet-ink hover:bg-violet-tint-2",
                      )}
                    >
                      {n}
                    </button>
                  );
                })}
                {adding === rowKey ? (
                  <span className="inline-block w-28">
                    <Input
                      inputMode="numeric"
                      autoFocus
                      aria-label={ut("cn.addItems")}
                      title={ut("cn.addItems")}
                      placeholder={ut("cn.addItemsPh")}
                      className="h-7 px-1.5"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitItem(row.matchKey, e.currentTarget.value);
                        if (e.key === "Escape") setAdding(null);
                      }}
                      onBlur={(e) => commitItem(row.matchKey, e.currentTarget.value)}
                    />
                  </span>
                ) : null}
                <Tooltip label={ut("cn.addItem")}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-7"
                    aria-label={`${ut("cn.addItem")}: ${answerLabel(row.matchKey)}`}
                    onClick={() => setAdding(rowKey)}
                  >
                    <Ic.plus size={14} />
                  </Button>
                </Tooltip>
              </div>
              <Field label={`${ut("cn.points")}: ${title}, ${answerLabel(row.matchKey)}`} inline>
                <Input
                  type="number"
                  step="any"
                  className="h-[34px] px-1 text-center font-extrabold tabular-nums"
                  value={row.weight}
                  onChange={(e) => onChange((cur) => setRowWeight(cur, row.matchKey, Number(e.target.value)))}
                />
              </Field>
            </div>
          );
        })}
      </div>

      {/* ── поправки от других шкал: балл + коэффициент × балл другой шкалы (Hs + 0,5·K) ── */}
      <div className="mb-1.5 mt-4 flex items-baseline justify-between gap-2">
        <h3 className="m-0 text-caption font-bold text-muted">{ut("cn.formula")}</h3>
        <span className="text-micro text-muted">{ut("ce.formulaHint")}</span>
      </div>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-control bg-sunk p-1.5">
        {s.corrections.length === 0 ? <span className="px-1.5 text-small text-muted">{ut("cn.formulaEmpty")}</span> : null}
        {s.corrections.map((c, ci) => (
          <span
            /* ключ — шкала-источник и номер её вхождения, а не место: снятое слагаемое не отдаёт соседу поле коэффициента */
            key={termKeys[ci]}
            className="inline-flex h-8 items-center gap-1.5 rounded-[9px] bg-panel pl-2.5 pr-0.5 text-small font-bold text-text shadow-tile"
          >
            {scaleName(c.from)}
            <span className="text-muted">×</span>
            <span className="inline-block w-14">
              <Input
                type="number"
                step="any"
                aria-label={`${ut("cn.coefficient")}: ${scaleName(c.from)}`}
                className="h-7 px-1 text-center font-extrabold tabular-nums"
                value={c.coefficient}
                onChange={(e) =>
                  onChange((cur) => ({
                    ...cur,
                    corrections: cur.corrections.map((x, k) => (k === ci ? { ...x, coefficient: Number(e.target.value) } : x)),
                  }))
                }
              />
            </span>
            <Tooltip label={ut("cn.removeTerm")}>
              <Button
                variant="quiet"
                size="icon-sm"
                className="size-7"
                aria-label={`${ut("cn.removeTerm")}: ${scaleName(c.from)}`}
                onClick={() => onChange((cur) => ({ ...cur, corrections: cur.corrections.filter((_, k) => k !== ci) }))}
              >
                <Ic.x size={14} />
              </Button>
            </Tooltip>
          </span>
        ))}
      </div>
      {others.length ? (
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_96px_auto] items-end gap-2">
          <Field label={ut("ce.correctionFrom")} inline>
            <Select value={builder.from} onChange={(e) => setBuilder((b) => ({ ...b, from: e.target.value }))}>
              <option value="">{ut("ce.correctionFrom")}</option>
              {others.map((o) => (
                <option key={o.uid} value={o.code}>
                  {scaleName(o.code)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={ut("cn.coefficient")} inline>
            <Input
              type="number"
              step="any"
              className="text-center"
              value={builder.coefficient}
              onChange={(e) => setBuilder((b) => ({ ...b, coefficient: e.target.value }))}
            />
          </Field>
          <Button icon={<Ic.plus />} disabled={!builder.from || !Number.isFinite(Number(builder.coefficient))} onClick={addTerm}>
            {ut("cn.addTerm")}
          </Button>
        </div>
      ) : null}

      {/* ── психометрика: чего на макете нет, а у встроенных методик есть ── */}
      <details className="group mt-4 rounded-control bg-sunk px-3 py-2">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-small font-bold text-violet-ink [&::-webkit-details-marker]:hidden">
          <Ic.chevronRight size={14} className="transition-transform group-open:rotate-90" />
          {ut("cn.psychometrics")}
        </summary>
        <div className="grid grid-cols-2 gap-x-3.5 pt-3 max-[1100px]:grid-cols-1">
          <Field label={ut("cs.code")} hint={ut("cn.codeHint")}>
            {/* без плейсхолдера: код выдаётся сам (newScale), пустым поле не бывает */}
            <Input className="font-mono" value={s.code} onChange={(e) => onChange({ code: e.target.value })} />
          </Field>
          <Field label={ut("cs.role")}>
            <Select value={s.kind} onChange={(e) => onChange({ kind: e.target.value as DraftScale["kind"] })}>
              <option value="clinical">{ut("cs.clinical")}</option>
              <option value="validity">{ut("cs.validity")}</option>
            </Select>
          </Field>
          <Field label={ut("cs.normalization")}>
            <Select value={s.normalization} onChange={(e) => onChange({ normalization: e.target.value as DraftScale["normalization"] })}>
              <option value="raw">{ut("cs.raw")}</option>
              <option value="ratio">{ut("cs.ratio")}</option>
              <option value="tscore">{ut("co.tScores")}</option>
              <option value="sten">{ut("cs.sten")}</option>
            </Select>
          </Field>
          {s.normalization === "ratio" ? (
            <Field label={ut("cs.denominator")}>
              <Input
                type="number"
                value={s.ratioDenominator ?? ""}
                onChange={(e) => onChange({ ratioDenominator: e.target.value ? Number(e.target.value) : null })}
              />
            </Field>
          ) : null}
          {s.kind === "validity" ? (
            <>
              <Field label={ut("cs.threshold")}>
                <Input
                  type="number"
                  step="0.01"
                  value={s.validityThreshold ?? ""}
                  onChange={(e) => onChange({ validityThreshold: e.target.value ? Number(e.target.value) : null })}
                />
              </Field>
              <Field label={ut("cs.violated")}>
                <Select value={s.validityDirection ?? "above"} onChange={(e) => onChange({ validityDirection: e.target.value as "above" | "below" })}>
                  <option value="above">{ut("co.aboveThreshold")}</option>
                  <option value="below">{ut("co.belowThreshold")}</option>
                </Select>
              </Field>
            </>
          ) : null}
        </div>
        <p className="m-0 mt-1 text-small text-muted">{ut("cn.normsJsonHint")}</p>
      </details>
    </Panel>
  );
}

/**
 * «Смуги результату»: диапазоны балла каждой шкалы. В конкретном тесте — по
 * панели на шкалу, в комплексном — «Результати» единственной итоговой шкалы
 * (она заводится при первом диапазоне, ключ на все пункты ставится при
 * отправке, withTotalKey).
 */
export function BandsSection({ draft, setDraft }: { draft: Draft; setDraft: SetDraft }) {
  const { ut } = useLang();
  const lang = useEditLang();
  /*
   * Все наборы, с архивными: выбранный каскад на архивный остаётся виден с
   * пометкой. Пока список не пришёл — null, а не пустой список: пустой назвал
   * бы выбранный каскад удалённым.
   */
  const batteries = useResource(() => api.batteries(), []).data;
  const [details, setDetails] = useState(false);
  const complex = (draft.mode ?? "specific") === "complex";
  const toggle = <Toggle label={ut("cn.bandDetails")} value={details} onChange={setDetails} />;

  if (complex) {
    const bands = draft.scales[0]?.bands ?? [];
    return (
      <Panel title={ut("cn.results")} icon={<ShellIcon name="ruler" />} hint={ut("ce.resultsHint")} actions={<EditLangSwitch />} footer={toggle}>
        <Bands
          bands={bands}
          details={details}
          batteries={batteries}
          onChange={(next) =>
            setDraft((d) => {
              const first = d.scales[0] ?? totalScale();
              return { ...d, scales: [{ ...first, bands: next }, ...d.scales.slice(1)] };
            })
          }
        />
      </Panel>
    );
  }

  if (!draft.scales.length) {
    return (
      <Panel title={ut("ce.bands")} icon={<ShellIcon name="ruler" />}>
        <p className="m-0 text-small text-muted">{ut("ce.bandsNeedScale")}</p>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {draft.scales.map((s, i) => (
        <Panel
          key={s.uid}
          title={
            <span className="flex min-w-0 items-center gap-2">
              <CodePill code={s.code} on />
              <span className="truncate">{s.title[lang] || s.title.uk || s.title.ru || `${ut("cn.scale")} ${i + 1}`}</span>
            </span>
          }
          icon={<ShellIcon name="ruler" />}
          actions={i === 0 ? <EditLangSwitch /> : undefined}
          footer={i === draft.scales.length - 1 ? toggle : undefined}
        >
          <Bands
            bands={s.bands}
            details={details}
            batteries={batteries}
            onChange={(bands) => setDraft((d) => ({ ...d, scales: d.scales.map((x) => (x.uid === s.uid ? { ...x, bands } : x)) }))}
          />
        </Panel>
      ))}
    </div>
  );
}

/**
 * Диапазоны результата: «від · до · текст · тяжесть · прибрати». Широкое
 * поле — подпись полосы: её видят специалист в результатах и человек в
 * кабинете. Тяжесть, оценка, каскад, повторы и рекомендация — под
 * переключателем «Клінічні поля»: тревоги и каскады наборов живут ими.
 */
export function Bands({
  bands,
  onChange,
  details,
  batteries,
}: {
  bands: DraftBand[];
  onChange: (b: DraftBand[]) => void;
  details?: boolean;
  /**
   * Наборы для каскада; null — список ещё не пришёл (или не пришёл вовсе).
   * Пока списка нет, выбранное подписано «завантаження», а селект выключен:
   * выбирать не из чего, и сменить каскад вслепую нельзя.
   */
  batteries: Batteries;
}) {
  const { ut } = useLang();
  const lang = useEditLang();
  const set = (k: number, patch: Partial<DraftBand>) => onChange(bands.map((b, i) => (i === k ? { ...b, ...patch } : b)));
  const liveBatteries = (batteries ?? []).filter((x) => !x.archived);
  const knownBattery = (id: string) => {
    const x = batteries?.find((y) => y.id === id);
    return x ? { title: x.title, retired: !!x.archived } : null;
  };
  const batteryWords = { retired: ut("bt.archived"), unavailable: ut("choice.unavailable"), unknown: ut("choice.batteryGone") };
  const cascadeChoices = (chosen: string): { id: string; label: string }[] =>
    batteries === null
      ? chosen
        ? [{ id: chosen, label: ut("common.loading") }]
        : []
      : keepChosen(liveBatteries, chosen, knownBattery).map((c) => ({ id: c.id, label: choiceLabel(c, batteryWords) }));
  const add = () => {
    const last = bands[bands.length - 1];
    onChange([
      ...bands,
      {
        uid: newUid(),
        minScore: last ? last.maxScore + 1 : 0,
        maxScore: last ? last.maxScore + 10 : 10,
        label: { uk: "", ru: "" },
        severity: "none",
      },
    ]);
  };

  return (
    <div className="flex flex-col gap-2">
      {bands.map((b, k) => {
        const range = `${b.minScore}–${b.maxScore}`;
        return (
          /* ключ — uid полосы: «прибрати» у средней строки не отдаёт её поля нижней вместе с курсором */
          <div key={optionKey(b, k)} className="flex flex-col gap-1.5 border-b border-divider pb-2 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2">
              <span aria-hidden className="text-small text-muted">
                {ut("cn.from")}
              </span>
              <Field label={`${ut("cn.from")} ${k + 1}`} inline className="w-[72px] shrink-0">
                <Input
                  type="number"
                  step="any"
                  className="h-[34px] px-1 text-center font-extrabold tabular-nums"
                  value={b.minScore}
                  onChange={(e) => set(k, { minScore: Number(e.target.value) })}
                />
              </Field>
              <span aria-hidden className="text-small text-muted">
                {ut("cn.to")}
              </span>
              <Field label={`${ut("cn.to")} ${k + 1}`} inline className="w-[72px] shrink-0">
                <Input
                  type="number"
                  step="any"
                  className="h-[34px] px-1 text-center font-extrabold tabular-nums"
                  value={b.maxScore}
                  onChange={(e) => set(k, { maxScore: Number(e.target.value) })}
                />
              </Field>
              <Field label={`${ut("cn.resultText")} ${range}`} inline className="min-w-[160px] flex-1">
                <Input className="h-[34px]" value={b.label[lang] ?? ""} onChange={(e) => set(k, { label: { ...b.label, [lang]: e.target.value } })} />
              </Field>
              {details ? null : (
                <SeverityTag level={b.severity} small>
                  {ut(SEV_WORD[b.severity])}
                </SeverityTag>
              )}
              <Tooltip label={ut("cn.removeBand")}>
                <Button variant="quiet" size="icon-sm" aria-label={`${ut("cn.removeBand")} ${range}`} onClick={() => onChange(bands.filter((_, i) => i !== k))}>
                  <Ic.x size={15} />
                </Button>
              </Tooltip>
            </div>
            {details ? (
              <div className="grid grid-cols-[150px_84px_minmax(0,1fr)_96px] gap-2 max-[1100px]:grid-cols-2">
                <Field label={`${ut("cs.severity")} ${range}`} inline>
                  <Select value={b.severity} onChange={(e) => set(k, { severity: e.target.value as DraftBand["severity"] })}>
                    <option value="none">{ut("cs.sevNormal")}</option>
                    <option value="mild">{ut("cs.sevMild")}</option>
                    <option value="moderate">{ut("cs.sevModerate")}</option>
                    <option value="severe">{ut("cs.sevSevere")}</option>
                  </Select>
                </Field>
                <Field label={`${ut("cs.grade")} ${range}`} inline>
                  <Input type="number" placeholder={ut("cs.grade")} value={b.grade ?? ""} onChange={(e) => set(k, { grade: e.target.value ? Number(e.target.value) : null })} />
                </Field>
                <Field label={`${ut("cs.cascade")} ${range}`} hint={ut("cs.cascadeHint")} inline>
                  <Select value={b.cascadeBatteryId ?? ""} disabled={batteries === null} onChange={(e) => set(k, { cascadeBatteryId: e.target.value || null })}>
                    <option value="">{ut("co.noCascade")}</option>
                    {/*
                      Каскад на архивную батарею — пунктом с пометкой: без него
                      селект показывал «без каскада», а каскад оставался в
                      силе и уходил на сервер при каждом сохранении (ui/choices.ts).
                    */}
                    {cascadeChoices(b.cascadeBatteryId ?? "").map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={`${ut("cs.repeatDays")} ${range}`} hint={ut("cs.repeatHint")} inline>
                  <Input placeholder={ut("cn.repeatDaysExample")} value={b.followUpDays ?? ""} onChange={(e) => set(k, { followUpDays: e.target.value || null })} />
                </Field>
                <Field label={`${ut("cn.recommendation")} ${range}`} inline className="col-span-full">
                  <Input
                    value={b.recommendation?.[lang] ?? ""}
                    onChange={(e) => set(k, { recommendation: { ...(b.recommendation ?? {}), [lang]: e.target.value } })}
                  />
                </Field>
              </div>
            ) : null}
          </div>
        );
      })}
      <div>
        <Button variant="ghost" size="xs" icon={<Ic.plus />} onClick={add}>
          {ut("cn.addBand")}
        </Button>
      </div>
    </div>
  );
}
