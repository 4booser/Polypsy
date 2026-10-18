import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { Link, NavLink, type LinkProps } from "react-router-dom";
import { createContext, forwardRef, useContext, useEffect, useId, useImperativeHandle, useRef } from "react";
import { cx } from "./cx";
import { Ic } from "./icons";
import { useLang } from "../lang";

/*
 * Примитивы консоли в наборе «Виразна».
 *
 * Источник вида — .superdesign/ui3/kit (ui.py + page.py) и страница
 * дизайн-системы (shots/system/design-system-*.png). Классы ниже — те же
 * числа набора, записанные утилитами Tailwind на токенах styles/tokens.css:
 *
 *   кнопка 40 (мелкая 32, пациентская 48 и 52), радиус 10, 13.5/700;
 *   поле 40, рамка --field-border (3:1 к листу), радиус 10, 13.5/500;
 *   пилюля состояния 24, радиус 12, 11.5/700; тяжесть — 26, всегда со словом;
 *   вкладка 36, бездеятельная — text-2, выбранная — фиолетовые чернила на
 *   плашке листа с тенью плитки.
 *
 * Свойства прежних редакций сохранены все: экраны меняются по своим волнам,
 * а примитив обязан принять то, что в них уже написано. Значения, которые
 * описывали замеры прежнего макета (кегли 17/22, вид «полем-заливкой»,
 * плейсхолдер-подпись), принимаются и сводятся к ближайшему виду набора.
 */

/** Кольцо фокуса набора: 2 px фиолетовым с отступом 2 (#app :focus-visible) */
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/* ─────────── территория пальца ─────────── */

/**
 * Наименьшая мишень для пальца, в пикселях.
 *
 * 44 — поперечник подушечки указательного пальца на экране телефона. Меньше —
 * и промах перестаёт быть случайностью.
 */
export const TOUCH_MIN_PX = 44;

/*
 * Пол мишеней объявлен селектором на оболочке кабинета пациента, а не
 * размером каждой кнопки: 44 px — свойство места. В консоли работают мышью и
 * держат плотность (40 и 32), в кабинете — пальцем, одной рукой.
 * `min-height` сильнее `height`: h-10 внутри зоны становится 44, 48 остаётся 48.
 */
const touchFloor = cx(
  "[&_:is(button,a,summary,[role=button])]:min-h-[44px]",
  "[&_:is(button,a,summary,[role=button])]:min-w-[44px]",
  "[&_:is(input,select,textarea)]:min-h-[44px]",
);

/**
 * Внутри зоны мишени меряются пальцем, а поля обязаны иметь подпись: экран
 * открывает не сотрудник, и безымянное поле для него — тупик (см.
 * useFieldNameGuard).
 */
const TouchZone = createContext(false);

export function TouchArea({
  children,
  className,
  as: As = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "main" | "section" | "form";
}) {
  return (
    <TouchZone.Provider value={true}>
      {/* data-touch — опора для проверок: классы менять можно, признак нет */}
      <As data-touch className={cx(touchFloor, className)}>
        {children}
      </As>
    </TouchZone.Provider>
  );
}

/* ─────────── кнопка ─────────── */

/**
 * Вид кнопки.
 *
 *  - `primary`   — основная: фиолетовая заливка с тенью. Одна на область.
 *  - `secondary` — тонированная: фиолетовые чернила на светлой заливке.
 *                  Умолчание — так выглядит большинство действий набора.
 *  - `ghost`     — без заливки, фиолетовыми чернилами; заливка на наведении.
 *  - `quiet`     — без заливки, чернилами text-2: служебное действие.
 *  - `risk`      — красная заливка. ТОЛЬКО для действия над риском для
 *                  человека («Розібрати», «Передати черговому»).
 *  - `danger`    — разрушительное действие (удалить, отозвать, отключить).
 *                  По правилу набора выглядит обычной кнопкой: красный
 *                  отдан риску для человека, а разрушительное держится на
 *                  подтверждении, а не на цвете. Отдельным именем — чтобы
 *                  такое место было видно в разметке.
 *  - `paper` / `outline` — лист с тонкой рамкой: кнопка на тонированной
 *                  поверхности, где нужна граница (чипы ящика, «Відкрити»).
 *  - `panel`     — лист без рамки на тонированной полосе (массовые действия).
 */
type Variant = "primary" | "secondary" | "ghost" | "quiet" | "risk" | "danger" | "paper" | "outline" | "panel";

/**
 * Размер.
 *
 *  - `sm` (умолчание) — 40 px, строка консоли и форма;
 *  - `xs` — 32 px, действие в строке, в поповере, в плотной панели;
 *  - `md` — 48 px, кабинет пациента и гостевые страницы;
 *  - `lg` — 52 px, главное действие шага на телефоне;
 *  - `icon` / `icon-sm` — квадрат 40 / 32 под один значок (подпись — aria-label).
 *
 * Прежние имена приняты: `form` = 40, `card` = 32, `glyph` = квадрат 36
 * (значок в строке над списком), `glyph-sm` = квадрат 32.
 */
type Size = "xs" | "sm" | "md" | "lg" | "icon" | "icon-sm" | "card" | "form" | "glyph" | "glyph-sm";

const variants: Record<Variant, string> = {
  primary: "bg-violet text-onfill shadow-primary hover:bg-violet-hover disabled:shadow-none",
  secondary: "bg-violet-tint text-violet-ink hover:bg-violet-tint-2",
  ghost: "bg-transparent text-violet-ink hover:bg-violet-tint",
  quiet: "bg-transparent text-text-2 hover:bg-sunk hover:text-text",
  risk: "bg-risk text-onfill hover:bg-risk-hover",
  danger: "bg-violet-tint text-violet-ink hover:bg-violet-tint-2",
  paper: "bg-panel text-violet-ink shadow-[inset_0_0_0_1px_var(--ctl)] hover:bg-violet-tint",
  outline: "bg-panel text-violet-ink shadow-[inset_0_0_0_1px_var(--ctl)] hover:bg-violet-tint",
  panel: "bg-panel text-violet-ink hover:bg-violet-tint-2",
};

const sizes: Record<Size, string> = {
  sm: "h-10 gap-2 rounded-control px-4 text-body",
  form: "h-10 gap-2 rounded-control px-4 text-body",
  xs: "h-8 gap-1.5 rounded-[9px] px-3 text-small",
  card: "h-8 gap-1.5 rounded-[9px] px-3 text-small",
  md: "h-12 gap-2 rounded-[12px] px-[18px] text-[15px]",
  lg: "h-[52px] gap-2 rounded-panel px-5 text-[17px]",
  icon: "size-10 rounded-control p-0",
  "icon-sm": "size-8 rounded-[9px] p-0",
  glyph: "size-9 rounded-control p-0",
  "glyph-sm": "size-8 rounded-[9px] p-0",
};

/** Размер значка внутри кнопки — по ступени (набор: 14 в мелкой, 15 в обычной, 18 в крупной) */
const iconSize: Record<Size, string> = {
  sm: "[&>svg]:size-[15px]",
  form: "[&>svg]:size-[15px]",
  xs: "[&>svg]:size-[14px]",
  card: "[&>svg]:size-[14px]",
  md: "[&>svg]:size-[18px]",
  lg: "[&>svg]:size-[18px]",
  icon: "[&>svg]:size-4",
  "icon-sm": "[&>svg]:size-[15px]",
  glyph: "[&>svg]:size-4",
  "glyph-sm": "[&>svg]:size-[15px]",
};

/**
 * Классы кнопки — одна таблица для <button>, ссылки-кнопки и ссылки-значка.
 * Экспортирована для мест, где кнопкой должен выглядеть чужой элемент
 * (label загрузки файла, summary).
 */
export function buttonClass(variant: Variant = "secondary", size: Size = "sm", className?: string): string {
  return cx(
    "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap border-0 font-bold leading-none no-underline",
    "transition-[background-color,box-shadow,color] duration-[var(--dur-fast)] ease-[var(--ease)]",
    "hover:no-underline active:translate-y-px",
    "disabled:cursor-not-allowed disabled:opacity-48 disabled:active:translate-y-0",
    "aria-disabled:cursor-not-allowed aria-disabled:opacity-48",
    /* раскрытое меню или ящик: та же кнопка «нажата» — тонированная с кольцом (набор: [aria-expanded=true]) */
    variant !== "risk" &&
      "aria-expanded:bg-violet-tint-2 aria-expanded:text-violet-ink aria-expanded:shadow-[inset_0_0_0_1.5px_var(--vring)]",
    sizes[size],
    iconSize[size],
    variants[variant],
    focus,
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Значок перед подписью (или единственный — тогда нужен aria-label) */
  icon?: ReactNode;
  /** Значок после подписи: «Почати →», «Далі →» */
  iconEnd?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "sm", icon, iconEnd, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest}>
      {icon ? <span className={cx("inline-flex", iconSize[size])}>{icon}</span> : null}
      {children}
      {iconEnd ? <span className={cx("inline-flex", iconSize[size])}>{iconEnd}</span> : null}
    </button>
  );
});

/**
 * Значок-ссылка: «+» над перечнем, ведущий на форму новой записи.
 *
 * Элемент <a>, а не кнопка с navigate(): переход — это ссылка, её открывают
 * в новой вкладке и видят адрес. Вид — квадрат 36 без заливки.
 */
export function GlyphLink({ className, children, ...rest }: LinkProps) {
  return (
    <Link className={buttonClass("ghost", "glyph", className)} {...rest}>
      {children}
    </Link>
  );
}

/** Кнопка, которая на самом деле ссылка. Те же виды и размеры, что у Button. */
export function ButtonLink({
  size = "sm",
  variant = "secondary",
  className,
  children,
  ...rest
}: LinkProps & { size?: Size; variant?: Variant }) {
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </Link>
  );
}

/* ─────────── поверхность ─────────── */

/**
 * Лист: белая (в тёмной — фиолетово-графитовая) плоскость, обод в пиксель,
 * радиус 14. Без заголовка — заголовок у Panel из ui/layout.
 */
export function Panel({
  children,
  className,
  as: As = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "aside" | "article";
}) {
  return <As className={cx("rounded-panel border border-border bg-panel shadow-panel", className)}>{children}</As>;
}

/** Подпись над группой или числом: 12/700 приглушённым (.lbl набора) */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("text-caption font-bold text-muted", className)}>{children}</div>;
}

/* ─────────── число ─────────── */

/**
 * Число, которое читают с расстояния: 32/800 Manrope табличными цифрами.
 *
 * `null` печатается прочерком, а не нулём: ноль — результат, прочерк — его
 * отсутствие, и путать их в клинических данных нельзя.
 */
export function Stat({
  value,
  unit,
  label,
  tone = "plain",
  className,
}: {
  value: number | string | null;
  unit?: string;
  label?: ReactNode;
  tone?: "plain" | "attention" | "danger";
  className?: string;
}) {
  const toneClass = tone === "attention" ? "text-warn" : tone === "danger" ? "text-risk-ink" : "text-text";
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <span className={cx("text-stat font-extrabold tabular-nums", toneClass)}>
        {value === null ? "—" : value}
        {unit && value !== null ? <span className="ml-1 text-[14px] font-bold tracking-normal text-muted">{unit}</span> : null}
      </span>
      {label ? <span className="text-caption text-muted">{label}</span> : null}
    </div>
  );
}

/** Число в строке текста: табличные цифры той же гарнитуры, без моноширинного шрифта */
export function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("whitespace-nowrap tabular-nums", className)}>{children}</span>;
}

/* ─────────── метки ─────────── */

/**
 * Ступень тяжести. Четыре прежних слова плюс `modsevere` (помірно тяжка) —
 * в наборе ступеней пять (sev-0…4).
 */
export type Severity = "none" | "mild" | "moderate" | "modsevere" | "severe";

const severityTone: Record<Severity, string> = {
  none: "bg-sev-0-bg text-sev-0",
  mild: "bg-sev-1-bg text-sev-1",
  moderate: "bg-sev-2-bg text-sev-2",
  modsevere: "bg-sev-3-bg text-sev-3",
  severe: "bg-sev-4-bg text-sev-4",
};

/**
 * Пилюля тяжести — всегда со словом.
 *
 * Цвет подсказывает, слово говорит: человек с нарушенным цветовым зрением
 * читает то же самое по слову. Красный оттенок — только у «тяжкої».
 */
export function SeverityTag({
  level,
  children,
  small,
  className,
}: {
  level: Severity;
  children: ReactNode;
  /** 22 px в плотной строке и в поповере */
  small?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-pill font-bold leading-none",
        small ? "h-[22px] px-[9px] text-[11.5px]" : "h-[26px] px-[11px] text-caption",
        severityTone[level],
        className,
      )}
    >
      {children}
    </span>
  );
}

export type TagTone = "plain" | "attention" | "danger" | "primary" | "good" | "info" | "done";

const tagTone: Record<TagTone, string> = {
  plain: "bg-sunk text-text-2",
  attention: "bg-warn-tint-2 text-warn",
  danger: "bg-risk-tint-2 text-risk-ink",
  primary: "bg-violet-tint text-violet-ink",
  good: "bg-good-tint text-good",
  info: "bg-info-tint text-info",
  done: "bg-sunk text-muted",
};

/**
 * Пилюля состояния (.st набора): причина, состояние, признак. Не для тяжести.
 *
 * Тоны: `plain` нейтральная, `attention` янтарь (просрочено, неявка),
 * `danger` — только риск для человека, `primary` — «ваше, сегодня»,
 * `good` — сделано, `info` — сообщение, `done` — погашено.
 */
export function Tag({
  children,
  tone = "plain",
  icon,
  className,
}: {
  children: ReactNode;
  tone?: TagTone;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-pill text-[11.5px] font-bold leading-none",
        icon ? "pl-[7px] pr-[9px] [&>svg]:size-3" : "px-[9px]",
        tagTone[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/* ─────────── поля ввода ─────────── */

/**
 * Начертание поля. `outline` — лист с рамкой (форма). `fill` — залитое
 * (поиск и фильтр над списком). Рамка 3:1 у обоих: при плохом свете поле без
 * рамки читается пустым местом.
 */
export type FieldLook = "outline" | "fill";

/**
 * Прежняя настройка «подпись внутри поля» (17/700 фиолетовым или 17/400
 * серым). Подпись в наборе стоит над полем, а подсказка внутри — всегда
 * приглушённая; значение принимается и больше ничего не меняет.
 */
export type PlaceholderLook = "label" | "plain";

/** Общая форма полей: рамка 3:1, радиус 10, 13.5/500, фокус — рамка цвета кольца и мягкий ореол */
const fieldFrame = cx(
  "w-full min-w-0 border border-field-border font-medium text-text",
  "placeholder:text-muted placeholder:opacity-100",
  "transition-[border-color,box-shadow,background-color] duration-[var(--dur-fast)] ease-[var(--ease)]",
  "hover:border-muted",
  "focus:border-violet-ring focus:shadow-[0_0_0_3px_var(--vtint)] focus:outline-none",
  "aria-[invalid=true]:border-risk-ink aria-[invalid=true]:shadow-[0_0_0_3px_var(--risktint)]",
  "disabled:cursor-not-allowed disabled:border-border disabled:bg-sunk disabled:text-muted",
);

const looks: Record<FieldLook, string> = {
  outline: "bg-panel",
  fill: "bg-sunk focus:bg-panel",
};

/**
 * Что поле получает от Field: подпись (для плейсхолдера строчного поля),
 * отказ и связку с пояснением. null — поле не внутри Field.
 */
interface FieldContext {
  /** Подставить плейсхолдером, если своего нет; "" — не подставлять */
  ph: string;
  invalid: boolean;
  describedBy?: string;
}
const InsideField = createContext<FieldContext | null>(null);

/**
 * Поле без имени — нарушение WCAG 4.1.2: диктор произносит «поле ввода», и
 * человек не знает, что туда писать. Проверка — только в кабинете пациента и
 * только при разработке: туда приходит не сотрудник, и цена безымянного поля
 * там другая.
 */
function useFieldNameGuard(
  tag: string,
  props: { "aria-label"?: string; "aria-labelledby"?: string; title?: string; placeholder?: string },
) {
  const strict = useContext(TouchZone);
  const named = useContext(InsideField) !== null;
  const dev = typeof import.meta.env === "undefined" || import.meta.env.PROD !== true;
  if (!dev || !strict || named) return;
  if (props["aria-label"] || props["aria-labelledby"] || props.title) return;
  throw new Error(
    `<${tag}> в кабинете пациента без подписи: оберните в <Field label=…> ` +
      `либо свяжите с видимым заголовком через aria-labelledby. ` +
      `Подсказка внутри поля (placeholder${props.placeholder ? `="${props.placeholder}"` : ""}) подписью не считается: ` +
      `она исчезает при наборе и не читается диктором как имя поля.`,
  );
}

/**
 * Имя и состояние поля из окружения.
 *
 * Внутри Field: плейсхолдер из подписи (только у строчного поля, где подпись
 * скрыта), aria-invalid и aria-describedby к пояснению или отказу. Снаружи —
 * имя из плейсхолдера, если другого имени нет и нет id (поле с id, скорее
 * всего, подписано <label for>, и aria-label его бы переименовал).
 */
function fieldAttrs(
  inside: FieldContext | null,
  props: {
    "aria-label"?: string;
    "aria-labelledby"?: string;
    "aria-invalid"?: InputHTMLAttributes<HTMLInputElement>["aria-invalid"];
    "aria-describedby"?: string;
    title?: string;
    placeholder?: string;
    id?: string;
  },
): Record<string, string | boolean | undefined> {
  if (inside !== null) {
    return {
      ...(props.placeholder || !inside.ph ? {} : { placeholder: inside.ph }),
      ...(inside.invalid && props["aria-invalid"] === undefined ? { "aria-invalid": true } : {}),
      ...(inside.describedBy && !props["aria-describedby"] ? { "aria-describedby": inside.describedBy } : {}),
    };
  }
  if (props["aria-label"] || props["aria-labelledby"] || props.title) return {};
  if (props.id) return {};
  return props.placeholder ? { "aria-label": props.placeholder } : {};
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Лист с рамкой (форма) или залитое (поиск, фильтр). См. FieldLook. */
  look?: FieldLook;
  /** Прежняя настройка подписи внутри поля; см. PlaceholderLook */
  ph?: PlaceholderLook;
  /** Значок слева внутри поля (поиск, дата, человек) */
  icon?: ReactNode;
  /** Хвост справа внутри поля: единица («хв»), подсказка клавиши «/» */
  suffix?: ReactNode;
}

/**
 * Поле ввода 40 px.
 *
 * Со значком или хвостом поле рисуется коробкой (label), а сам <input> стоит
 * внутри без рамки; className тогда ложится на коробку — им задают ширину.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, style, look = "outline", ph: _ph, icon, suffix, ...rest },
  ref,
) {
  useFieldNameGuard("input", rest);
  const inside = useContext(InsideField);
  const attrs = fieldAttrs(inside, rest);
  if (!icon && !suffix) {
    return (
      <input
        ref={ref}
        className={cx(fieldFrame, looks[look], "h-10 rounded-control px-3 text-body", className)}
        style={style}
        {...attrs}
        {...rest}
      />
    );
  }
  const invalid = rest["aria-invalid"] ?? attrs["aria-invalid"];
  return (
    <span
      data-invalid={invalid ? "true" : undefined}
      data-disabled={rest.disabled ? "true" : undefined}
      className={cx(
        "flex h-10 w-full min-w-0 cursor-text items-center gap-2 rounded-control border border-field-border px-3 text-body text-muted",
        "transition-[border-color,box-shadow,background-color] duration-[var(--dur-fast)] ease-[var(--ease)]",
        "hover:border-muted focus-within:border-violet-ring focus-within:shadow-[0_0_0_3px_var(--vtint)]",
        "data-[invalid=true]:border-risk-ink data-[invalid=true]:shadow-[0_0_0_3px_var(--risktint)]",
        "data-[disabled=true]:cursor-not-allowed data-[disabled=true]:border-border data-[disabled=true]:bg-sunk",
        looks[look],
        look === "fill" && "focus-within:bg-panel",
        className,
      )}
      style={style}
    >
      {icon ? <span className="inline-flex text-muted [&>svg]:size-[15px]">{icon}</span> : null}
      <input
        ref={ref}
        className={cx(
          "h-full min-h-0 w-full min-w-0 flex-1 border-0 bg-transparent p-0 font-medium text-text outline-none",
          "placeholder:text-muted placeholder:opacity-100 focus-visible:outline-none disabled:cursor-not-allowed",
        )}
        {...attrs}
        {...rest}
      />
      {suffix ? <span className="ml-auto shrink-0 whitespace-nowrap text-small font-semibold text-muted">{suffix}</span> : null}
    </span>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  look?: FieldLook;
  /** Прежняя настройка подписи внутри поля; см. PlaceholderLook */
  ph?: PlaceholderLook;
}

/** Текстовая область: от 80 px, растёт по rows, радиус 12, 13/19 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, look = "outline", ph: _ph, ...rest },
  ref,
) {
  useFieldNameGuard("textarea", rest);
  const inside = useContext(InsideField);
  return (
    <textarea
      ref={ref}
      className={cx(
        fieldFrame,
        looks[look],
        "block min-h-20 resize-y rounded-[12px] px-3 py-2.5 text-[13px] leading-[19px]",
        className,
      )}
      {...fieldAttrs(inside, rest)}
      {...rest}
    />
  );
});

/**
 * Показ значения в силуэте поля — без самого поля: ответ пациента в
 * протоколе, вычисленное значение. Не останавливает Tab и не объявляется
 * «полем ввода»: смотреть здесь, а не править.
 *
 * `fill` — залитая плашка (.fld набора), `outline` — лист с тонкой рамкой.
 * `size` 20 — крупнее, для заголовочного значения.
 */
export function Readout({
  look = "outline",
  as: As = "div",
  size = 17,
  className,
  children,
  ...rest
}: {
  look?: FieldLook;
  as?: "div" | "span" | "li" | "dd";
  size?: 17 | 20;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "children" | "className">) {
  return (
    <As
      className={cx(
        "flex min-h-10 items-center rounded-control px-3 py-2",
        size === 20 ? "text-h3 font-bold" : "text-body",
        look === "fill" ? "bg-sunk text-text" : "bg-panel text-text shadow-[inset_0_0_0_1px_var(--ctl)]",
        className,
      )}
      {...rest}
    >
      {children}
    </As>
  );
}

/*
 * Шеврон селекта — двумя градиентами, а не картинкой: в url(data:…) токен
 * не подставить, а цвет обязан идти от темы. Каждый градиент заливает
 * половину галочки «v» шириной 5 и высотой 5.
 */
const chevron = {
  backgroundImage:
    "linear-gradient(45deg, transparent 50%, var(--muted) 50%, var(--muted) calc(50% + 1.5px), transparent calc(50% + 1.5px))," +
    "linear-gradient(135deg, transparent 50%, var(--muted) 50%, var(--muted) calc(50% + 1.5px), transparent calc(50% + 1.5px))",
  backgroundSize: "6px 6px, 6px 6px",
  backgroundPosition: "right 18px center, right 12px center",
  backgroundRepeat: "no-repeat, no-repeat",
} as const;

/** `list` — с шевроном (умолчание), `bare` — без него, в силуэте простого поля */
export type SelectLook = "list" | "bare";

/** Выбор: силуэт поля 40 px с шевроном справа; список — штатный браузерный */
export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { look?: SelectLook; ph?: PlaceholderLook }
>(function Select({ className, children, style, look = "list", ph: _ph, ...rest }, ref) {
  useFieldNameGuard("select", rest);
  const inside = useContext(InsideField);
  const bare = look === "bare";
  return (
    <select
      ref={ref}
      className={cx(
        fieldFrame,
        "h-10 cursor-pointer appearance-none rounded-control bg-panel pl-3 text-body",
        bare ? "pr-3" : "pr-9",
        className,
      )}
      style={bare ? style : { ...chevron, ...style }}
      {...fieldAttrs(inside, rest)}
      {...rest}
    >
      {children}
    </select>
  );
});

/** Отказ формы (.err набора): текст риска со значком, никогда не красная заливка */
export function ErrorText({
  children,
  id,
  tone = "risk",
  className,
}: {
  children: ReactNode;
  id?: string;
  /** `warn` — предупреждение, которое не мешает сохранить */
  tone?: "risk" | "warn";
  className?: string;
}) {
  return (
    <span
      id={id}
      className={cx(
        "flex items-start gap-1.5 text-small font-bold",
        tone === "warn" ? "text-warn" : "text-risk-ink",
        className,
      )}
    >
      {tone === "warn" ? <Ic.alert size={14} className="mt-0.5" /> : <Ic.circleAlert size={14} className="mt-0.5" />}
      <span>{children}</span>
    </span>
  );
}

/**
 * Поле с подписью (.f набора): подпись 12/700 над полем, пояснение под ним,
 * отказ — текстом со значком.
 *
 * Подпись оборачивает поле: связь получается по построению, без id. Отказ и
 * пояснение связаны с полем через aria-describedby, отказ ставит полю
 * aria-invalid — красной рамки без слова не бывает.
 *
 * `inline` — поле в строке («від [0] до [10]»): подпись скрыта (sr-only) и
 * встаёт плейсхолдером, отступа снизу нет.
 */
export function Field({
  label,
  labelClassName,
  hint,
  error,
  optional,
  htmlFor,
  inline,
  children,
  className,
}: {
  label: ReactNode;
  /** Свой набор классов подписи вместо видимой подписи набора */
  labelClassName?: string;
  hint?: ReactNode;
  error?: string | null;
  /** «— необов’язково» после подписи */
  optional?: boolean;
  /** Только если поле лежит вне подписи */
  htmlFor?: string;
  inline?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const { ut } = useLang();
  const id = useId();
  const noteId = error || hint ? `${id}-note` : undefined;
  const hidden = inline && !labelClassName;
  const ph = hidden && typeof label === "string" ? label : "";
  return (
    /* data-field — точка опоры для смоук-тестов: класс менять можно, признак нет */
    <div data-field className={cx("flex min-w-0 flex-col", inline ? "" : "mb-3.5 last:mb-0", className)}>
      <label htmlFor={htmlFor} className="m-0 block min-w-0 text-body text-text">
        <span
          className={
            hidden ? "sr-only" : (labelClassName ?? "mb-1.5 block text-caption font-bold text-muted")
          }
        >
          {label}
          {optional && !hidden ? <span className="font-medium"> — {ut("kit.optional")}</span> : null}
        </span>
        <InsideField.Provider value={{ ph, invalid: !!error, describedBy: noteId }}>{children}</InsideField.Provider>
      </label>
      {error ? (
        <ErrorText id={noteId} className="mt-1.5">
          {error}
        </ErrorText>
      ) : hint ? (
        <span id={noteId} className="mt-1.5 block text-small text-muted">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/* ─────────── флажок, радио, переключатель, выбор ─────────── */

/** Флажок набора: 18 px, радиус 6, рамка 3:1, отмеченный — фиолетовая заливка с галочкой */
export const Checkbox = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { indeterminate?: boolean }
>(function Checkbox({ indeterminate, className, ...rest }, ref) {
  const own = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => own.current as HTMLInputElement);
  useEffect(() => {
    if (own.current) own.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return <input ref={own} type="checkbox" className={cx("kit-check", className)} {...rest} />;
});

/** Подпись с флажком или радио: 13/600 text-2, пояснение 12 приглушённым */
export function CheckLabel({
  control,
  label,
  sub,
  className,
}: {
  control: ReactNode;
  label: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cx(
        "m-0 flex cursor-pointer gap-[9px] text-[13px] font-semibold text-text-2",
        sub ? "items-start [&>input]:mt-px" : "items-center",
        className,
      )}
    >
      {control}
      <span>
        {label}
        {sub ? <small className="block text-caption font-medium text-muted">{sub}</small> : null}
      </span>
    </label>
  );
}

/** Радио набора: кружок 18 с рамкой 3:1, выбранное — толстая фиолетовая рамка */
export const Radio = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type">>(function Radio(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} type="radio" className={cx("kit-radio", className)} {...rest} />;
});

/** Переключатель (role=switch): 38×22, включённый — фиолетовый */
export function Switch({
  checked,
  onChange,
  label,
  sub,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  sub?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <span className={cx("flex items-center gap-2.5 text-[13px] font-semibold text-text-2", className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative h-[22px] w-[38px] shrink-0 cursor-pointer rounded-[11px] border-0 p-0",
          "transition-colors duration-[var(--dur)] ease-[var(--ease)]",
          checked ? "bg-violet" : "bg-field-border",
          "disabled:cursor-not-allowed disabled:opacity-48",
          focus,
        )}
      >
        <i
          aria-hidden
          className={cx(
            "absolute left-[3px] top-[3px] size-4 rounded-full bg-onfill shadow-tile",
            "transition-transform duration-[var(--dur)] ease-[var(--ease)]",
            checked && "translate-x-4",
          )}
        />
      </button>
      <span id={`${id}-l`} className="flex flex-col">
        {label}
        {sub ? <small className="text-caption font-medium text-muted">{sub}</small> : null}
      </span>
    </span>
  );
}

/**
 * Карточка выбора (радио-карточка «Рішення»): жирный заголовок и приглушённое
 * пояснение; выбранная — тонированная с фиолетовым кольцом.
 */
export function ChoiceCard({
  name,
  value,
  checked,
  onChange,
  title,
  sub,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  title: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <label
      className={cx(
        "m-0 flex cursor-pointer items-start gap-3 rounded-[12px] px-3.5 py-2.5",
        "transition-[background-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease)]",
        checked ? "bg-violet-tint shadow-[inset_0_0_0_1.5px_var(--vring)]" : "bg-sunk hover:bg-sunk-2",
      )}
    >
      <Radio name={name} value={value} checked={checked} onChange={() => onChange(value)} className="mt-px" />
      <span className="min-w-0">
        <b className={cx("block text-[13px] font-extrabold leading-[18px]", checked ? "text-violet-ink" : "text-text")}>
          {title}
        </b>
        {sub ? (
          <small className={cx("block text-caption", checked ? "text-text-2" : "text-muted")}>{sub}</small>
        ) : null}
      </span>
    </label>
  );
}

/**
 * Сегменты: взаимоисключающий выбор на залитой подложке, выбранный — лист с
 * тенью плитки (.seg набора). Кнопки с aria-pressed: это выбор вида, а не
 * навигация по панелям.
 */
export function Segmented<K extends string>({
  items,
  value,
  onChange,
  label,
  wide,
  className,
}: {
  items: { key: K; label: ReactNode }[];
  value: K;
  onChange: (key: K) => void;
  label: string;
  /** Во всю ширину, сегменты поровну */
  wide?: boolean;
  className?: string;
}) {
  return (
    <span
      role="group"
      aria-label={label}
      className={cx("inline-flex gap-0.5 rounded-[12px] bg-sunk p-[3px]", wide && "flex w-full", className)}
    >
      {items.map((it) => {
        const on = it.key === value;
        return (
          <button
            key={it.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(it.key)}
            className={cx(
              "h-8 cursor-pointer rounded-[9px] border-0 px-[11px] text-caption font-bold leading-none",
              "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
              wide && "flex-1",
              on ? "bg-panel text-violet-ink shadow-tile" : "bg-transparent text-text-2 hover:bg-sunk-2 hover:text-text",
              focus,
            )}
          >
            {it.label}
          </button>
        );
      })}
    </span>
  );
}

/* ─────────── разделители и раскладка ─────────── */

/** «Даних поки немає» — одна строка на все графики и сводки */
export function NoData({ className }: { className?: string }) {
  const { ut } = useLang();
  return <p className={cx("m-0 text-small text-muted", className)}>{ut("chart.noData")}</p>;
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cx("m-0 border-0 border-t border-divider", className)} />;
}

/** Строка инструментов над списком: поиск, чипы, действия — переносится, если не помещается */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("flex min-w-0 flex-wrap items-center gap-2", className)}>{children}</div>;
}

export function Spacer() {
  return <span className="flex-1" />;
}

/* ─────────── вкладки ─────────── */

/**
 * Вкладки экрана: ссылки (вкладка в адресе) или переключатель состояния
 * (`onSelect`).
 */
export interface TabItem {
  to?: string;
  label: string;
  end?: boolean;
  /** Вкладка состояния вместо адреса: `onSelect` вместо `to` */
  onSelect?: () => void;
  active?: boolean;
  /** Счётчик в пилюле после подписи */
  count?: number | null;
  /** Для вкладки состояния: свой id и id панели, которой она управляет */
  id?: string;
  controls?: string;
}

/*
 * Вкладка набора (.tab): 36 px, радиус 10, 13.5/600 text-2; выбранная —
 * фиолетовые чернила 800 на плашке листа с тенью плитки. «Вы здесь» несут
 * плашка, начертание и aria-current/aria-selected — не один только цвет.
 */
const tabClass = (isActive: boolean) =>
  cx(
    "relative inline-flex h-9 shrink-0 items-center gap-[7px] whitespace-nowrap rounded-control border-0 px-[13px]",
    "text-body leading-none no-underline hover:no-underline",
    "transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease)]",
    focus,
    isActive
      ? "bg-panel font-extrabold text-violet-ink shadow-tile"
      : "bg-transparent font-semibold text-text-2 hover:bg-tab-hover hover:text-text",
  );

function TabCount({ n }: { n?: number | null }) {
  if (n === undefined || n === null) return null;
  return (
    <span className="inline-grid h-5 min-w-5 place-items-center rounded-[10px] bg-tab-count px-1.5 text-[11.5px] font-bold text-text-2">
      {n}
    </span>
  );
}

export function Tabs({ items, label }: { items: TabItem[]; label?: string }) {
  const bar = "flex flex-wrap items-center gap-1";

  /*
   * Два элемента под одной картинкой. Ссылки — <nav>: они меняют адрес.
   * Кнопки состояния — role="tablist" с role="tab", aria-selected и
   * aria-controls; стрелки ходят по вкладкам, выбирает Enter или пробел.
   */
  if (items.some((t) => t.onSelect)) {
    /* выбранной нет — остановку табуляции принимает первая, иначе полоса выпадает из обхода */
    const none = !items.some((t) => t.active);
    return (
      <div role="tablist" aria-label={label} className={bar} onKeyDown={moveTabFocus}>
        {items.map((t, i) => (
          <button
            key={t.id ?? t.label}
            type="button"
            role="tab"
            id={t.id}
            aria-selected={!!t.active}
            aria-controls={t.controls}
            tabIndex={t.active || (none && i === 0) ? 0 : -1}
            onClick={t.onSelect}
            className={cx("cursor-pointer", tabClass(!!t.active))}
          >
            {t.label}
            <TabCount n={t.count} />
          </button>
        ))}
      </div>
    );
  }

  return (
    <nav aria-label={label} className={bar}>
      {items.map((t) => (
        <NavLink
          key={t.to}
          to={t.to ?? "."}
          end={t.end}
          /* явный признак, а не умолчание чужой библиотеки */
          aria-current="page"
          /* явный `active` сильнее совпадения адреса: вкладка-группа активна на любом своём разделе */
          className={({ isActive }) => tabClass(t.active ?? isActive)}
        >
          {t.label}
          <TabCount n={t.count} />
        </NavLink>
      ))}
    </nav>
  );
}

/** ← → Home End внутри tablist: фокус ходит по вкладкам, не выбирая их */
function moveTabFocus(e: KeyboardEvent<HTMLDivElement>) {
  const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (!step && e.key !== "Home" && e.key !== "End") return;
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (at + step + tabs.length) % tabs.length;
  tabs[next]?.focus();
}
