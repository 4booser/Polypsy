import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { NavLink } from "react-router-dom";
import { createContext, forwardRef, useContext } from "react";
import { cx } from "./cx";
import { useLang } from "../lang";

/*
 * Примитивы консоли на утилитах.
 *
 * Правило, из которого выведены все варианты: янтарным красится только то,
 * что требует внимания. Поэтому у кнопки нет янтарного варианта вовсе — ни
 * «сохранить», ни «применить». Обычное действие бирюзовое, опасное красное,
 * остальное прозрачное. Если однажды понадобится «янтарная кнопка», это
 * значит, что экран сообщает о проблеме не тем способом.
 *
 * Кольцо фокуса — единственное исключение: оно янтарное всегда и везде,
 * потому что «где я сейчас» на клавиатуре и есть то, что требует внимания.
 */

const focus =
  "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]";

/* ─────────── территория пальца ─────────── */

/**
 * Наименьшая мишень для пальца, в пикселях.
 *
 * 44 — не круглое число из чужой методички, а поперечник подушечки
 * указательного пальца взрослого человека на экране телефона. Меньше — и
 * промах перестаёт быть случайностью: нажатие приходится по соседней
 * кнопке либо не регистрируется вовсе.
 */
export const TOUCH_MIN_PX = 44;

/*
 * Пол мишеней объявлен селектором, а не размером каждой кнопки, — и это
 * главное решение здесь.
 *
 * 44 px — свойство МЕСТА, а не элемента. В консоли специалиста плотные
 * таблицы и панели действий: там работают мышью, палец в деле не участвует,
 * и 36 px не только допустимы, а нужны — иначе на экран разбора влезает
 * вдвое меньше строк. В кабинете пациента наоборот: телефон, одна рука,
 * человек в тяжёлом состоянии. Одна и та же кнопка обязана быть разной в
 * двух местах.
 *
 * Пока высоту проставляли руками (`min-h-[44px]` по месту), различие
 * держалось на памяти автора экрана. На Home.tsx и Runner.tsx помнили, на
 * Profile.tsx и Booking.tsx — нет, и разница между экранами кабинета вышла
 * случайной, а не осмысленной. Признака у ошибки не было никакого: ни
 * предупреждения, ни падающей проверки — только рулетка поверх снимка.
 *
 * Зона объявляется один раз на оболочку кабинета и накрывает ВСЁ, что
 * внутри, включая чужие компоненты, до разметки которых отсюда не
 * дотянуться (переключатель языка живёт в lang.tsx и знать о кабинете не
 * обязан). Чтобы получить мишень меньше 44 px, экран теперь нужно вынести
 * из кабинета — то есть забыть нельзя, можно только решить иначе.
 *
 * Правило ставит `min-height`, а не `height`: это пол, а не размер.
 * `min-height` сильнее `height` независимо от специфичности, поэтому h-9
 * внутри зоны становится 44, а 48 остаётся 48. Слой utilities перебивает
 * legacy, где у `:where(button)` стоит min-height 34.
 */
const touchFloor = cx(
  "[&_:is(button,a,summary,[role=button])]:min-h-[44px]",
  "[&_:is(button,a,summary,[role=button])]:min-w-[44px]",
  /* поле ввода растягивать по ширине незачем: оно и так во всю колонку */
  "[&_:is(input,select,textarea)]:min-h-[44px]",
);

/**
 * Внутри зоны мишени меряются пальцем, а поля обязаны иметь подпись.
 *
 * Второе правило здесь же не случайно: зона отмечает экран, который
 * открывает не сотрудник. Сотрудник, наткнувшись на безымянное поле,
 * спросит коллегу; человек с диктором в кабинете не спросит никого — он
 * услышит «поле ввода» и закроет вкладку. Поэтому в зоне безымянное поле
 * считается поломкой и падает при разработке, а не молча доезжает до
 * человека (см. useFieldNameGuard).
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

type Variant = "primary" | "ghost" | "quiet" | "danger";
type Size = "sm" | "md";

const variants: Record<Variant, string> = {
  /*
   * Первичное действие обведено, а не залито.
   *
   * Залитая кнопка — самое яркое пятно на экране, и на экране приёма их
   * несколько сразу: «подписать», «пришёл», «закрепить за собой». Заливка
   * делает главным то, что ближе к курсору, а не то, что важнее; обводка
   * называет действие первичным, не перекрикивая данные, ради которых
   * экран открыт. Заодно акцент остаётся редким — тогда он и работает.
   */
  primary:
    "bg-transparent text-primary border-primary font-medium hover:bg-primary-soft " +
    "active:bg-[color-mix(in_srgb,var(--primary)_22%,transparent)]",
  ghost:
    "bg-transparent text-text border-border hover:bg-surface-3 hover:border-border-strong",
  quiet:
    "bg-transparent text-muted border-transparent hover:bg-surface-3 hover:text-text",
  danger:
    "bg-transparent text-danger border-[color-mix(in_srgb,var(--danger)_45%,transparent)] hover:bg-danger-soft",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-caption gap-1.5",
  md: "h-9 px-3.5 text-small gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Ведущая иконка. Текст остаётся обязательным: иконка без подписи угадывается неверно. */
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", size = "md", icon, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "inline-flex items-center justify-center whitespace-nowrap rounded-sm border font-medium",
        "transition-[background-color,border-color,filter] duration-[var(--dur-fast)] ease-[var(--ease)]",
        "disabled:pointer-events-none disabled:opacity-45",
        sizes[size],
        variants[variant],
        focus,
        className,
      )}
      {...rest}
    >
      {icon ? <span className="[&>svg]:size-4 shrink-0">{icon}</span> : null}
      {children}
    </button>
  );
});

/* ─────────── поверхность ─────────── */

/**
 * Панель — плоскость, а не карточка.
 *
 * Ни тени, ни толстой рамки: на экране разбора двадцать таких блоков, и тени
 * съедают место, которое стоит отдать данным. Отделяет волосяная линия и
 * ступень поверхности.
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
  return (
    <As className={cx("rounded-md border border-hairline bg-surface", className)}>{children}</As>
  );
}

/** Подпись раздела: прописные, разреженные, приглушённые. Не заголовок — указатель. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "text-micro font-semibold uppercase tracking-[var(--tracking-label)] text-faint",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ─────────── число ─────────── */

/**
 * Число, которое читают с расстояния.
 *
 * Моноширинные цифры не ради вида: в столбце баллов разной ширины глаз
 * теряет разряд, и 128 читается как 12.8. `tabular-nums` держит колонку.
 *
 * `null` печатается прочерком, а не нулём. Ноль — это результат, прочерк —
 * его отсутствие, и путать их в клинических данных нельзя.
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
  const toneClass =
    tone === "attention" ? "text-accent" : tone === "danger" ? "text-danger" : "text-text";
  return (
    <div className={cx("flex flex-col gap-0.5", className)}>
      <span className={cx("font-mono text-stat leading-none tabular-nums", toneClass)}>
        {value === null ? "—" : value}
        {unit && value !== null ? <span className="ml-1 text-small text-muted">{unit}</span> : null}
      </span>
      {label ? <span className="text-caption text-muted">{label}</span> : null}
    </div>
  );
}

/** Число внутри строки текста — та же моноширинность, обычный кегль. */
export function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono tabular-nums", className)}>{children}</span>;
}

/* ─────────── метки ─────────── */

export type Severity = "none" | "mild" | "moderate" | "severe";

const severityRing: Record<Severity, string> = {
  none: "border-[var(--sev-none)] text-[var(--sev-none-text)]",
  mild: "border-[var(--sev-mild)] text-[var(--sev-mild-text)]",
  moderate: "border-[var(--sev-moderate)] text-[var(--sev-moderate-text)]",
  severe: "border-[var(--sev-severe)] text-[var(--sev-severe-text)]",
};

const severityDot: Record<Severity, string> = {
  none: "bg-[var(--sev-none)] rounded-full",
  mild: "bg-[var(--sev-mild)] rounded-full",
  /* умеренная — квадрат, тяжёлая — ромб: форма несёт ту же разницу, что цвет */
  moderate: "bg-[var(--sev-moderate)]",
  severe: "bg-[var(--sev-severe)] rotate-45",
};

/**
 * Метка выраженности.
 *
 * Цвет никогда не работает один: рядом всегда стоит подпись, а форма точки
 * меняется вместе со ступенью. Тот, кто не различает красный и зелёный,
 * читает ту же информацию по кругу, квадрату и ромбу.
 */
export function SeverityTag({
  level,
  children,
  className,
}: {
  level: Severity;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-caption",
        severityRing[level],
        className,
      )}
    >
      <span aria-hidden className={cx("size-2 shrink-0", severityDot[level])} />
      {children}
    </span>
  );
}

/** Нейтральная метка: количество, состояние, признак. Не для выраженности. */
export function Tag({
  children,
  tone = "plain",
  className,
}: {
  children: ReactNode;
  tone?: "plain" | "attention" | "danger" | "primary";
  className?: string;
}) {
  const tones = {
    plain: "border-border text-muted",
    attention: "border-[color-mix(in_srgb,var(--accent)_50%,transparent)] bg-accent-soft text-accent",
    danger: "border-[color-mix(in_srgb,var(--danger)_50%,transparent)] bg-danger-soft text-danger",
    primary: "border-[color-mix(in_srgb,var(--primary)_50%,transparent)] bg-primary-soft text-primary",
  } as const;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-caption whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ─────────── поля ввода ─────────── */

const fieldBase = cx(
  "w-full rounded-sm border border-border bg-surface-2 px-2.5 text-small text-text",
  "placeholder:text-faint",
  "transition-colors duration-[var(--dur-fast)]",
  "hover:border-border-strong disabled:opacity-45 disabled:pointer-events-none",
  focus,
);

/**
 * Лежит ли поле внутри подписи Field.
 *
 * Нужен не для вида, а для проверки ниже: сам по себе `<input>` не знает,
 * назвал его кто-нибудь или нет, и узнать это в разметке неоткуда.
 */
const InsideField = createContext(false);

/**
 * Поле без имени — не придирка, а нарушение WCAG 4.1.2: диктор произносит
 * «поле ввода», и человек не знает, что туда писать.
 *
 * Проверка работает только в зоне пальца (кабинет пациента) и только в
 * разработке. Почему не везде: в консоли шесть десятков полей чужих
 * экранов, и падение на них означало бы, что эту защиту снимут в тот же
 * день. Кабинет — единственное место продукта, куда приходит не сотрудник,
 * и цена безымянного поля здесь другая.
 *
 * Почему исключение, а не предупреждение в консоль: предупреждений в
 * консоли браузера десятки, их не читают. Поломка, которую видно сразу,
 * стоит минуту; молчащее поле стоит человеку визита.
 */
function useFieldNameGuard(
  tag: string,
  props: { "aria-label"?: string; "aria-labelledby"?: string; title?: string; placeholder?: string },
) {
  const strict = useContext(TouchZone);
  const named = useContext(InsideField);
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

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    useFieldNameGuard("input", rest);
    return <input ref={ref} className={cx(fieldBase, "h-9", className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    useFieldNameGuard("textarea", rest);
    return <textarea ref={ref} className={cx(fieldBase, "py-2 leading-[var(--lh-normal)]", className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    useFieldNameGuard("select", rest);
    return (
      <select ref={ref} className={cx(fieldBase, "h-9 pr-7 appearance-none", className)} {...rest}>
        {children}
      </select>
    );
  },
);

/**
 * Поле с подписью.
 *
 * Подпись стоит над полем, а не слева: слева она рвёт вертикальный ритм и
 * ломается при длинных формулировках на украинском и английском, где та же
 * мысль занимает в полтора раза больше места.
 *
 * Пояснение печатается всегда под полем — и до ошибки тоже. Подсказка,
 * появляющаяся только вместе с ошибкой, приходит слишком поздно.
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  /**
   * Нужен только когда поле лежит вне подписи. Обычно не нужен: подпись
   * оборачивает поле, и связь получается сама.
   */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    /* data-field — точка опоры для смоук-тестов: класс менять можно, признак нет */
    <div data-field className={cx("flex flex-col gap-1.5", className)}>
      {/*
        Подпись оборачивает поле, а не ссылается на него через htmlFor.

        Ссылка требовала id на каждом поле и htmlFor на каждой подписи, то
        есть двух совпадающих строк в разных местах разметки. Из шестидесяти
        двух полей связь была проставлена у семнадцати: в остальных подпись
        не нажималась и не читалась диктором, а поле оставалось безымянным.
        Забыть при этом нечего не давало никаких признаков — ни ошибки, ни
        предупреждения.

        Обёртка связывает их по построению: id не нужен вовсе, а забыть
        нельзя. htmlFor остался для редкого случая, когда поле физически
        лежит вне подписи.
      */}
      <label htmlFor={htmlFor} className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-text-2">{label}</span>
        {/* поле внутри подписи — уже названо; проверка имени ниже по дереву молчит */}
        <InsideField.Provider value={true}>{children}</InsideField.Provider>
      </label>
      {error ? (
        <span className="text-caption text-danger">{error}</span>
      ) : hint ? (
        <span className="text-caption text-muted">{hint}</span>
      ) : null}
    </div>
  );
}

/* ─────────── разделители и раскладка ─────────── */

/**
 * «Данных пока нет».
 *
 * Одна строка на восемь диаграмм. Раньше она была написана в каждой из них
 * отдельно — восемь одинаковых литералов, которые при переводе пришлось бы
 * находить по одному, и один из них обязательно бы уцелел.
 */
export function NoData({ className }: { className?: string }) {
  const { ut } = useLang();
  return <p className={cx("m-0 text-small text-muted", className)}>{ut("chart.noData")}</p>;
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cx("border-0 border-t border-hairline", className)} />;
}

/** Полоса действий над содержимым: фильтры слева, действия справа. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-wrap items-center gap-2", className)}>{children}</div>
  );
}

export function Spacer() {
  return <span className="flex-1" />;
}

/**
 * Вкладки внутри экрана.
 *
 * Ссылки, а не переключатель состояния: вкладка попадает в адрес, и её
 * можно переслать коллеге, положить в закладку и вернуться на неё кнопкой
 * «назад». Вкладка на состоянии всё это ломает молча — человек присылает
 * ссылку на карту, а открывается она не на том, что он смотрел.
 */
export function Tabs({ items, label }: { items: { to: string; label: string; end?: boolean }[]; label?: string }) {
  /*
   * Это НЕ role="tablist". Здесь ссылки, меняющие адрес, а вкладка в смысле
   * ARIA — переключатель панелей внутри одной страницы, и от него диктор
   * ждёт role="tab" у детей и связанных панелей. Проверка доступности это
   * поймала сразу: tablist со ссылками внутри — нарушение, а не придирка.
   * Раздел навигации <nav> описывает происходящее верно.
   */
  return (
    <nav aria-label={label} className="flex items-center gap-1 border-b border-hairline">
      {items.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cx(
              "relative -mb-px px-3 py-2 text-small",
              "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
              "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
              isActive
                ? "border-b-2 border-primary font-medium text-text"
                : "border-b-2 border-transparent text-muted hover:text-text",
            )
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
