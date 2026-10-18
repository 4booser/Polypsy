import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { useLang } from "../../lang";
import { ShellIcon } from "../../shell/icons";
import { Ic } from "../../ui";
import { cx } from "../../ui/cx";
import { Count } from "../../ui/layout";
import { Button } from "../../ui/primitives";
import { useEditLang } from "./fields";
import { CnIc } from "./icons";
import { isCritical, type Section } from "./Questions";
import type { Draft } from "./model";

/**
 * Колонка «Структура» (левая колонка макета methods-constructor): разделы
 * методики и список пунктов.
 *
 * Разделы переключают середину экрана, а не листают её: у методики на двести
 * пунктов «Основне» и «Питання» на одном свитке разошлись бы на десятки
 * экранов. Пункты списка перетаскиваются — порядок меняется вместе с ключом
 * (model.ts, reorderQuestion); с клавиатуры тот же сдвиг — Alt+↑/↓ на строке.
 */
export function Structure({
  draft,
  section,
  onSection,
  open,
  onOpen,
  onReorder,
  onMove,
  warnSections,
  warnItems,
  onAdd,
  onPaste,
}: {
  draft: Draft;
  section: Section;
  onSection: (s: Section) => void;
  open: string | null;
  /** Открыть пункт в середине */
  onOpen: (index: number) => void;
  /** Перетащить пункт с места на место (с нуля) */
  onReorder: (from: number, to: number) => void;
  /** Сдвинуть пункт на соседнее место */
  onMove: (index: number, delta: number) => void;
  /** Разделы с замечаниями проверки структуры — точкой янтаря */
  warnSections: Set<Section>;
  warnItems: Set<number>;
  onAdd: () => void;
  onPaste: () => void;
}) {
  const { ut } = useLang();
  const lang = useEditLang();
  const complex = (draft.mode ?? "specific") === "complex";
  const [drag, setDrag] = useState<{ from: number; over: number | null } | null>(null);
  const bands = draft.scales.reduce((n, s) => n + s.bands.length, 0);

  const items: { key: Section; label: string; icon: ReactNode; count?: number }[] = [
    { key: "main", label: ut("ce.main"), icon: <ShellIcon name="file-text" /> },
    { key: "settings", label: ut("ce.settings"), icon: <CnIc.settings /> },
    { key: "questions", label: ut("co.questions"), icon: <CnIc.listOrdered />, count: draft.questions.length },
    ...(complex
      ? []
      : [
          { key: "answers" as const, label: ut("cn.answers"), icon: <Ic.list />, count: draft.answers?.length ?? 0 },
          { key: "scales" as const, label: ut("ce.scales"), icon: <ShellIcon name="sigma" />, count: draft.scales.length },
        ]),
    { key: "bands", label: complex ? ut("cn.results") : ut("ce.bands"), icon: <ShellIcon name="ruler" />, count: bands },
    { key: "json", label: ut("cn.jsonSection"), icon: <ShellIcon name="braces" /> },
  ];

  const dropAt = (e: DragEvent, i: number) => {
    e.preventDefault();
    if (drag && drag.from !== i) onReorder(drag.from, i);
    setDrag(null);
  };

  const onRowKey = (e: KeyboardEvent, i: number) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const delta = e.key === "ArrowUp" ? -1 : 1;
    onMove(i, delta);
    /* фокус идёт за строкой: следующий Alt+↑ двигает тот же пункт */
    const list = e.currentTarget.closest("ol");
    requestAnimationFrame(() => list?.querySelectorAll<HTMLElement>("[data-item]")[i + delta]?.focus());
  };

  return (
    <aside
      aria-label={ut("ce.structure")}
      className={cx(
        "sticky top-3 flex max-h-[calc(100vh-var(--ah,56px)-150px)] min-w-0 flex-col rounded-panel border border-border bg-panel p-2 shadow-panel",
        "max-[900px]:static max-[900px]:max-h-none",
      )}
    >
      <nav aria-label={ut("ce.sections")} className="flex shrink-0 flex-col gap-0.5">
        {items.map((it) => {
          const on = section === it.key;
          return (
            <button
              key={it.key}
              type="button"
              aria-current={on ? "true" : undefined}
              onClick={() => onSection(it.key)}
              className={cx(
                "flex h-9 min-h-0 w-full cursor-pointer items-center gap-2.5 rounded-control border-0 px-2.5 text-left text-body",
                "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-ring",
                on
                  ? "bg-violet-tint font-extrabold text-violet-ink shadow-[inset_0_0_0_1px_var(--vline)]"
                  : "bg-transparent font-semibold text-text-2 hover:bg-sunk hover:text-text",
              )}
            >
              <span className={cx("inline-flex", on ? "text-violet-ink" : "text-muted")}>{it.icon}</span>
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {warnSections.has(it.key) ? (
                <i aria-label={ut("ce.hasIssues")} role="img" className="size-[7px] shrink-0 rounded-full bg-warn" />
              ) : null}
              {it.count !== undefined ? <Count n={it.count} tone={on ? "tint" : "plain"} /> : null}
            </button>
          );
        })}
      </nav>

      {draft.questions.length ? (
        <>
          <div id="cn-items-h" className="shrink-0 px-2.5 pb-1.5 pt-3 text-caption font-bold text-muted">
            {ut("ce.dragHint")}
          </div>
          <ol className="kit-scroll m-0 min-h-0 flex-1 list-none overflow-y-auto p-0" aria-labelledby="cn-items-h">
            {draft.questions.map((q, i) => {
              const on = open === q.uid && section === "questions";
              const label = q.help?.[lang] || q.title[lang] || q.title.uk || q.title.ru || ut("co.previewNoText");
              const over = drag && drag.over === i && drag.from !== i;
              return (
                <li key={q.uid}>
                  <button
                    type="button"
                    data-item
                    draggable
                    aria-current={on ? "true" : undefined}
                    aria-label={`${i + 1}. ${label}`}
                    aria-description={ut("ce.dragKeys")}
                    onClick={() => onOpen(i)}
                    onKeyDown={(e) => onRowKey(e, i)}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", String(i));
                      setDrag({ from: i, over: null });
                    }}
                    onDragOver={(e) => {
                      if (!drag) return;
                      e.preventDefault();
                      if (drag.over !== i) setDrag({ ...drag, over: i });
                    }}
                    onDrop={(e) => dropAt(e, i)}
                    onDragEnd={() => setDrag(null)}
                    className={cx(
                      "group flex h-8 min-h-0 w-full cursor-grab items-center gap-1.5 rounded-[9px] border-0 pl-1 pr-2 text-left text-[13px] font-semibold",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-ring",
                      on
                        ? "bg-violet-tint font-extrabold text-violet-ink shadow-[inset_0_0_0_1px_var(--vline)]"
                        : "bg-transparent text-text-2 hover:bg-sunk",
                      over && (drag!.from < i ? "shadow-[inset_0_-2px_0_var(--v)]" : "shadow-[inset_0_2px_0_var(--v)]"),
                      drag?.from === i && "opacity-50",
                    )}
                  >
                    <CnIc.grip size={14} className="text-control" />
                    <span className={cx("w-[22px] shrink-0 text-caption font-extrabold tabular-nums", on ? "text-violet-ink" : "text-muted")}>
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {isCritical(q) ? <CnIc.siren size={13} className="shrink-0 text-risk-ink" /> : null}
                    {warnItems.has(i + 1) ? <i aria-hidden className="size-[7px] shrink-0 rounded-full bg-warn" /> : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}

      <div className="mt-3 flex shrink-0 flex-col gap-1.5">
        <Button size="xs" icon={<Ic.plus />} className="w-full" onClick={onAdd}>
          {ut("cq.addQuestion")}
        </Button>
        <Button variant="ghost" size="xs" icon={<CnIc.paste />} className="w-full" onClick={onPaste}>
          {ut("co.bulkPaste")}
        </Button>
      </div>
    </aside>
  );
}
