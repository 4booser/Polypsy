import { createContext, useContext, useId, type ReactNode, type Ref } from "react";
import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { Loading } from "../ui";
import { Count, IconTile, type PanelTone } from "../ui/layout";
import type { Resource } from "../useResource";
import { cx } from "../ui/cx";

/**
 * Общие части экранов кабинета (patient_web «Виразної»).
 *
 * Регистр пациента, а не консоли: основной текст 16, заголовок панели 18,
 * мишени от 44, одна задача на экран. Набор (ui/*) нарисован для плотной
 * консоли — 13.5 и 40, — поэтому панель и полоса заголовка здесь свои, на
 * тех же токенах и с тем же квадратом значка 32: кабинет должен выглядеть
 * частью того же приложения, только спокойнее и крупнее.
 */

/** Ширина колонки кабинета: 1120 содержимого и поля по 16 (рамка — PatientApp.tsx) */
export const COLUMN = "mx-auto w-full max-w-[1152px] px-4";

/* ─────────── «Допомога» из любого места экрана ─────────── */

const HelpContext = createContext<() => void>(() => {});

/** Рамка кабинета отдаёт сюда открытие ящика «Допомога» (PatientFrame) */
export const HelpProvider = HelpContext.Provider;

/** Открыть «Допомогу» — ящик с номерами, тот же, что у кнопки в шапке */
export function useHelp(): () => void {
  return useContext(HelpContext);
}

/* ─────────── полоса заголовка ─────────── */

/**
 * Заголовок экрана на сиреневой полосе (pt-hero): крупный заголовок,
 * строка пояснения, под ними — своё (полоса открытого, заметка), справа —
 * карточка главного (ближайший приём, перенос). Полоса продолжает шапку
 * кабинета и заканчивается линией: дальше — земля и панели.
 *
 * `notice` — строка над заголовком (работы на сервере, новая редакция
 * согласия): то, что человек должен узнать раньше всего остального.
 */
export function Hero({
  title,
  lead,
  children,
  aside,
  notice,
  headingRef,
}: {
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  aside?: ReactNode;
  notice?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <section className="border-b border-band-card-line bg-band">
      <div className={cx(COLUMN, "pb-[30px] pt-[18px] max-[600px]:pb-6 max-[600px]:pt-2")}>
        {notice ? <div className="mb-[18px]">{notice}</div> : null}
        <div className="flex items-center gap-8 max-[960px]:flex-col max-[960px]:items-stretch max-[960px]:gap-5">
          <div className="min-w-0 flex-1">
            <h1
              ref={headingRef}
              tabIndex={headingRef ? -1 : undefined}
              className="m-0 text-balance text-[36px] font-extrabold leading-[42px] tracking-[-0.03em] text-text outline-none max-[600px]:text-[28px] max-[600px]:leading-[34px]"
            >
              {title}
            </h1>
            {lead ? (
              <p className="m-0 mt-2 max-w-[640px] text-[17px] font-semibold leading-[26px] text-text-2 max-[600px]:text-[16px] max-[600px]:leading-6">
                {lead}
              </p>
            ) : null}
            {children}
          </div>
          {aside ? <div className="w-[420px] shrink-0 max-[960px]:w-full">{aside}</div> : null}
        </div>
      </div>
    </section>
  );
}

/** Тело экрана под полосой: колонка 1120 */
export function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(COLUMN, "pb-14 pt-7 max-[600px]:pt-5", className)}>{children}</div>;
}

/**
 * Главная колонка и боковая 440 (gside набора). Ниже 1100 боковая уходит под
 * главную: на телефоне и узком окне читают сверху вниз.
 */
export function SideGrid({ children, side, className }: { children: ReactNode; side?: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "grid grid-cols-[minmax(0,1fr)_440px] items-start gap-5 max-[1099px]:grid-cols-1",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
      {side ? <div className="flex min-w-0 flex-col gap-4">{side}</div> : null}
    </div>
  );
}

/** Карточка на полосе (bcard): белый лист с тенью полосы — ближайший приём, перенос */
export function BandCard({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <div id={id} className={cx("rounded-drawer border border-band-card-line bg-band-card px-[18px] py-4 shadow-banner", className)}>
      {children}
    </div>
  );
}

/* ─────────── панель ─────────── */

/**
 * Панель кабинета: та же, что в наборе (лист 14, обод, квадрат значка 32),
 * в регистре пациента — шапка от 64, заголовок 18, тело 16 с полями 18.
 */
export function PtPanel({
  title,
  icon,
  tone = "violet",
  sub,
  count,
  actions,
  footer,
  children,
  flush,
  className,
  id,
}: {
  title: ReactNode;
  icon: ReactNode;
  tone?: PanelTone;
  sub?: ReactNode;
  count?: number | null;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  id?: string;
}) {
  const headId = useId();
  return (
    <section
      id={id}
      aria-labelledby={headId}
      className={cx("min-w-0 overflow-clip rounded-panel border border-border bg-panel shadow-panel", className)}
    >
      <div className="flex min-h-16 flex-wrap items-center gap-x-2.5 gap-y-1 py-3 pl-4 pr-3.5">
        <IconTile icon={icon} tone={tone} />
        <h2 id={headId} className="m-0 min-w-0 text-[18px] font-extrabold leading-6 tracking-[-0.01em] text-text">
          {title}
        </h2>
        {count !== undefined && count !== null ? <Count n={count} /> : null}
        {sub ? <span className="min-w-0 text-[14px] leading-5 text-muted">{sub}</span> : null}
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {flush ? children : <div className="px-[18px] pb-[18px] pt-1 text-[16px] leading-6 text-text">{children}</div>}
      {footer ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-divider px-[18px] py-3 text-[14px] text-text-2">{footer}</div>
      ) : null}
    </section>
  );
}

/* ─────────── код методики ─────────── */

const CODE = /^[A-ZА-ЯІЇЄҐ][A-ZА-ЯІЇЄҐ0-9-]{1,6}$/;

/**
 * Короткий код методики из её же названия: «Тривога (GAD-7)» → GAD-7,
 * «СР-45. Схильність…» → СР-45, «Поширені психічні розлади (SRQ-20, ВООЗ)»
 * → SRQ-20. Кода в названии нет — null, и на плитке встаёт значок, а не
 * выдуманное сокращение.
 */
export function instrumentCode(title: string): string | null {
  const paren = /\(([^()]+)\)\s*$/.exec(title);
  if (paren) {
    for (const part of paren[1]!.split(",")) {
      const code = part.trim();
      if (CODE.test(code)) return code;
    }
  }
  const lead = /^([A-ZА-ЯІЇЄҐ][A-ZА-ЯІЇЄҐ0-9-]{1,6})[.:]\s/.exec(title);
  return lead ? lead[1]! : null;
}

/** Название без кода в скобках: код уже стоит на плитке рядом */
export function instrumentName(title: string): string {
  const paren = /\s*\(([^()]+)\)\s*$/.exec(title);
  /* только скобки, где ничего, кроме кода: «(SRQ-20, ВООЗ)» несёт ещё и источник и остаётся */
  if (!paren || !CODE.test(paren[1]!.trim())) return title;
  return title.slice(0, paren.index).trim() || title;
}

export type CodeTone = "violet" | "neutral" | "good";

const codeTone: Record<CodeTone, string> = {
  violet: "bg-violet-tint text-violet-ink",
  neutral: "bg-sunk text-text-2",
  good: "bg-good-tint text-good",
};

/** Плитка методики (ctile): код из названия или значок списка */
export function CodeTile({ title, tone = "violet", small }: { title: string; tone?: CodeTone; small?: boolean }) {
  const code = instrumentCode(title);
  return (
    <span
      aria-hidden
      className={cx(
        "grid shrink-0 place-items-center font-extrabold leading-none tracking-[-0.01em] supports-[corner-shape:squircle]:[corner-shape:squircle]",
        small
          ? "size-10 rounded-[12px] text-[11px] supports-[corner-shape:squircle]:rounded-[15px]"
          : "size-12 rounded-[14px] supports-[corner-shape:squircle]:rounded-[18px]",
        !small && (code && code.length > 5 ? "text-[11px]" : "text-[12.5px]"),
        codeTone[tone],
      )}
    >
      {code ?? <ShellIcon name="clipboard-list" size={small ? 18 : 20} />}
    </span>
  );
}

/* ─────────── строка сведений ─────────── */

/** Строка пояснений под названием: значок и слова, через промежуток (.mt) */
export function MetaLine({ items, className }: { items: { icon: ReactNode; text: ReactNode; key: string }[]; className?: string }) {
  if (!items.length) return null;
  return (
    <div className={cx("mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[14px] leading-5 text-text-2", className)}>
      {items.map((it) => (
        <span key={it.key} className="inline-flex items-center gap-1.5 [&>svg]:shrink-0 [&>svg]:text-muted">
          {it.icon}
          {it.text}
        </span>
      ))}
    </div>
  );
}

/** Список фактов со значками (.fx): «Можна зупинитися будь-коли» и пояснение */
export function FactList({ items }: { items: { icon: ReactNode; title: ReactNode; text: ReactNode; key: string }[] }) {
  return (
    <ul className="m-0 list-none p-0">
      {items.map((f) => (
        <li key={f.key} className="flex gap-3.5 border-t border-divider py-[13px] first:border-t-0 first:pt-0.5 last:pb-0">
          <IconTile icon={f.icon} className="mt-px" />
          <span className="min-w-0">
            <b className="block text-[15.5px] font-extrabold leading-[22px] text-text">{f.title}</b>
            <small className="mt-px block text-[14.5px] font-medium leading-[21px] text-text-2">{f.text}</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ─────────── номера помощи ─────────── */

/**
 * Номера помощи строками-звонками (m-calls): линия доверия и 103. Красным —
 * только 103: это единственная строка про угрозу жизни. Настоящие ссылки
 * tel: без подтверждения: в кризис лишний шаг между человеком и звонком
 * стоит дороже всего остального на экране. Строк, номеров которых у
 * кабинета нет (семья, дежурный отделения), здесь нет: выдумывать их нельзя.
 *
 * `autoFocus` — в ящике «Допомога»: фокус при открытии встаёт на первый
 * звонок, а не на крестик (Drawer, data-autofocus). На крестике набор
 * сразу показывает подсказку «Закрити…», и на телефоне она ложилась поверх
 * строки 103 (ревью волны 26); а звонок — то, ради чего ящик открыли.
 */
export function CallRows({ framed = true, autoFocus }: { framed?: boolean; autoFocus?: boolean }) {
  const { ut } = useLang();
  const rows = [
    { key: "hotline", name: ut("home.hotline"), sub: ut("pt.helpHotlineSub"), num: ut("home.hotlineNumber"), risk: false },
    { key: "emergency", name: ut("pt.emergency"), sub: ut("pt.emergencySub"), num: ut("pt.emergencyNumber"), risk: true },
  ];
  return (
    <div className={cx(framed ? "overflow-hidden rounded-[16px] border border-border" : "border-t border-divider")}>
      {rows.map((r, i) => (
        <a
          key={r.key}
          href={`tel:${r.num}`}
          data-autofocus={autoFocus && i === 0 ? true : undefined}
          aria-label={`${ut("pt.helpCall")}: ${r.name}, ${r.num}`}
          className="group grid min-h-[66px] grid-cols-[minmax(0,1fr)_auto_44px] items-center gap-3 border-t border-divider py-[9px] pl-4 pr-[14px] text-text no-underline first:border-t-0 hover:bg-panel-2 hover:no-underline"
        >
          <span className="min-w-0">
            <b className={cx("block text-[16px] font-extrabold leading-[22px]", r.risk && "text-risk-ink")}>{r.name}</b>
            <small className="block truncate text-[14px] font-semibold leading-[19px] text-muted">{r.sub}</small>
          </span>
          <span className={cx("text-[20px] font-extrabold leading-none tabular-nums", r.risk ? "text-risk-ink" : "text-violet-ink")}>
            {r.num}
          </span>
          <span
            aria-hidden
            className={cx(
              "grid size-11 place-items-center rounded-[14px]",
              r.risk ? "bg-risk text-onfill group-hover:bg-risk-hover" : "bg-violet-tint text-violet-ink group-hover:bg-violet-tint-2",
            )}
          >
            <ShellIcon name="phone" size={19} />
          </span>
        </a>
      ))}
    </div>
  );
}

/**
 * «Потрібна допомога зараз?» — плашка, открывающая ящик «Допомога» (hlink):
 * та же помощь, что в шапке, но там, где человек сейчас читает.
 */
export function HelpLink({ title, sub }: { title?: ReactNode; sub?: ReactNode }) {
  const { ut } = useLang();
  const openHelp = useHelp();
  return (
    <button
      type="button"
      onClick={openHelp}
      aria-haspopup="dialog"
      className="flex min-h-16 w-full items-center gap-3 whitespace-normal rounded-[14px] border-0 bg-violet-tint px-3.5 py-2.5 text-left text-text transition-colors hover:bg-violet-tint-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
    >
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-control bg-band-card text-violet-ink supports-[corner-shape:squircle]:rounded-[14px] supports-[corner-shape:squircle]:[corner-shape:squircle]"
      >
        <ShellIcon name="phone" size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <b className="block text-[15.5px] font-extrabold leading-[21px]">{title ?? ut("ptw.helpNow")}</b>
        <small className="block text-[14px] font-semibold leading-[19px] text-text-2">{sub ?? ut("ptw.helpNowSub")}</small>
      </span>
      <span className="shrink-0 text-[20px] font-extrabold leading-none tabular-nums text-violet-ink">{ut("home.hotlineNumber")}</span>
    </button>
  );
}

/** Место данных внутри карточки или панели, пока их нет: скелет или отказ с «Повторити» — без своего листа */
export function Pending({ res, rows = 2 }: { res: Pick<Resource<unknown>, "error" | "loading" | "reload">; rows?: number }) {
  return <Loading bare rows={rows} error={res.error} onRetry={res.reload} busy={res.loading} />;
}
