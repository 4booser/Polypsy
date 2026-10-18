import type { ReactNode } from "react";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { locale } from "../format";
import { Logo } from "../shell/Logo";
import { PRINT_SHEET } from "../print";
import { cx } from "../ui/cx";

/**
 * Печатный лист «Виразной» в консоли (UI 3, .superdesign/ui3/screens/print.py):
 * ключ методики, пустой бланк и шапка сводки карты пациента.
 *
 * Те же части, что у листов сервера (apps/api/src/lib/printSheet.ts): шапка
 * со знаком и датой, сетка фактов, разделы с подписью справа, строка
 * подписей с печатью и подвал. Сервер собирает лист строкой, консоль —
 * разметкой; классы одни и те же (`ps-*`), оформление — styles/legacy.css,
 * печатные значения токенов — styles/tokens.css.
 *
 * На экране лист — предпросмотр в теме консоли, на бумаге — чёрное на белом
 * (токены печати). Выраженность — слово в обводке ступени (`ps-sev l0…l4`):
 * монохромный принтер оставляет слово и рамку.
 *
 * Номер страницы — полями страницы @page (Chrome): правило ставит сам лист,
 * пока он на экране, на языке консоли (PageRules ниже).
 */

/** Подстановка «{имя}» в строку словаря */
export function fill(text: string, params: Record<string, string | number>): string {
  return Object.entries(params).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

/** Дата листа числами: «08.10.2026» — как у листов сервера */
export function sheetDate(at: Date = new Date()): string {
  return at.toLocaleDateString(locale(), { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Время листа: «17:20» */
export function sheetTime(at: Date = new Date()): string {
  return at.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** Строка для `content:` в CSS — кавычки, обратная косая и «<» */
function cssString(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\A ").replace(/</g, "\\3C ")}"`;
}

/**
 * Поля страницы на печати: внизу слева — о чём лист, внизу справа —
 * «Сторінка N з M» на языке консоли. Правило живёт, пока лист смонтирован:
 * остальная печать консоли его не получает.
 */
export function PageRules({ running }: { running: string }) {
  const { ut } = useLang();
  const counter = fill(ut("ps.pageOf"), { page: "\u0001", pages: "\u0002" })
    .split(/(\u0001|\u0002)/)
    .filter(Boolean)
    .map((part) => (part === "\u0001" ? "counter(page)" : part === "\u0002" ? "counter(pages)" : cssString(part)))
    .join(" ");
  const box = "font-family:var(--font-text);font-size:7.5pt;line-height:1.35;vertical-align:top;padding-top:4mm";
  const css = `@media print{@page{size:A4;margin:12mm 14mm 16mm;@bottom-left{content:${cssString(running)};${box};text-align:left}@bottom-right{content:${counter};${box};text-align:right;font-weight:700}}}`;
  return <style>{css}</style>;
}

/** Лист: на экране — предпросмотр, на печати — единственное, что печатается */
export function Sheet({ running, children, className }: { running: string; children: ReactNode; className?: string }) {
  return (
    <article className={cx("ps", className)} {...{ [PRINT_SHEET]: "" }}>
      <PageRules running={running} />
      {children}
    </article>
  );
}

/**
 * Шапка листа: знак, имя системы и подразделение того, кто печатает, слева;
 * дата документа справа. Названия учреждения консоль не знает (оно в
 * настройке сервера, INSTITUTION_NAME) — подразделение сотрудника стоит на
 * его месте.
 */
export function SheetHead({ primary, secondary }: { primary: ReactNode; secondary?: ReactNode }) {
  const { ut } = useLang();
  const { user } = useAuth();
  return (
    <header className="ps-h">
      <span className="logo">
        <Logo size={22} />
      </span>
      <span className="org">
        <b>{ut("ps.brand")}</b>
        {user?.unit ?? ""}
      </span>
      <span className="no">
        <b>{primary}</b>
        {secondary}
      </span>
    </header>
  );
}

/** Сетка фактов: подпись над значением; последняя клетка дотягивает строку */
export function Facts({ items, cols = 3 }: { items: [label: string, value: ReactNode][]; cols?: 2 | 3 | 4 }) {
  const shown = items.filter(([, v]) => v !== null && v !== undefined && v !== "");
  const rest = shown.length % cols;
  return (
    <dl className={`ps-facts c${cols}`}>
      {shown.map(([label, value], i) => (
        <div key={label} style={i === shown.length - 1 && rest ? { gridColumn: `span ${cols - rest + 1}` } : undefined}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Раздел листа: заголовок с подписью справа */
export function SheetSection({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="ps-sec">
      <h3>
        {title}
        {right ? <span className="r">{right}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** Строка подписей: линия, имя (если известно) и подпись роли; печать — кругом «М. П.» */
export function Signs({ items, seal }: { items: { name?: ReactNode; caption: ReactNode }[]; seal?: boolean }) {
  const { ut } = useLang();
  const cols = `${items.map(() => "minmax(0,1fr)").join(" ")}${seal ? " 56px" : ""}`;
  return (
    <div className="ps-signs" style={{ gridTemplateColumns: cols }}>
      {items.map((s, i) => (
        <div className="s" key={i}>
          <i />
          {s.name !== undefined ? <b>{s.name || " "}</b> : null}
          {s.caption}
        </div>
      ))}
      {seal ? <div className="ps-stamp">{ut("ps.seal")}</div> : null}
    </div>
  );
}

/** Подвал: кто и когда распечатал, пометка документа; справа — его короткое имя */
export function SheetFoot({ lines, right }: { lines: ReactNode[]; right: ReactNode }) {
  return (
    <footer className="ps-foot">
      <span>
        {lines.map((l, i) => (
          <span className="block" key={i}>
            {l}
          </span>
        ))}
      </span>
      <span className="r">
        <b>{right}</b>
      </span>
    </footer>
  );
}

/** «Роздруковано: Ірина Савчук, 08.10.2026, 17:22» */
export function usePrintedBy(): string {
  const { ut } = useLang();
  const { user } = useAuth();
  const now = new Date();
  const who = user ? `${user.lastName ?? ""} ${user.firstName ?? ""}`.trim() : "";
  return fill(ut("ps.printedBy"), { who, at: `${sheetDate(now)}, ${sheetTime(now)}` });
}

/** Ступень набора 0…4 для выраженности; две тяжёлые подряд различаются (s3/s4), как на листах сервера */
const STEP: Record<string, number> = { none: 0, mild: 1, moderate: 2, severe: 4 };
export function stepsOfBands(bands: { severity: string | null }[]): (number | null)[] {
  const steps = bands.map((b) => (b.severity && b.severity in STEP ? STEP[b.severity]! : null));
  const severe = steps.flatMap((s, i) => (s === 4 ? [i] : []));
  if (severe.length < 2) return steps;
  const calm = steps.flatMap((s, i) => (s === 0 || s === 1 ? [i] : []));
  const calmAt = calm.length ? calm.reduce((a, b) => a + b, 0) / calm.length : -1;
  const extreme = severe.reduce((far, i) => (Math.abs(i - calmAt) > Math.abs(far - calmAt) ? i : far), severe[0]!);
  return steps.map((s, i) => (s === 4 && i !== extreme ? 3 : s));
}

/** Слово выраженности в обводке ступени */
export function SevPill({ step, children }: { step: number | null; children: ReactNode }) {
  return <span className={`ps-sev l${step === null ? "n" : step}`}>{children}</span>;
}

/** Пустой кружок для отметки ручкой */
export function Mark() {
  return <span className="ps-o" aria-hidden />;
}
