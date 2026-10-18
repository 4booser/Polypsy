import {
  forwardRef,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useLang } from "../../lang";
import { ShellIcon } from "../../shell/icons";
import { Callout } from "../../ui";
import { cx } from "../../ui/cx";
import { ErrorText, Input, type InputProps } from "../../ui/primitives";
import { AccessIcon } from "./accessIcons";

/*
 * Детали гостевых экранов и ворот входа (набор «Виразна», access.py): лист
 * формы, строка «или», поле пароля с глазом, шесть клеток кода, строка
 * «кто входит», полоса с объяснением справа и кризисная строка.
 *
 * Общие для входа, второго шага, смены временного пароля, настройки второго
 * фактора, приглашения и возврата от Google — одна мера на все шесть экранов.
 */

/**
 * Строка словаря с подстановками-узлами: «Лайфлайн Україна {hotline}» →
 * текст и жирный номер ссылкой. Порядок слов задаёт словарь, а не разметка:
 * на трёх языках номер стоит в разных местах фразы.
 */
export function rich(template: string, vars: Record<string, ReactNode>): ReactNode[] {
  return template.split(/(\{\w+\})/g).map((part, i) => {
    const key = /^\{(\w+)\}$/.exec(part)?.[1];
    return key && key in vars ? <span key={i}>{vars[key]}</span> : part;
  });
}

/** Подстановка строк: «Увійти можна о {time}» */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/**
 * Лист формы (.auth набора): 440 по ширине, поля 28, радиус 18, тень полосы.
 * На узком окне — во всю колонку с полями поменьше.
 */
export function AuthCard({
  children,
  labelledBy,
  className,
}: {
  children: ReactNode;
  labelledBy?: string;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={cx(
        "w-full min-w-0 rounded-drawer border border-border bg-panel px-7 pb-[26px] pt-7 shadow-banner",
        "max-[520px]:px-5 max-[520px]:pt-6",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function AuthTitle({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <h1 id={id} className={cx("m-0 text-[26px] font-extrabold leading-8 tracking-[-0.025em] text-text", className)}>
      {children}
    </h1>
  );
}

export function AuthLead({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx("m-0 mt-1.5 text-[14px] leading-[21px] text-text-2", className)}>{children}</p>;
}

/** «або поштою й паролем» — подпись между двумя волосяными линиями */
export function OrLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "my-[18px] flex items-center gap-3 whitespace-nowrap text-small font-semibold text-muted",
        "before:h-px before:flex-1 before:bg-divider before:content-[''] after:h-px after:flex-1 after:bg-divider after:content-['']",
        className,
      )}
    >
      {children}
    </div>
  );
}

/*
 * Крупное поле гостевых экранов (48, радиус 12, 15) — те же Input набора,
 * только выше. Кегль задаётся и самому <input> ([&_input]): у поля со значком набор рисует
 * коробку, а внутренний <input> берёт размер из слоя наследия (--fs-small),
 * а не от коробки. Обход на месте; в наборе это стоит поправить один раз.
 */
export const tallField = "!h-12 !rounded-[12px] !text-[15px] [&_input]:!text-[15px]";
/** То же поле в регистре пациента: 48 и 16 по тексту */
export const patientField = "!h-12 !rounded-[12px] !text-[16px] [&_input]:!text-[16px]";

/**
 * Поле пароля: значок замка слева, «показать / скрыть» справа.
 *
 * Глаз — кнопка с aria-pressed и именем действия: диктору «показать пароль»
 * важнее, чем вид значка. Поле остаётся полем пароля для менеджера паролей
 * и автозаполнения — меняется только тип ввода на время показа.
 */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<InputProps, "type" | "icon" | "suffix"> & { patient?: boolean }
>(function PasswordInput({ className, disabled, patient, ...rest }, ref) {
    const { ut } = useLang();
    const [shown, setShown] = useState(false);
    const tip = shown ? ut("ax.lg.hide") : ut("ax.lg.show");
    return (
      <Input
        ref={ref}
        type={shown ? "text" : "password"}
        disabled={disabled}
        icon={<AccessIcon name="lock-keyhole" size={16} />}
        className={cx(patient ? patientField : tallField, "!pr-1.5", className)}
        suffix={
          <button
            type="button"
            aria-label={tip}
            title={tip}
            aria-pressed={shown}
            disabled={disabled}
            onClick={() => setShown((s) => !s)}
            className={cx(
              "grid size-[34px] min-h-0 cursor-pointer place-items-center rounded-[9px] border-0 bg-transparent p-0 text-muted",
              "hover:bg-sunk hover:text-text aria-pressed:text-violet-ink disabled:cursor-not-allowed disabled:opacity-60",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]",
            )}
          >
            <AccessIcon name={shown ? "eye-off" : "eye"} size={16} />
          </button>
        }
        {...rest}
      />
    );
});

/**
 * Поле пароля с подписью — как Field набора, только подпись стоит рядом с
 * полем, а не вокруг него.
 *
 * Field оборачивает поле в <label>, а у пароля внутри есть своя кнопка
 * «Показати пароль». Внутри подписи её имя вошло бы в имя поля — диктор читал
 * бы «Новий пароль Показати пароль». Поэтому здесь <label for>, а пояснение
 * и отказ связаны с полем через aria-describedby, как у Field.
 */
export function PasswordField({
  label,
  labelClassName,
  hint,
  error,
  className,
  ...input
}: {
  label: ReactNode;
  labelClassName?: string;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
} & Omit<InputProps, "type" | "icon" | "suffix"> & { patient?: boolean }) {
  const id = useId();
  const noteId = error || hint ? `${id}-note` : undefined;
  return (
    <div data-field className={cx("flex min-w-0 flex-col", className)}>
      <label htmlFor={id} className={labelClassName ?? "mb-1.5 block text-caption font-bold text-muted"}>
        {label}
      </label>
      <PasswordInput id={id} aria-describedby={noteId} aria-invalid={error ? true : undefined} {...input} />
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

/**
 * Строка «кто входит» (.who-row): кружок или знак, имя, строка под ним и
 * хвост справа — отметка «пароль прийнято» или «Вийти».
 */
export function WhoRow({
  lead,
  title,
  sub,
  aside,
  className,
}: {
  lead: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex min-w-0 items-center gap-3 rounded-panel bg-sunk px-3 py-2.5", className)}>
      {lead}
      <span className="flex min-w-0 flex-1 flex-col">
        <b className="truncate text-body font-extrabold leading-[18px] text-text">{title}</b>
        {sub ? <small className="truncate text-caption leading-4 text-muted">{sub}</small> : null}
      </span>
      {aside ? <span className="shrink-0">{aside}</span> : null}
    </div>
  );
}

/**
 * Кому звонить, если плохо сейчас: Лайфлайн Україна и 103. Номера —
 * ссылками tel: (на телефоне по ним нажимают), 103 — цветом риска: это
 * единственная строка про угрозу жизни.
 */
export function CrisisNote({
  template,
  title,
  actions,
  className,
}: {
  /** Строка словаря с {hotline} и {emergency} */
  template: string;
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const { ut } = useLang();
  const hotline = ut("home.hotlineNumber");
  const emergency = ut("pt.emergencyNumber");
  return (
    <Callout
      kind="violet"
      icon={<ShellIcon name="life-buoy" size={16} />}
      title={title}
      actions={actions}
      className={className}
    >
      <p className="m-0 leading-[18px]">
        {rich(template, {
          hotline: (
            <a href={`tel:${hotline}`} className="font-extrabold text-text no-underline hover:underline">
              {hotline}
            </a>
          ),
          emergency: (
            <a href={`tel:${emergency}`} className="font-extrabold text-risk-ink no-underline hover:underline">
              {emergency}
            </a>
          ),
        })}
      </p>
    </Callout>
  );
}

/**
 * Шесть клеток кода из приложения (.otp набора): три и три через чёрточку.
 *
 * Значение — строка до шести цифр, клетки только показывают её по одной.
 * Набор цифры ведёт к следующей клетке, Backspace в пустой — к предыдущей,
 * стрелки — по клеткам. Вставка кода целиком (и подсказка телефона в первой
 * клетке, autocomplete=one-time-code) раскладывается по клеткам сама.
 */
export function OtpInput({
  value,
  onChange,
  label,
  disabled,
  ok,
  small,
  autoFocus,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  disabled?: boolean;
  /** Код принят: клетки зелёные */
  ok?: boolean;
  small?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  const { ut } = useLang();
  const cells = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.replace(/\D/g, "").slice(0, 6);
  const focusAt = (i: number) => cells.current[Math.max(0, Math.min(5, i))]?.focus();

  const put = (at: number, text: string) => {
    const incoming = text.replace(/\D/g, "");
    if (!incoming) return;
    const next = (digits.slice(0, at) + incoming).slice(0, 6);
    onChange(next);
    focusAt(next.length >= 6 ? 5 : next.length);
  };

  const onKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (digits[i]) onChange(digits.slice(0, i) + digits.slice(i + 1));
      else if (i > 0) {
        onChange(digits.slice(0, i - 1) + digits.slice(i));
        focusAt(i - 1);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusAt(i - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focusAt(i + 1);
    }
  };

  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    put(i, e.clipboardData.getData("text"));
  };

  return (
    <div role="group" aria-label={label} className={cx("flex items-center", small ? "gap-1.5" : "gap-2", className)}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <span key={i} className="contents">
          {i === 3 ? <span aria-hidden className="h-0.5 w-2.5 shrink-0 rounded-[1px] bg-field-border" /> : null}
          <input
            ref={(el) => {
              cells.current[i] = el;
            }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={i === 0 ? "one-time-code" : "off"}
            aria-label={fill(ut("ax.mfa.digit"), { n: i + 1 })}
            autoFocus={autoFocus && i === 0}
            disabled={disabled}
            value={digits[i] ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              /* одна цифра — в свою клетку; больше одной — подсказка телефона или вставка */
              if (v.replace(/\D/g, "").length > 1) put(i, v);
              else if (/\d/.test(v)) put(i, v.replace(/\D/g, "").slice(-1));
            }}
            onKeyDown={(e) => onKey(i, e)}
            onPaste={(e) => onPaste(i, e)}
            onFocus={(e) => e.target.select()}
            className={cx(
              "min-h-0 shrink-0 border p-0 text-center font-extrabold tabular-nums text-text outline-none",
              "caret-[var(--vring)] transition-[border-color,box-shadow] duration-[var(--dur-fast)]",
              small ? "h-[52px] w-11 rounded-[11px] text-[22px]" : "h-[60px] w-[52px] rounded-[12px] text-[26px]",
              "max-[420px]:h-[52px] max-[420px]:w-10 max-[420px]:text-[22px]",
              ok
                ? "border-good-line bg-good-tint text-good"
                : "border-field-border bg-panel hover:border-muted focus:border-violet-ring focus:shadow-[0_0_0_3px_var(--vtint)]",
              "disabled:cursor-not-allowed disabled:bg-sunk",
            )}
          />
        </span>
      ))}
    </div>
  );
}

/**
 * Полоса с объяснением справа от формы (.aside-b): лист полосы, крупный
 * заголовок и строка под ним. Внутри — один кусок продукта или советы.
 */
export function BandAside({
  title,
  lead,
  children,
  className,
  center,
}: {
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  className?: string;
  center?: boolean;
}) {
  return (
    <aside
      className={cx(
        "min-w-0 rounded-[24px] border border-band-card-line bg-band px-9 pb-[34px] pt-8 max-[700px]:px-6",
        center && "flex flex-col items-center text-center",
        className,
      )}
    >
      <h2 className="m-0 max-w-[560px] text-[26px] font-extrabold leading-8 tracking-[-0.025em] text-text [text-wrap:balance]">
        {title}
      </h2>
      {lead ? <p className="m-0 mt-2 max-w-[580px] text-[14px] leading-[21px] text-text-2">{lead}</p> : null}
      {children}
    </aside>
  );
}

/** Строка совета на полосе: квадрат значка на листе полосы, жирное начало, пояснение */
export function NoteRow({ icon, title, children }: { icon: ReactNode; title: ReactNode; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[36px_minmax(0,1fr)] items-start gap-3 text-[13px] leading-[19px] text-text-2">
      <span
        aria-hidden
        className="grid size-9 place-items-center rounded-[11px] bg-band-card text-violet-ink shadow-[inset_0_0_0_1px_var(--bcardline)]"
      >
        {icon}
      </span>
      <span>
        <b className="block text-[14px] font-extrabold leading-5 text-text">{title}</b>
        {children}
      </span>
    </li>
  );
}

/** Строка факта (.fct): значок цвета бренда, жирное начало, пояснение */
export function FactRow({ icon, title, children }: { icon: ReactNode; title: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-small leading-[17px] text-text-2">
      <span aria-hidden className="mt-px inline-flex text-violet-ink">
        {icon}
      </span>
      <span>
        <b className="block text-[13px] font-extrabold leading-[18px] text-text">{title}</b>
        {children}
      </span>
    </li>
  );
}
