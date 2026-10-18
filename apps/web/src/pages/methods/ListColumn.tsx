import { useRef, type ReactNode } from "react";
import { useLang } from "../../lang";
import { cx } from "../../ui/cx";
import { SearchField, ViewPills, type ViewItem } from "../../ui/filters";
import { Ic } from "../../ui/icons";
import { KbdHints } from "../../ui/kbd";
import { useHotkeys } from "../../ui/keys";
import { Count } from "../../ui/layout";
import { Tooltip } from "../../ui/Popover";
import { Mi } from "./icons";

/*
 * Колонка списка для «списку й запису» (ui.list_column набора): 340 px слева
 * от записи, своя прокрутка, шапка с поиском («/»), видами и порядком,
 * группы и плитки, подвал с клавишами и счётом. «[» сворачивает колонку,
 * J/K ведут по строкам (по ссылкам [data-row] в колонке, в порядке экрана).
 *
 * Набора такой колонки ещё нет (ui/records.tsx даёт плитку и заголовок
 * группы, но не саму колонку), поэтому она здесь — у наборов и групп
 * методик одна и та же.
 */
export function ListColumn({
  title,
  count,
  actions,
  search,
  views,
  sortNote,
  footCount,
  collapsed,
  onCollapse,
  onStep,
  children,
}: {
  title: string;
  count: number;
  /** Значковые кнопки в шапке: «Зібрати набір», «Нова група» */
  actions?: ReactNode;
  search: { value: string; onChange: (v: string) => void; placeholder: string };
  views?: { items: ViewItem[]; value: string; onChange: (key: string) => void };
  /** Строка порядка под видами */
  sortNote?: ReactNode;
  /** «8 з 8» в подвале */
  footCount?: ReactNode;
  collapsed: boolean;
  onCollapse: (v: boolean) => void;
  /** J/K: шаг по строкам; экран сам решает, что значит «следующая» */
  onStep?: (step: 1 | -1) => void;
  children: ReactNode;
}) {
  const { ut } = useLang();
  const box = useRef<HTMLDivElement>(null);
  useHotkeys(
    {
      "[": () => onCollapse(!collapsed),
      j: () => onStep?.(1),
      k: () => onStep?.(-1),
    },
    true,
  );

  if (collapsed) {
    return (
      <div className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-panel pt-3 max-[900px]:hidden">
        <Tooltip label={ut("mc.listExpand")} kbd="[" side="right">
          <button
            type="button"
            onClick={() => onCollapse(false)}
            aria-label={ut("mc.listExpand")}
            className="inline-grid size-9 min-h-0 cursor-pointer place-items-center rounded-control border-0 bg-transparent p-0 text-muted hover:bg-sunk hover:text-text"
          >
            <Mi.panelLeftOpen size={17} />
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <aside
      aria-label={title}
      className={cx(
        "flex w-[340px] shrink-0 flex-col border-r border-border bg-panel max-[1366px]:w-[300px]",
        "max-[900px]:max-h-[45vh] max-[900px]:w-full max-[900px]:border-b max-[900px]:border-r-0",
      )}
    >
      <div className="shrink-0 px-4 pb-2.5 pt-4">
        <div className="flex h-9 items-center gap-2">
          <h2 className="m-0 truncate text-[18px] font-extrabold leading-none tracking-[-0.02em] text-text">{title}</h2>
          <Count n={count} />
          <span className="ml-auto flex items-center gap-1">
            {actions}
            <Tooltip label={ut("mc.listCollapse")} kbd="[" side="bottom" align="end">
              <button
                type="button"
                onClick={() => onCollapse(true)}
                aria-label={ut("mc.listCollapse")}
                className="inline-grid size-8 min-h-0 cursor-pointer place-items-center rounded-control border-0 bg-transparent p-0 text-muted hover:bg-sunk hover:text-text max-[900px]:hidden"
              >
                <Mi.panelLeftClose size={16} />
              </button>
            </Tooltip>
          </span>
        </div>
        <SearchField
          value={search.value}
          onChange={search.onChange}
          placeholder={search.placeholder}
          slash
          width={0}
          className="mt-3 w-full"
        />
        {views ? <ViewPills items={views.items} value={views.value} onChange={views.onChange} className="mt-2.5" /> : null}
        {sortNote ? (
          <div className="mt-2.5 flex items-center gap-1.5 text-caption text-muted">
            <Ic.sortDesc size={14} />
            <span className="min-w-0 truncate">{sortNote}</span>
          </div>
        ) : null}
      </div>
      <div ref={box} role="list" className="kit-scroll min-h-0 flex-1 overflow-y-auto border-t border-divider pb-3 pt-1">
        {children}
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-divider px-4 py-2.5">
        <KbdHints
          keys={[
            ["J K", ut("mc.keyRows")],
            ["/", ut("mc.keySearch")],
            ["[", ut("mc.keyCollapse")],
          ]}
        />
        {footCount ? <span className="ml-auto whitespace-nowrap text-caption font-bold text-text-2">{footCount}</span> : null}
      </div>
    </aside>
  );
}

/** Пустой список в колонке — одна фраза о том, что сделать */
export function ListEmpty({ children }: { children: ReactNode }) {
  return <p className="m-0 px-5 py-6 text-small text-muted">{children}</p>;
}

/**
 * Обёртка «список + запись»: колонка слева, запись справа во всю высоту.
 * Ниже 900 px — друг под другом (колонка сверху, своей прокруткой).
 */
export function ListAndRecord({ list, children }: { list: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 max-[900px]:flex-col">
      {list}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
