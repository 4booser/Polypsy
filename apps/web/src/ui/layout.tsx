import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { cx } from "./cx";
import { SectionLabel } from "./primitives";

/*
 * Рамка экрана.
 *
 * Прежде каждый экран сам решал, где у него заголовок, где фильтры и сколько
 * до них отступ, — и решал по-разному. Разница в шесть пикселей между
 * страницами не бросается в глаза по одной, но при переходах создаёт
 * ощущение, что экраны собраны из разных приложений.
 *
 * Здесь три решения, которые экономят время каждый день:
 *
 * 1. Прокручивается содержимое, а не страница. Заголовок и полоса фильтров
 *    остаются на месте: на списке из восьми тысяч человек фильтр, уехавший
 *    вверх, означает прокрутку туда и обратно на каждое изменение.
 * 2. Справа — панель контекста. Кто этот человек, видно не уходя с экрана:
 *    раньше за этим приходилось переходить в карту и возвращаться назад,
 *    теряя место в списке и набранные фильтры.
 * 3. Заголовок несёт число. «Пациенты» и «Пациенты · 8189» отвечают на
 *    разные вопросы, и второй чаще.
 */

interface PageCtx {
  contextOpen: boolean;
  setContextOpen: (v: boolean) => void;
}
const Ctx = createContext<PageCtx>({ contextOpen: true, setContextOpen: () => {} });
export const usePageContext = () => useContext(Ctx);

export function Page({
  title,
  sub,
  count,
  crumbs,
  actions,
  toolbar,
  context,
  contextTitle,
  children,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  /** Число в заголовке: сколько всего строк, людей, случаев. */
  count?: number | null;
  crumbs?: ReactNode;
  actions?: ReactNode;
  /** Полоса фильтров: прибита под заголовком и не уезжает при прокрутке. */
  toolbar?: ReactNode;
  /** Панель справа. Если её нет, содержимое занимает всю ширину. */
  context?: ReactNode;
  contextTitle?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [contextOpen, setContextOpen] = useState(true);

  // на узком экране панель контекста не помещается рядом — она закрыта
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1180px)");
    const apply = () => setContextOpen(!mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  return (
    <Ctx.Provider value={{ contextOpen, setContextOpen }}>
      {/*
        Абсолютное растягивание — приём на время переноса: рабочая область
        сохраняет прежние поля для ещё не перенесённых экранов, а этот
        занимает её целиком и заводит собственную прокрутку. Когда наследия
        не останется, поля уйдут из .main, а отсюда — absolute.
      */}
      <div className="absolute inset-0 flex min-h-0 flex-col">
        <header className="shrink-0 px-7 pb-4 pt-6 max-[900px]:px-4 max-[900px]:pt-4">
          {crumbs ? <div className="mb-1.5 flex items-center gap-1.5 text-caption text-muted">{crumbs}</div> : null}
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="min-w-0">
              <h1 className="m-0 flex items-baseline gap-2.5 font-display text-page font-semibold leading-tight tracking-[-0.022em]">
                <span className="text-balance">{title}</span>
                {count !== undefined && count !== null ? (
                  <span className="font-mono text-section font-normal tabular-nums text-faint">{count}</span>
                ) : null}
              </h1>
              {sub ? <p className="m-0 mt-1 max-w-[70ch] text-small text-muted">{sub}</p> : null}
            </div>
            {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {toolbar ? (
              <div
                className={cx(
                  "sticky top-0 z-20 shrink-0 border-y border-hairline px-7 py-2 max-[900px]:px-4",
                  "bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] backdrop-blur-md",
                )}
              >
                {toolbar}
              </div>
            ) : null}
            <div
              className={cx(
                "min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-7 pb-24 pt-4 max-[900px]:px-4",
                className,
              )}
            >
              {children}
            </div>
          </div>

          {context && contextOpen ? (
            <aside
              className={cx(
                "flex w-[336px] shrink-0 flex-col overflow-y-auto border-l border-hairline bg-surface",
                "max-[1180px]:fixed max-[1180px]:inset-y-0 max-[1180px]:right-0 max-[1180px]:z-40 max-[1180px]:shadow-pop",
              )}
            >
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-4 py-3">
                <SectionLabel>{contextTitle}</SectionLabel>
                <button
                  type="button"
                  onClick={() => setContextOpen(false)}
                  aria-label="Закрыть панель"
                  className="min-h-0 rounded-sm border-0 bg-transparent p-1 text-faint hover:text-text"
                >
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8}>
                    <path d="m6 6 12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>
              <div className="flex-1 p-4">{context}</div>
            </aside>
          ) : null}
        </div>
      </div>
    </Ctx.Provider>
  );
}

/* ─────────── плоскости ─────────── */

/**
 * Панель — плоскость на земле.
 *
 * Земля теперь самое тёмное, что есть на экране, поэтому панель отделяется
 * собственной светлотой, а не рамкой. Рамка осталась только там, где две
 * панели соприкасаются вплотную и просвет между ними не читается.
 */
export function Panel({
  title,
  hint,
  actions,
  children,
  flush,
  className,
  as: As = "section",
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Без внутренних отступов: для таблиц во всю ширину панели. */
  flush?: boolean;
  className?: string;
  as?: "section" | "div" | "article" | "aside";
}) {
  return (
    <As className={cx("overflow-hidden rounded-lg bg-surface", className)}>
      {title || actions ? (
        <div
          className={cx(
            "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pt-4",
            hint ? "pb-2" : "pb-3",
          )}
        >
          <h2 className="m-0 font-display text-section font-medium leading-tight tracking-[-0.008em]">{title}</h2>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {hint ? <p className="m-0 max-w-[68ch] px-5 pb-3 text-caption leading-normal text-muted">{hint}</p> : null}
      <div className={flush ? "" : "px-5 pb-5"}>{children}</div>
    </As>
  );
}

/** Сетка панелей. Колонки задаются минимальной шириной, а не числом. */
export function Grid({
  min = 320,
  children,
  className,
}: {
  min?: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx("grid gap-4", className)}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))` }}
    >
      {children}
    </div>
  );
}

/** Вертикальная стопка панелей с общим ритмом. */
export function Stack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("flex flex-col gap-4", className)}>{children}</div>;
}
