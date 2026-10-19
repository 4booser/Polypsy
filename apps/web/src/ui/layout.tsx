import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "./cx";
import { grouped } from "./decimal";
import { Ic } from "./icons";
import { useScreenLang } from "../lang";

/*
 * Рамка экрана в наборе «Виразна» (page_header + .main набора).
 *
 * Шапка: заголовок 28/800, за волосяной линией — мета-строка (жирная строка
 * и обычная), действия у правого края; под шапкой — одна строка пояснения и
 * полоса инструментов (вкладки, фильтры). Ниже — содержимое с полями 20.
 * Подробности выбранной строки — в ящике (Drawer) или в боковой колонке
 * (SideLayout): правой панели контекста у Page больше нет — ни один экран её
 * не взял, а на узком окне закрытую панель нечем было открыть снова.
 *
 * Прежние свойства, задававшие замеры старого макета (topGap, listGap,
 * headGap, pagerGap, titleSize, titleAlign), принимаются и ничего не меняют:
 * у набора один ритм на все экраны.
 *
 * Крючки рамки для оболочки (shell): Page заполняет выданную ей колонку и
 * прокручивает своё содержимое сам. Липкие заголовки таблиц внутри берут
 * отступ сверху из --sticky-top (по умолчанию 0: прокручивается область
 * Page); оболочка, которая прокручивает окно под липкой шапкой, ставит
 * --sticky-top: var(--ah).
 */

/** Мета-строка шапки: (жирная строка, обычная) или своя разметка */
export type PageMeta = [ReactNode, ReactNode] | ReactNode;

export function Page({
  title,
  meta,
  sub,
  lead,
  count,
  crumbs,
  back,
  actions,
  toolbar,
  below,
  bleed,
  tight,
  snug,
  titleHidden,
  children,
  className,
}: {
  title: ReactNode;
  /** За волосяной линией справа от заголовка: [«248 людей», «34 закріплені за вами»] */
  meta?: PageMeta;
  /** Одна строка пояснения под заголовком (12.5, text-2) */
  sub?: ReactNode;
  /** То же, что sub, — имя набора (page_header lead) */
  lead?: ReactNode;
  /** Число рядом с заголовком, вне h1: диктор не читает его как имя экрана */
  count?: number | null;
  crumbs?: ReactNode;
  /** Назад: шеврон перед заголовком — ссылка с подписью */
  back?: { to: string; label: string };
  actions?: ReactNode;
  /** Полоса под шапкой: фильтры, поиск, вкладки */
  toolbar?: ReactNode;
  /** То же место, что toolbar, — имя набора (page_header below) */
  below?: ReactNode;
  /** Экран сам раскладывает панели во всю высоту: без полей и без своей прокрутки */
  bleed?: boolean;
  /** Плотнее: шапка без нижнего отступа */
  tight?: boolean;
  snug?: boolean;
  /** Заголовок только для диктора: экран рисует своё имя сам */
  titleHidden?: boolean;
  children: ReactNode;
  className?: string;
  /** @deprecated замеры прежнего макета; ничего не меняют */
  titleAlign?: "start" | "center";
  /** @deprecated */
  titleSize?: 20 | 24;
  /** @deprecated */
  topGap?: 40 | 50;
  /** @deprecated */
  listGap?: 22 | 28;
  /** @deprecated */
  headGap?: 16 | 24;
  /** @deprecated */
  pagerGap?: 74 | 78 | 105;
}) {
  const lang = useScreenLang();
  const metaBlock =
    meta === undefined || meta === null ? null : Array.isArray(meta) && meta.length === 2 ? (
      <>
        <b className="font-extrabold text-text">{meta[0]}</b>
        <span>{meta[1]}</span>
      </>
    ) : (
      meta
    );
  const line = sub ?? lead;
  const strip = toolbar ?? below;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className={cx("shrink-0 px-5", bleed ? "pb-3 pt-4" : tight || snug ? "pt-4" : "pb-1 pt-4")}>
        {crumbs ? <div className="mb-1 flex items-center gap-1.5 text-small text-muted">{crumbs}</div> : null}
        {titleHidden ? (
          <>
            <h1 className="sr-only">{title}</h1>
            {/* заголовок спрятан, а действия — нет: конструктор держит здесь выбор языка текста */}
            {actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
          </>
        ) : (
          <div className="flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-2">
            {back ? (
              <Link
                to={back.to}
                aria-label={back.label}
                title={back.label}
                className={cx(
                  "-mr-1.5 inline-grid size-9 shrink-0 place-items-center rounded-control text-muted",
                  "hover:bg-sunk hover:text-text",
                )}
              >
                <Ic.chevronLeft size={18} />
              </Link>
            ) : null}
            <div className="flex min-w-0 items-baseline gap-2">
              <h1 className="m-0 text-page font-extrabold text-text">{title}</h1>
              {count !== undefined && count !== null ? (
                <span className="text-[22px] font-semibold tabular-nums tracking-[-0.02em] text-muted">{grouped(count, lang)}</span>
              ) : null}
            </div>
            {metaBlock ? (
              <div className="flex min-w-0 flex-col gap-px border-l border-border pl-4 text-[13px] leading-[18px] text-text-2">
                {metaBlock}
              </div>
            ) : null}
            {actions ? <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
          </div>
        )}
        {line ? <p className="m-0 mt-1 max-w-[80ch] text-small text-text-2">{line}</p> : null}
        {strip ? <div className={cx("min-w-0", titleHidden ? "pt-1" : "mt-3")}>{strip}</div> : null}
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/*
            Область содержимого прокручивается сама — значит должна принимать
            фокус: иначе её не пролистать стрелками и PageDown.
          */}
          <div
            tabIndex={bleed ? undefined : 0}
            className={cx(
              "min-h-0 flex-1 outline-none",
              bleed ? "overflow-hidden" : "overflow-y-auto overflow-x-hidden pb-8",
              className,
            )}
          >
            {bleed ? (
              children
            ) : (
              <div className="px-5 pt-3.5 [&>:is(nav,[role=tablist]):first-child]:mb-4">{children}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Тон квадрата значка в шапке панели (.phi набора) */
export type PanelTone = "violet" | "risk" | "warn" | "good" | "info" | "neutral";

const phiTone: Record<PanelTone, string> = {
  violet: "bg-violet-tint text-violet-ink",
  risk: "bg-risk-tint text-risk-ink",
  warn: "bg-warn-tint text-warn",
  good: "bg-good-tint text-good",
  info: "bg-info-tint text-info",
  neutral: "bg-sunk text-muted",
};

/** Квадрат значка 32 (скруглённый, «squircle» набора): шапка панели, строка хронологии */
export function IconTile({
  icon,
  tone = "violet",
  size = 32,
  className,
}: {
  icon: ReactNode;
  tone?: PanelTone;
  size?: 28 | 32 | 36 | 40 | 48;
  className?: string;
}) {
  /* где браузер умеет «сквиркл» (corner-shape), углы — сквирклом и радиусом крупнее, как в наборе */
  const box = {
    28: "size-7 rounded-[9px] supports-[corner-shape:squircle]:rounded-[12px] [&>svg]:size-[15px]",
    32: "size-8 rounded-control supports-[corner-shape:squircle]:rounded-[14px] [&>svg]:size-4",
    36: "size-9 rounded-[11px] supports-[corner-shape:squircle]:rounded-[14px] [&>svg]:size-4",
    40: "size-10 rounded-[12px] supports-[corner-shape:squircle]:rounded-[18px] [&>svg]:size-[17px]",
    48: "size-12 rounded-[15px] supports-[corner-shape:squircle]:rounded-[20px] [&>svg]:size-[22px]",
  }[size];
  return (
    <span
      aria-hidden
      className={cx(
        "grid shrink-0 place-items-center supports-[corner-shape:squircle]:[corner-shape:squircle]",
        box,
        phiTone[tone],
        className,
      )}
    >
      {icon}
    </span>
  );
}

/**
 * Панель набора: лист, радиус 14, обод в пиксель; шапка — квадрат значка 32,
 * заголовок 15.5/800, счётчик, приглушённая подпись и действия справа.
 *
 * `flush` — тело без полей (таблица, строки во всю ширину). `footer` —
 * строка под телом через волосяную линию. Обрезка — `overflow: clip`, а не
 * hidden: hidden делает панель прокручиваемой областью, и липкий заголовок
 * таблицы внутри перестаёт липнуть.
 */
export function Panel({
  title,
  icon,
  tone = "violet",
  sub,
  count,
  hint,
  actions,
  footer,
  children,
  flush,
  className,
  id,
  as: As = "section",
}: {
  title?: ReactNode;
  /** Значок в квадрате 32 перед заголовком */
  icon?: ReactNode;
  tone?: PanelTone;
  /** Приглушённая подпись после заголовка: «заміри 24.08, 11.09, 08.10» */
  sub?: ReactNode;
  count?: number | null;
  /** Строка пояснения под шапкой */
  hint?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  id?: string;
  as?: "section" | "div" | "article" | "aside";
}) {
  const auto = useId();
  const headId = title ? (id ? `${id}-h` : `${auto}-h`) : undefined;
  return (
    <As
      data-panel
      id={id}
      aria-labelledby={As === "section" || As === "aside" ? headId : undefined}
      className={cx("min-w-0 overflow-clip rounded-panel border border-border bg-panel shadow-panel", className)}
    >
      {title || actions ? (
        <div className="flex min-h-[60px] flex-wrap items-center gap-x-2.5 gap-y-1.5 py-3 pl-3.5 pr-3">
          {icon ? <IconTile icon={icon} tone={tone} /> : null}
          {title ? (
            <h2 id={headId} className="m-0 min-w-0 text-section font-extrabold text-text">
              {title}
            </h2>
          ) : null}
          {count !== undefined && count !== null ? <Count n={count} /> : null}
          {sub ? <span className="min-w-0 text-small text-muted">{sub}</span> : null}
          {actions ? <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div> : null}
        </div>
      ) : null}
      {hint ? <p className="m-0 -mt-1 max-w-[80ch] px-4 pb-3 text-small text-text-2">{hint}</p> : null}
      {flush ? children : <div className={cx("px-4 pb-4", title || actions ? "pt-1" : "pt-4")}>{children}</div>}
      {footer ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-divider px-4 pb-3.5 pt-3">{footer}</div>
      ) : null}
    </As>
  );
}

/** Пилюля-счётчик (.cnt набора): `risk` — только риск для человека; число — разрядами языка экрана */
export function Count({ n, tone = "plain", className }: { n: ReactNode; tone?: "plain" | "risk" | "violet" | "tint"; className?: string }) {
  const lang = useScreenLang();
  return (
    <span
      className={cx(
        "inline-grid h-5 min-w-5 shrink-0 place-items-center rounded-[10px] px-1.5 text-[11.5px] font-bold leading-none tabular-nums",
        tone === "risk"
          ? "bg-risk text-onfill"
          : tone === "violet"
            ? "bg-violet text-onfill"
            : tone === "tint"
              ? "bg-violet-tint text-violet-ink"
              : "bg-sunk text-text-2",
        className,
      )}
    >
      {typeof n === "number" ? grouped(n, lang) : n}
    </span>
  );
}

/** Сетка панелей: колонки не уже `min`, сколько поместится */
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
      className={cx("grid items-start gap-4", className)}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))` }}
    >
      {children}
    </div>
  );
}

export function Stack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("flex min-w-0 flex-col gap-4", className)}>{children}</div>;
}

/**
 * Главная колонка и боковая (.gside набора): содержимое и колонка 440 (или
 * 360 при `narrow`), которая липнет при прокрутке. На 1280 боковая 360 —
 * чтобы главной оставалось не меньше 600.
 */
export function SideLayout({
  children,
  side,
  narrow,
  className,
}: {
  children: ReactNode;
  side: ReactNode;
  narrow?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "grid items-start gap-5",
        narrow
          ? "grid-cols-[minmax(0,1fr)_360px]"
          : "grid-cols-[minmax(0,1fr)_440px] max-[1360px]:grid-cols-[minmax(0,1fr)_360px]",
        "max-[1080px]:grid-cols-1",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
      <div className="sticky top-[calc(var(--sticky-top,0px)+16px)] flex min-w-0 flex-col gap-4 max-[1080px]:static">{side}</div>
    </div>
  );
}
