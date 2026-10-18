import { useEffect, useId, useState, type ReactNode } from "react";
import { api, openInTab, type ConclusionState } from "../api";
import { cx } from "../ui/cx";
import { day, timeOfDay } from "../format";
import { Callout, Ic, useAction, useToast } from "../ui";
import { IconTile } from "../ui/layout";
import { ActionMenu } from "../ui/menu";
import { useLang } from "../lang";
import { Button, Field, Input, Tag, Textarea } from "../ui/primitives";
import { Rx } from "../pages/response/icons";
import { TemplateMenus } from "./TemplatePicker";
import { draftOf, draftSavable, saveThenSign, signPlan, staleMessage } from "./versioned";

/**
 * Редактор заключения по прохождению — лист во всю колонку (Polypsy 2.0,
 * кадр methods-conclusion): шапка документа с состоянием и версией, полоса
 * инструментов (собрать из результатов, шаблоны, формулировки), название,
 * сводка результата, вывод, сигналы прохождения, строка о версиях и подпись.
 *
 * Подпись идёт по правилам сервера: завершённое прохождение, сохранённая
 * редакция, сверка версии и редакции (409 — «перечитати»). Сверху экран
 * держит своё правило: пока не разобран сигнал, поднятый этим же
 * прохождением, подписать нельзя (`lock`), — черновик писать и сохранять
 * можно.
 */
export interface SignLock {
  /** Заголовок заметки над текстом: «Підписати можна після розбору сигналу» */
  title: ReactNode;
  /** Что за сигнал и сколько он висит */
  body: ReactNode;
  /** «Розібрати сигнал» — переход к разбору */
  action: ReactNode;
}

export function ConclusionEditor({
  responseId,
  state,
  error,
  onState,
  onReload,
  title,
  setTitle,
  text,
  setText,
  areaRef,
  heading,
  summary,
  signals,
  lock,
  onHistory,
  canWrite = true,
  canSign = true,
}: {
  responseId: string;
  state: ConclusionState | null;
  error: string | null;
  onState: (next: ConclusionState) => void;
  onReload: () => void;
  title: string;
  /** Название — своё поле экрана; без него поле не рисуется */
  setTitle?: (next: string) => void;
  text: string;
  setText: (next: string) => void;
  areaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Подпись документа в шапке: «PHQ-9 від 8 жовт., 14:12» */
  heading?: ReactNode;
  /** Сводка результата над выводом */
  summary?: ReactNode;
  /** Сигналы этого прохождения — разделом под выводом */
  signals?: ReactNode;
  lock?: SignLock | null;
  /** «Історія» — к истории версий */
  onHistory?: () => void;
  /** Права читающего: писать черновик (conclusions.write) и подписывать (conclusions.sign) */
  canWrite?: boolean;
  canSign?: boolean;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const toast = useToast();
  const [stale, setStale] = useState<string | null>(null);
  /* отказ 409 прежнего прохождения к новому не переходит — сброс до раннего возврата, порядок хуков постоянен */
  useEffect(() => setStale(null), [responseId]);
  const why = ut("fmt.unavailable");
  const whyId = useId();
  const textId = "cn-text";

  const draft = state ? draftOf(state) : null;
  const saveDraft = () =>
    run(async () => {
      if (!state || !draftSavable(text)) return false;
      onState(await api.saveConclusion(responseId, text, state.current, title));
    }, ut("cn.draftSaved"));

  /* ⌘S / Ctrl+S — сохранить черновик, не уходя с поля */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      if (!busy) void saveDraft();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!state) {
    return error ? (
      <p className="m-0 text-small text-muted">
        {ut("cn.loadFailed")}: {error}
      </p>
    ) : (
      <p className="m-0 text-small text-muted">{ut("common.loading")}</p>
    );
  }
  const signed = state.versions.find((v) => v.status === "signed");
  const save = () => api.saveConclusion(responseId, text, state.current, title);
  const plan = signPlan(text, draft);
  const dirty = draft ? text !== draft.text : text.trim().length > 0;
  const status = draft ? (
    <Tag icon={<Rx.filePen />}>{ut("cnx.draftV").replace("{n}", String(draft.version))}</Tag>
  ) : signed ? (
    <Tag tone="good" icon={<Ic.check />}>
      {ut("cnx.signedV").replace("{n}", String(state.current!.version))}
    </Tag>
  ) : (
    <Tag>{ut("cnx.new")}</Tag>
  );

  const sign = () =>
    run(async () => {
      try {
        await saveThenSign(state, plan, {
          save,
          sign: (seen) => api.signConclusion(responseId, seen),
          apply: onState,
        });
        setText("");
        setStale(null);
      } catch (e) {
        const message = staleMessage(e);
        if (message === null) throw e;
        setStale(message);
        return false;
      }
    }, ut("cn.signed"));

  return (
    <section aria-labelledby="cn-verdicts" className="min-w-0 overflow-clip rounded-panel border border-border bg-panel shadow-panel">
      <div className="flex min-h-[60px] flex-wrap items-center gap-x-2.5 gap-y-1.5 py-3 pl-3.5 pr-3">
        <IconTile icon={<Rx.filePen />} />
        <h2 id="cn-verdicts" className="m-0 text-section font-extrabold text-text">
          {ut("rp.conclusion")}
        </h2>
        {heading ? <span className="min-w-0 text-small text-muted">{heading}</span> : null}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {status}
          <Button
            size="icon-sm"
            variant="quiet"
            icon={<Rx.fileDown />}
            aria-label={ut("cn3.savePdf")}
            title={ut("cn3.savePdf")}
            disabled={busy}
            onClick={() => void run(() => openInTab(api.reportUrl(responseId)))}
          />
          <ActionMenu
            label={ut("cn3.actions")}
            triggerSize="icon-sm"
            entries={[
              { key: "pdf", label: ut("cn3.savePdf"), icon: <Rx.fileDown />, onSelect: () => void run(() => openInTab(api.reportUrl(responseId))) },
              { key: "mail", label: ut("cn3.sendMail"), icon: <Ic.message />, onSelect: () => toast(ut("cn3.mailUnavailable"), "info") },
            ]}
          />
        </div>
      </div>

      {lock && !signed ? (
        <div className="px-4 pb-3.5">
          <Callout kind="risk" icon={<Ic.lock />} title={lock.title} actions={lock.action}>
            {lock.body}
          </Callout>
        </div>
      ) : null}

      <div role="toolbar" aria-label={ut("cnx.tools")} className="flex flex-wrap items-center gap-1.5 border-y border-divider bg-panel-2 px-4 py-2.5">
        <Button
          size="xs"
          icon={<Rx.wand />}
          disabled={busy || !canWrite}
          title={ut("cnx.fromResultsHint")}
          onClick={() =>
            void run(async () => {
              if (text.trim() && !window.confirm(ut("cn.draftReplaced"))) return false;
              setText(await buildDraft(responseId, ut as unknown as (k: never) => string));
            })
          }
        >
          {ut("cn.fromResults")}
        </Button>
        <TemplateMenus
          kind="conclusion"
          value={text}
          onChange={setText}
          textareaRef={areaRef}
          templateIcon={<Rx.template />}
          phraseIcon={<Rx.quote />}
          disabled={!canWrite}
        />
        <span aria-hidden className="mx-1 h-[22px] w-px bg-divider" />
        {/*
          Форматирования нет: сервер хранит заключение простым текстом. Кнопки
          выключены, а причина — на обёртке (выключенной кнопке браузер не
          доставляет наведение) и для диктора — через aria-describedby.
        */}
        <span title={why} className="inline-flex gap-0.5 opacity-60" aria-describedby={whyId}>
          <button type="button" disabled aria-label={ut("fmt.bold")} className="grid size-8 place-items-center rounded-[9px] border-0 bg-transparent text-text-2">
            <Rx.bold size={15} />
          </button>
          <button type="button" disabled aria-label={ut("fmt.italic")} className="grid size-8 place-items-center rounded-[9px] border-0 bg-transparent text-text-2">
            <Rx.italic size={15} />
          </button>
          <button type="button" disabled aria-label={ut("cnx.fmtList")} className="grid size-8 place-items-center rounded-[9px] border-0 bg-transparent text-text-2">
            <Rx.bullets size={15} />
          </button>
        </span>
        <p id={whyId} className="sr-only">
          {why}
        </p>
        <span className="ml-auto inline-flex items-center gap-1.5 text-caption text-muted">
          {draft && !dirty ? (
            <>
              <Ic.cloudCheck size={13} />
              {ut("cnx.savedAt").replace("{t}", timeOfDay(draft.createdAt))}
            </>
          ) : dirty ? (
            <>
              <Ic.cloudOff size={13} />
              {ut("cnx.unsaved")}
            </>
          ) : null}
        </span>
      </div>

      <div className="flex flex-col gap-4 px-4 pb-4 pt-4">
        {setTitle ? (
          <Field label={ut("cnx.name")}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </Field>
        ) : null}
        {summary}
        {signed && !draft ? (
          <div className="rounded-[12px] bg-good-tint px-3.5 py-3">
            <p className="m-0 whitespace-pre-wrap text-body text-text">{state.current!.text}</p>
            <p className="m-0 mt-1.5 text-caption text-text-2">
              {ut("cnc.signedBy")} {state.current!.authorName}, {day(state.current!.signedAt!)}. {ut("cnc.editCreatesVersion")}
            </p>
          </div>
        ) : null}
        <div>
          <label htmlFor={textId} className="mb-1.5 block text-caption font-bold text-text-2">
            {ut("cnx.verdict")}
          </label>
          <Textarea
            ref={areaRef}
            id={textId}
            rows={7}
            value={text}
            readOnly={!canWrite}
            onChange={(e) => setText(e.target.value)}
            placeholder={signed ? ut("cn.newOverSigned") : ut("cn.placeholder")}
          />
        </div>
        {signals}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-divider px-4 py-2.5 text-caption text-muted">
        <span>{ut("cnx.chars").replace("{n}", String(text.trim().length))}</span>
        <span>{ut("cnc.editCreatesVersion")}</span>
        {onHistory && state.versions.length ? (
          <Button size="xs" variant="ghost" icon={<Ic.history />} className="ml-auto" onClick={onHistory}>
            {ut("cnc.showHistory")}
          </Button>
        ) : null}
      </div>

      {stale ? (
        <div className="px-4 pb-3">
          <Callout kind="warn" role="alert" title={stale} actions={
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setStale(null);
                onReload();
              }}
            >
              {ut("integrity.reread")}
            </Button>
          }>
            {ut("integrity.rereadHint")}
          </Callout>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2.5 border-t border-divider px-4 pb-4 pt-3">
        <span className={cx("inline-flex min-w-0 items-center gap-1.5 text-small", lock && !signed ? "text-text-2" : "text-muted")}>
          {lock && !signed ? <Ic.lock size={14} className="shrink-0 text-risk-ink" /> : <Ic.info size={14} className="shrink-0" />}
          {lock && !signed ? ut("rp.signLocked") : !canSign ? ut("cnx.noSignRight") : ut("cnc.onlySignedInReport")}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon={<Rx.signature />}
            disabled={busy || !plan.canSign || !!lock || !canSign}
            onClick={() => void sign()}
          >
            {ut("cn3.form")}
          </Button>
          <Button icon={<Rx.save />} disabled={busy || !canWrite || !draftSavable(text)} title={ut("cnx.saveHint")} onClick={() => void saveDraft()}>
            {ut("cnc.saveDraft")}
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * Черновик заключения из результатов прохождения.
 *
 * Собирается здесь, на языке интерфейса, из фактов, которые отдаёт сервер:
 * сервер не знает, на каком языке читает специалист, и готовый абзац с его
 * стороны был бы на чужом языке. Не сохраняется сам — сохранит тот, кто с ним
 * согласился.
 */
export async function buildDraft(responseId: string, ut: (k: never) => string): Promise<string> {
  const t = (k: string) => ut(k as never);
  const d = await api.conclusionDraft(responseId);
  const lines: string[] = [];
  if (d.patient) {
    const age = d.patient.age !== null ? `, ${d.patient.age} ${t("cn.draftAge")}` : "";
    const unit = d.patient.unit ? `, ${d.patient.unit}` : "";
    lines.push(`${t("cn.draftHeader")}: ${d.patient.fullName}${age}${unit}`);
  }
  lines.push(`${t("cn.draftMethod")}: ${d.surveyTitle}`);
  if (d.submittedAt) lines.push(`${t("cn.draftDate")}: ${day(d.submittedAt)}`);
  if (d.scales.length) {
    lines.push("", `${t("cn.draftScales")}:`);
    for (const s of d.scales) {
      const shown = s.normalization === "ratio" ? `${Math.round(s.percent)} %` : String(Math.round(s.value * 10) / 10);
      const band = s.band ? ` — ${s.band}` : "";
      const before =
        s.previousValue !== null
          ? ` (${t("cn.draftWas")} ${
              s.normalization === "ratio" ? `${Math.round(s.previousValue * 100)} %` : Math.round(s.previousValue * 10) / 10
            }${d.previousAt ? `, ${day(d.previousAt)}` : ""})`
          : "";
      lines.push(`· ${s.title}: ${shown}${band}${before}`);
    }
  }
  lines.push("", t("cn.draftConclusionHere"));
  return lines.join("\n");
}
