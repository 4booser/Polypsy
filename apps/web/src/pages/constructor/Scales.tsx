import { useState } from "react";
import { api } from "../../api";
import { useResource } from "../../useResource";
import { Loc, Toggle, useEditLang } from "./fields";
import { SectionHead } from "./Questions";
import {
  addRowItem,
  applyAnswers,
  keyRows,
  newScale,
  nextKeyCode,
  questionsWithOwnAnswers,
  removeRowItem,
  setRowWeight,
  type Draft,
  type DraftBand,
  type DraftScale,
} from "./model";
import { useLang } from "../../lang";
import { cx } from "../../ui/cx";
import { Button, Field, Input, Select } from "../../ui/primitives";

type SetDraft = (f: (d: Draft) => Draft) => void;

/**
 * «Відповіді» — общий набор ответов теста (кадр f24): чипы «1 Так · 2 Ні»,
 * «+» добавляет ответ. Номер на чипе — порядковый, код ответа (yes/no/k3)
 * выдаётся сам и на экран не выводится: его нет на кадре, а набранный
 * руками код разошёлся бы с ключом (см. nextKeyCode).
 *
 * «−» после «+» убирает последний ответ, а не стоит у каждого чипа: набор
 * ответов меняют редко, а три лишних глифа в строке из трёх чипов читались
 * бы как шесть кнопок вместо трёх ответов.
 */
export function Answers({ draft, setDraft }: { draft: Draft; setDraft: SetDraft }) {
  const { ut } = useLang();
  const lang = useEditLang();
  const answers = draft.answers ?? [];
  const differ = questionsWithOwnAnswers(draft);
  const update = (next: Draft["answers"]) => setDraft((d) => applyAnswers(d, next ?? []));

  return (
    <section aria-labelledby="cn-answers">
      <SectionHead id="cn-answers" title={ut("cn.answers")} />
      <div className="flex flex-wrap items-center gap-[14px]">
        {answers.map((a, i) => {
          const value = a.text[lang] ?? "";
          return (
            <div key={i} className="flex h-9 items-center gap-[10px] rounded-[5px] border border-border bg-[var(--bg)] px-[10px]">
              <span aria-hidden className="text-[17px] font-bold text-text">{i + 1}</span>
              <Field label={`${ut("cn.answerText")} ${i + 1}`} inline>
                {/*
                  Поле внутри чипа: без своей рамки и заливки, шириной по
                  тексту. Стилем, а не классами: `border-0` против `border`
                  и `bg-transparent` против заливки в Tailwind решаются
                  порядком в собранном файле, а не в строке классов.
                */}
                <Input
                  value={value}
                  onChange={(e) => update(answers.map((x, k) => (k === i ? { ...x, text: { ...x.text, [lang]: e.target.value } } : x)))}
                  className="h-7 px-0 text-[17px] font-bold"
                  style={{ background: "transparent", border: 0, color: "var(--primary)", width: `${Math.max(4, value.length + 1)}ch` }}
                />
              </Field>
            </div>
          );
        })}
        <Button
          size="glyph"
          variant="ghost"
          aria-label={ut("cn.addAnswer")}
          title={ut("cn.addAnswer")}
          onClick={() => update([...answers, { text: { uk: "", ru: "" }, keyCode: nextKeyCode(answers.map((a) => a.keyCode)) }])}
        >
          +
        </Button>
        {answers.length > 1 ? (
          <Button
            size="glyph"
            variant="ghost"
            aria-label={ut("cn.removeLastAnswer")}
            title={ut("cn.removeLastAnswer")}
            onClick={() => update(answers.slice(0, -1))}
          >
            −
          </Button>
        ) : null}
      </div>
      <p className="m-0 mt-[8px] text-[13px] text-muted">
        {ut("cn.answersHint")}
        {differ ? ` · ${differ} ${ut("cn.answersDiffer")}` : ""}
      </p>
    </section>
  );
}

/**
 * Шкалы конкретного теста — кадры f24_2, f30, f37.
 *
 * Карточка шкалы: название, описание, «Відповідність» (таблица баллов:
 * ответ → номера вопросов → балл), «розрахунок балу» (поправки от других
 * шкал чипами) и «Результати» (диапазоны). Кадры расходятся, где стоят
 * диапазоны: f24_2 выносит «Результати» под форму с выпадающим «Шкала»,
 * f30 держит их внутри фрагмента шкалы. Взят f30: полоса принадлежит шкале
 * (scale_bands.scale_id), и выбирать её ещё раз из списка — лишний шаг.
 */
export function Scales({ draft, setDraft }: { draft: Draft; setDraft: SetDraft }) {
  const { ut } = useLang();
  const lang = useEditLang();
  // батареи нужны для каскадов: попадание в полосу может назначить углублённую
  const batteries = (useResource(() => api.batteries(), []).data ?? []).filter((b) => !b.archived);
  const text = (v: Record<string, string> | null | undefined) => v?.[lang] || v?.uk || v?.ru || "";

  const upd = (uid: string, patch: Partial<DraftScale> | ((s: DraftScale) => DraftScale)) =>
    setDraft((d) => ({
      ...d,
      scales: d.scales.map((s) => (s.uid === uid ? (typeof patch === "function" ? patch(s) : { ...s, ...patch }) : s)),
    }));

  const addAfter = (index: number) =>
    setDraft((d) => {
      const next = [...d.scales];
      next.splice(index + 1, 0, newScale(d.scales));
      return { ...d, scales: next };
    });

  const scaleName = (code: string) => {
    const s = draft.scales.find((x) => x.code === code);
    return s ? text(s.title) || s.code : code;
  };

  if (!draft.scales.length) {
    return (
      <section aria-labelledby="cn-scale-none">
        <SectionHead id="cn-scale-none" title={`${ut("cn.scale")} 1`}>
          <Button size="glyph" variant="ghost" aria-label={ut("cs.addScale")} title={ut("cs.addScale")} onClick={() => addAfter(-1)}>
            +
          </Button>
        </SectionHead>
        <p className="m-0 text-[13px] text-muted">{ut("cn.noScales")}</p>
      </section>
    );
  }

  return (
    <>
      {draft.scales.map((s, i) => (
        <ScaleCard
          key={s.uid}
          index={i}
          scale={s}
          draft={draft}
          batteries={batteries}
          scaleName={scaleName}
          onChange={(patch) => upd(s.uid, patch)}
          onAdd={() => addAfter(i)}
          onDelete={() => setDraft((d) => ({ ...d, scales: d.scales.filter((x) => x.uid !== s.uid) }))}
        />
      ))}
    </>
  );
}

function ScaleCard({
  index,
  scale: s,
  draft,
  batteries,
  scaleName,
  onChange,
  onAdd,
  onDelete,
}: {
  index: number;
  scale: DraftScale;
  draft: Draft;
  batteries: { id: string; title: string }[];
  scaleName: (code: string) => string;
  onChange: (patch: Partial<DraftScale> | ((s: DraftScale) => DraftScale)) => void;
  onAdd: () => void;
  onDelete: () => void;
}) {
  const { ut } = useLang();
  const lang = useEditLang();
  const headId = `cn-scale-${s.uid}`;
  const rows = keyRows(s, draft.answers ?? []);
  const answerLabel = (matchKey: string | null) => {
    if (matchKey === null) return ut("cn.scoreByOption");
    const a = (draft.answers ?? []).find((x) => x.keyCode === matchKey);
    return a ? a.text[lang] || a.text.uk || a.text.ru || matchKey : matchKey;
  };
  const [adding, setAdding] = useState<string | null>(null);
  const [builder, setBuilder] = useState<{ from: string; coefficient: string }>({ from: "", coefficient: "0.5" });
  const [bandDetails, setBandDetails] = useState(false);
  const others = draft.scales.filter((x) => x.uid !== s.uid && x.code);

  const commitItem = (matchKey: string | null, raw: string) => {
    const n = Number(raw);
    if (raw.trim() && Number.isInteger(n)) onChange((cur) => addRowItem(cur, matchKey, n));
    setAdding(null);
  };

  const addTerm = () => {
    const coefficient = Number(builder.coefficient);
    if (!builder.from || !Number.isFinite(coefficient)) return;
    onChange((cur) => ({ ...cur, corrections: [...cur.corrections, { from: builder.from, coefficient }] }));
    setBuilder({ from: "", coefficient: "0.5" });
  };

  return (
    <section aria-labelledby={headId}>
      <SectionHead id={headId} title={`${ut("cn.scale")} ${index + 1}`}>
        <Button size="glyph" variant="ghost" aria-label={ut("cs.addScale")} title={ut("cs.addScale")} onClick={onAdd}>
          +
        </Button>
      </SectionHead>

      <div className="rounded-[5px] border border-hairline bg-[var(--bg)] p-[20px]">
        <Loc label={ut("cs.scaleTitle")} value={s.title} onChange={(v) => onChange({ title: v })} />
        <Loc label={ut("cn.scaleDescription")} value={s.description} onChange={(v) => onChange({ description: v })} />

        {/* ── Відповідність: таблица баллов (f37) ── */}
        <h3 className="m-0 mb-[8px] mt-[20px] text-[17px] font-bold text-primary">{ut("cn.matching")}</h3>
        <div className="mb-[4px] hidden text-[13px] text-muted sm:grid sm:grid-cols-[140px_1fr_72px] sm:gap-[10px]">
          <span>{ut("cn.matching")}</span>
          <span>{ut("cn.itemNumbers")}</span>
          <span className="text-center">{ut("cn.points")}</span>
        </div>
        <div className="flex flex-col gap-[6px]">
          {rows.map((row) => {
            const rowKey = row.matchKey ?? "";
            const labelId = `${headId}-row-${rowKey || "score"}`;
            return (
              <div key={rowKey} role="group" aria-labelledby={labelId} className="flex flex-wrap items-center gap-[10px]">
                <span
                  id={labelId}
                  className="flex h-9 w-[140px] shrink-0 items-center justify-center rounded-[5px] bg-primary-soft px-2 text-[17px] font-bold text-primary"
                >
                  <span className="truncate">{answerLabel(row.matchKey)}</span>
                </span>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-[8px]">
                  {row.items.map((n) => {
                    /*
                     * Чип, указывающий за конец списка: вопрос удалили, а
                     * ключ на него остался. Янтарь — «требует внимания», как
                     * всюду в системе; проверка структуры назовёт то же самое.
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
                          /* видимый квадрат 36, нажимается 44: см. размер glyph у Button */
                          "relative flex size-9 items-center justify-center rounded-[5px] border bg-[var(--bg)] p-0 text-[17px] font-bold",
                          "after:absolute after:-inset-1 after:content-['']",
                          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                          dangling ? "border-[var(--accent)] text-accent" : "border-border text-primary hover:bg-primary-soft",
                        )}
                      >
                        {n}
                      </button>
                    );
                  })}
                  {adding === rowKey ? (
                    <span className="inline-block w-[64px]">
                      <Input
                        type="number"
                        min={1}
                        max={draft.questions.length || undefined}
                        autoFocus
                        aria-label={ut("cn.addItem")}
                        className="text-center"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitItem(row.matchKey, e.currentTarget.value);
                          if (e.key === "Escape") setAdding(null);
                        }}
                        onBlur={(e) => commitItem(row.matchKey, e.currentTarget.value)}
                      />
                    </span>
                  ) : null}
                  <Button
                    size="glyph"
                    variant="ghost"
                    aria-label={`${ut("cn.addItem")}: ${answerLabel(row.matchKey)}`}
                    title={ut("cn.addItem")}
                    onClick={() => setAdding(rowKey)}
                  >
                    +
                  </Button>
                </div>
                <Field label={`${ut("cn.points")}: ${answerLabel(row.matchKey)}`} inline className="w-[72px] shrink-0">
                  <Input
                    type="number"
                    step="any"
                    className="text-center font-bold"
                    value={row.weight}
                    onChange={(e) => onChange((cur) => setRowWeight(cur, row.matchKey, Number(e.target.value)))}
                  />
                </Field>
              </div>
            );
          })}
        </div>

        {/* ── розрахунок балу: поправки от других шкал (f30) ── */}
        {/*
          На кадре формула — чипы «Шкала 2 · Ні · × 0.5». В модели это
          scale_corrections { sourceScaleCode, coefficient }: балл шкалы плюс
          коэффициент × балл другой шкалы (Hs = Hs + 0,5·K). Чип «Ні» —
          поправка от ОДНОГО ряда чужой шкалы — в модели не выражается и здесь
          не рисуется; см. api_gaps в отчёте. Слагаемые собственного ключа в
          формулу не дублируются: они стоят в таблице выше, колонка «Бали».
        */}
        <p id={`${headId}-formula`} className="m-0 mb-[4px] mt-[15px] text-[13px] text-muted">{ut("cn.formula")}</p>
        <div className="flex items-center gap-[10px]">
          <div
            role="group"
            aria-labelledby={`${headId}-formula`}
            className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-[6px] rounded-[5px] border border-border bg-[var(--bg)] px-[8px] py-[3px]"
          >
            {s.corrections.length === 0 ? (
              <span className="text-[17px] font-bold text-primary-dim">{ut("cn.formulaEmpty")}</span>
            ) : null}
            {s.corrections.map((c, ci) => (
              <span
                key={ci}
                className="inline-flex items-center gap-[6px] rounded-[5px] bg-primary-soft py-[2px] pl-[10px] pr-[2px] text-[17px] font-bold text-primary"
              >
                {scaleName(c.from)}
                <span aria-hidden>×</span>
                {/* ширина — на обёртке: у поля своё `w-full`, и спорить с ним классом нельзя */}
                <span className="inline-block w-[64px]">
                  <Input
                    type="number"
                    step="any"
                    aria-label={`${ut("cn.coefficient")}: ${scaleName(c.from)}`}
                    className="h-7 text-center"
                    value={c.coefficient}
                    onChange={(e) =>
                      onChange((cur) => ({
                        ...cur,
                        corrections: cur.corrections.map((x, k) => (k === ci ? { ...x, coefficient: Number(e.target.value) } : x)),
                      }))
                    }
                  />
                </span>
                <button
                  type="button"
                  aria-label={`${ut("cn.removeTerm")}: ${scaleName(c.from)}`}
                  title={ut("cn.removeTerm")}
                  onClick={() => onChange((cur) => ({ ...cur, corrections: cur.corrections.filter((_, k) => k !== ci) }))}
                  /* видимый квадрат 27, нажимается 44 — та же накладка, что у размера glyph кнопки */
                  className="relative size-[27px] border-0 bg-transparent p-0 text-[20px] leading-none text-primary after:absolute after:left-1/2 after:top-1/2 after:size-[44px] after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <Button
            size="glyph"
            variant="ghost"
            aria-label={ut("cn.addTerm")}
            title={ut("cn.addTerm")}
            disabled={!builder.from || !Number.isFinite(Number(builder.coefficient))}
            onClick={addTerm}
          >
            +
          </Button>
        </div>
        {/* нижняя строка кадра f30: откуда брать слагаемое и с каким коэффициентом */}
        <div className="mt-[8px] grid grid-cols-[minmax(0,1fr)_140px] gap-[10px]">
          <Field label={ut("cn.scale")} inline>
            <Select value={builder.from} onChange={(e) => setBuilder((b) => ({ ...b, from: e.target.value }))}>
              <option value="">{ut("cn.scale")}</option>
              {others.map((o) => (
                <option key={o.uid} value={o.code}>{scaleName(o.code)}</option>
              ))}
            </Select>
          </Field>
          <Field label={ut("cn.coefficient")} inline>
            <Input
              type="number"
              step="any"
              value={builder.coefficient}
              onChange={(e) => setBuilder((b) => ({ ...b, coefficient: e.target.value }))}
            />
          </Field>
        </div>

        {/* ── Результати: диапазоны балла (f30) ── */}
        <h3 className="m-0 mb-[8px] mt-[20px] text-[17px] font-bold text-primary">{ut("cn.results")}</h3>
        <Bands bands={s.bands} onChange={(bands) => onChange({ bands })} details={bandDetails} batteries={batteries} />
        <div className="mt-[8px]">
          <Toggle label={ut("cn.bandDetails")} value={bandDetails} onChange={setBandDetails} />
        </div>

        {/* ── психометрика: чего на кадре нет, а у встроенных методик есть ── */}
        <details className="group mt-[15px]">
          <summary className="cursor-pointer list-none text-[13px] font-bold text-primary [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span>
            {ut("cn.psychometrics")}
          </summary>
          <div className="grid gap-[10px] pt-[12px] sm:grid-cols-2">
            <Field label={ut("cs.code")} hint={ut("cn.codeHint")}>
              {/* без плейсхолдера: код выдаётся сам (newScale), пустым поле не бывает */}
              <Input value={s.code} onChange={(e) => onChange({ code: e.target.value })} />
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
                  <Select
                    value={s.validityDirection ?? "above"}
                    onChange={(e) => onChange({ validityDirection: e.target.value as "above" | "below" })}
                  >
                    <option value="above">{ut("co.aboveThreshold")}</option>
                    <option value="below">{ut("co.belowThreshold")}</option>
                  </Select>
                </Field>
              </>
            ) : null}
          </div>
          <p className="m-0 text-[13px] text-muted">{ut("cn.normsJsonHint")}</p>
        </details>

        <div className="mt-[15px] flex justify-end">
          <Button variant="danger" size="sm" onClick={onDelete}>{ut("cn.deleteScale")}</Button>
        </div>
      </div>
    </section>
  );
}

/**
 * Диапазоны результата: «від [0] до [10] [текст]» с «−» у строки и «+» у
 * последней — ровно кадр f30/f23. Один компонент на оба вида теста: в
 * конкретном он стоит в карточке шкалы, в комплексном — разделом «Результати»
 * над итоговой шкалой.
 *
 * Широкое поле — это label полосы, то, что видит специалист в результатах и
 * пациент в кабинете. Тяжесть, оценка, каскад, повторы и рекомендация — под
 * переключателем «Клінічні поля»: на кадре их нет, а тревоги и каскады
 * батарей ими живут.
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
  batteries: { id: string; title: string }[];
}) {
  const { ut } = useLang();
  const lang = useEditLang();
  const set = (k: number, patch: Partial<DraftBand>) => onChange(bands.map((b, i) => (i === k ? { ...b, ...patch } : b)));
  const add = () => {
    const last = bands[bands.length - 1];
    onChange([
      ...bands,
      {
        minScore: last ? last.maxScore + 1 : 0,
        maxScore: last ? last.maxScore + 10 : 10,
        label: { uk: "", ru: "" },
        severity: "none",
      },
    ]);
  };
  const addButton = (
    <Button size="glyph" variant="ghost" aria-label={ut("cn.addBand")} title={ut("cn.addBand")} onClick={add}>
      +
    </Button>
  );

  return (
    <div className="flex flex-col gap-[8px]">
      {bands.map((b, k) => {
        const last = k === bands.length - 1;
        const range = `${b.minScore}–${b.maxScore}`;
        return (
          <div key={k} className="flex flex-col gap-[6px]">
            <div className="flex items-center gap-[8px]">
              <span aria-hidden className="w-[26px] text-[13px] text-muted">{ut("cn.from")}</span>
              <Field label={`${ut("cn.from")} ${k + 1}`} inline className="w-[84px] shrink-0">
                <Input type="number" step="any" className="text-center font-bold" value={b.minScore} onChange={(e) => set(k, { minScore: Number(e.target.value) })} />
              </Field>
              <span aria-hidden className="text-[13px] text-muted">{ut("cn.to")}</span>
              <Field label={`${ut("cn.to")} ${k + 1}`} inline className="w-[84px] shrink-0">
                <Input type="number" step="any" className="text-center font-bold" value={b.maxScore} onChange={(e) => set(k, { maxScore: Number(e.target.value) })} />
              </Field>
              <Field label={`${ut("cn.resultText")} ${range}`} inline className="min-w-0 flex-1">
                <Input value={b.label[lang] ?? ""} onChange={(e) => set(k, { label: { ...b.label, [lang]: e.target.value } })} />
              </Field>
              <Button
                size="glyph"
                variant="ghost"
                aria-label={`${ut("cn.removeBand")} ${range}`}
                title={ut("cn.removeBand")}
                onClick={() => onChange(bands.filter((_, i) => i !== k))}
              >
                −
              </Button>
              {/* место под «+» держится и у непоследних строк: иначе поле текста последней строки было бы у́же соседних */}
              {last ? addButton : <span aria-hidden className="size-[27px] shrink-0" />}
            </div>
            {details ? (
              <div className="ml-[34px] grid gap-[8px] sm:grid-cols-[150px_84px_1fr_96px]">
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
                  <Select value={b.cascadeBatteryId ?? ""} onChange={(e) => set(k, { cascadeBatteryId: e.target.value || null })}>
                    <option value="">{ut("co.noCascade")}</option>
                    {batteries.map((bat) => (
                      <option key={bat.id} value={bat.id}>{bat.title}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={`${ut("cs.repeatDays")} ${range}`} hint={ut("cs.repeatHint")} inline>
                  <Input placeholder={ut("cn.repeatDaysExample")} value={b.followUpDays ?? ""} onChange={(e) => set(k, { followUpDays: e.target.value || null })} />
                </Field>
                <Field label={`${ut("cn.recommendation")} ${range}`} inline className="sm:col-span-4">
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
      {bands.length === 0 ? <div>{addButton}</div> : null}
    </div>
  );
}
