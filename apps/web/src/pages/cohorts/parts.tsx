import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { CohortMember, Severity } from "@quizzy/shared";
import { useLang } from "../../lang";
import { isTopLayer, useFocusTrap } from "../../ui";
import { cx } from "../../ui/cx";
import { IconCaret, IconClose } from "../../ui/glyphs";
import { Button, Input, SeverityTag } from "../../ui/primitives";
import { SEVERITY_LABEL, type BarRow } from "./model";

/*
 * Детали «Добору людей» — и только его.
 *
 * Здесь, а не в ui/: примитивы общего набора правят параллельно другие
 * сборщики, а этому экрану нужны вещи, которых нет больше нигде, — выбор
 * нескольких значений с поиском, переключатель из нескольких вариантов в
 * заливке фильтра, полоски долей. Когда такое понадобится второму экрану,
 * их место — ui/primitives.tsx, и переезжать им недалеко.
 *
 * Все поля здесь — начертание «fill» (заливка #f0ecff без рамки): это поля
 * фильтра, они показывают состояние отбора, а не просят ввода (см.
 * FieldLook в primitives.tsx). Единственное поле формы на экране —
 * «Назва вибірки» — контурное.
 */

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]";
/* кольцо на обёртке, когда фокус у спрятанного поля внутри (радио, флажок) */
const FOCUS_INSIDE = "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--focus)]";

/* ─────────── раздел ─────────── */

/**
 * Раздел экрана: заголовок 20/700 фиолетовым над линией 2px — как разделы
 * карточки пациента (PatientCard, Section). Не панель с рамкой: рамки-
 * карточки — наследие «Пульта», и заказчик прямо назвал экран «не
 * тронутым» именно из-за них.
 */
export function Section({
  title,
  aside,
  children,
  className,
  labelId,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  labelId?: string;
}) {
  return (
    <section aria-labelledby={labelId} className={cx("border-t-2 border-primary-rule pb-[16px] pt-[24px]", className)}>
      <div className="mb-[16px] flex min-h-[27px] flex-wrap items-center justify-between gap-x-[24px] gap-y-[8px]">
        <h2 id={labelId} className="m-0 text-[20px] font-bold leading-[24px] text-primary">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * Группа фильтра: подпись 13/700 серым над полем — «подпись колонки» макета.
 *
 * fieldset/legend, а не div с текстом: у переключателя и диапазона полей
 * несколько, и диктор должен услышать, к чему они относятся, на каждом из
 * них. Браузерные рамка и поля fieldset сняты явно.
 */
export function Group({
  legend,
  hint,
  error,
  children,
  className,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cx("m-0 min-w-0 border-0 p-0", className)}>
      <legend className="mb-[6px] p-0 text-[13px] font-bold leading-[18px] text-muted">{legend}</legend>
      {children}
      {error ? (
        <p role="alert" className="m-0 mt-[4px] text-[13px] leading-[18px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="m-0 mt-[4px] text-[11px] leading-[15px] text-muted">{hint}</p>
      ) : null}
    </fieldset>
  );
}

/* ─────────── переключатель вариантов ─────────── */

const dotShape: Record<Severity, string> = {
  none: "rounded-full bg-[var(--sev-none)]",
  mild: "rounded-full bg-[var(--sev-mild)]",
  /* умеренная — квадрат, тяжёлая — ромб: форма несёт ту же разницу, что цвет (как SeverityTag) */
  moderate: "bg-[var(--sev-moderate)]",
  severe: "rotate-45 bg-[var(--sev-severe)]",
};

/** Точка выраженности — та же форма, что у SeverityTag; цвет никогда не один */
export function SeverityDot({ level, className }: { level: Severity; className?: string }) {
  return <span aria-hidden className={cx("inline-block size-[8px] shrink-0", dotShape[level], className)} />;
}

/**
 * Один вариант из нескольких: стать, вираженість.
 *
 * Настоящие радиокнопки под подписями: стрелки, Tab и «выбрано, 2 из 3»
 * диктору даёт браузер, а не обработчики. Вид — сегменты в заливке
 * фильтра; выбранный — белый лист с фиолетовой подписью: состояние отбора
 * фиолетовым, а не янтарём (янтарь значит «требует внимания»).
 */
export function Segmented<V extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: V;
  options: { value: V; label: string; dot?: Severity }[];
  onChange: (v: V) => void;
}) {
  return (
    <div className="inline-flex max-w-full flex-wrap gap-[2px] rounded-[5px] bg-primary-soft p-[3px]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <label
            key={o.value}
            className={cx(
              /* поля 8: четыре ступени выраженности с точками обязаны встать в колонку фильтров 380 одной строкой */
              "m-0 flex h-[30px] cursor-pointer items-center gap-[6px] rounded-[4px] px-[8px] text-[15px] font-bold leading-none",
              "transition-colors duration-[var(--dur-fast)]",
              on ? "bg-[var(--bg)] text-primary" : "text-primary-dim hover:text-primary",
              FOCUS_INSIDE,
            )}
          >
            <input type="radio" name={name} className="sr-only" checked={on} onChange={() => onChange(o.value)} />
            {o.dot ? <SeverityDot level={o.dot} /> : null}
            {o.label}
          </label>
        );
      })}
    </div>
  );
}

/* ─────────── флажок ─────────── */

/**
 * Флажок с подписью. Квадрат 18 с рамкой #cccccc в 2px и фиолетовым
 * квадратом внутри — та же галочка, что в списке пациентов (PersonGrid),
 * только меньше: там она выбирает строку, здесь — условие в колонке
 * фильтров. Системная птичка не годится: её рисует `accent-color`, а на
 * макете птички нет.
 */
export function Check({
  checked,
  onChange,
  children,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children?: ReactNode;
  /** Имя для диктора, когда видимой подписи нет */
  label?: string;
}) {
  return (
    <label className="m-0 flex min-h-[30px] cursor-pointer items-center gap-[10px] text-[15px] leading-[20px] text-text">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className={cx(
          "grid size-[18px] shrink-0 place-items-center rounded-[4px] border-2 border-border bg-[var(--bg)]",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--focus)] peer-focus-visible:ring-offset-2",
        )}
      >
        {checked ? <span className="size-[10px] rounded-[2px] bg-primary" /> : null}
      </span>
      {children}
    </label>
  );
}

/* ─────────── выбор из списка ─────────── */

/**
 * Выпадающий список в заливке фильтра — с кареткой, которой у общего
 * Select в заливке нет (у него рамка #cccccc). Каретка — значок поверх
 * поля, а не фоновая картинка: фон инлайновым стилем запрещён правилами
 * переноса, а значок — обычная разметка.
 */
export function FillSelect({
  label,
  value,
  onChange,
  children,
  className,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cx("relative min-w-0", className ?? "w-full")}>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          "m-0 h-9 min-h-0 w-full appearance-none truncate rounded-[5px] border-0 bg-primary-soft py-0 pl-[10px] pr-[30px]",
          "text-[16px] text-text disabled:opacity-45",
          FOCUS,
        )}
      >
        {children}
      </select>
      <span aria-hidden className="pointer-events-none absolute right-[12px] top-1/2 flex -translate-y-1/2 text-primary">
        <IconCaret />
      </span>
    </div>
  );
}

/**
 * Несколько значений из списка — подразделения, населённые пункты.
 *
 * Кнопка в силуэте поля показывает выбранное словами («Рота А, Рота Б»), а
 * под ней раскрывается список с флажками и поиском. Прежде подразделения
 * стояли рядом голых чипов во всю ширину — при сорока ротах это полэкрана
 * меток, среди которых выбранные отличались одной рамкой.
 *
 * Поиск появляется, когда вариантов больше восьми: на трёх ротах поле
 * поиска — лишняя остановка табуляции. Выбранные, которых нет среди
 * вариантов (пришли ссылкой из адреса), всё равно видны в списке — иначе
 * снять их было бы нечем.
 */
export function MultiPick({
  label,
  allLabel,
  options,
  value,
  onChange,
  emptyText,
}: {
  label: string;
  /** Что показывает пустой выбор: «усі підрозділи» */
  allLabel: string;
  options: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** Что сказать, когда выбирать не из чего */
  emptyText: string;
}) {
  const { ut } = useLang();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useFocusTrap<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopLayer(ref)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, ref]);

  const all = useMemo(() => [...new Set([...value, ...options])], [value, options]);
  const needle = q.trim().toLowerCase();
  const shown = needle ? all.filter((o) => o.toLowerCase().includes(needle)) : all;
  const summary = value.length ? value.join(", ") : allLabel;

  const toggle = (o: string, on: boolean) => onChange(on ? [...value, o] : value.filter((x) => x !== o));

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${label}: ${summary}`}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          "m-0 flex h-9 min-h-0 w-full items-center gap-[8px] rounded-[5px] border-0 bg-primary-soft py-0 pl-[10px] pr-[12px] text-left",
          "text-[16px] font-normal hover:bg-primary-soft",
          FOCUS,
        )}
      >
        <span className={cx("min-w-0 flex-1 truncate", value.length ? "text-text" : "text-muted")}>{summary}</span>
        {value.length > 1 ? (
          <span className="shrink-0 font-mono text-[13px] tabular-nums text-primary">{value.length}</span>
        ) : null}
        <span aria-hidden className="flex shrink-0 text-primary">
          <IconCaret />
        </span>
      </button>
      {open ? (
        <>
          <div aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div
            ref={ref}
            id={id}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            className={cx(
              "absolute left-0 top-[calc(100%+6px)] z-50 w-full min-w-[260px] rounded-[5px]",
              "border border-border-strong bg-[var(--bg)] p-[10px] shadow-pop",
            )}
          >
            {all.length > 8 ? (
              <div className="mb-[8px]">
                <Input
                  look="fill"
                  ph="plain"
                  aria-label={ut("coh.pickSearch")}
                  placeholder={ut("coh.pickSearch")}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  autoComplete="off"
                  maxLength={120}
                />
              </div>
            ) : null}
            {all.length === 0 ? (
              <p className="m-0 py-[6px] text-[13px] leading-[18px] text-muted">{emptyText}</p>
            ) : shown.length === 0 ? (
              <p className="m-0 py-[6px] text-[13px] leading-[18px] text-muted">{ut("srch.nothing")}</p>
            ) : (
              <ul className="m-0 max-h-[260px] list-none overflow-y-auto p-0">
                {shown.map((o) => (
                  <li key={o}>
                    <Check checked={value.includes(o)} onChange={(on) => toggle(o, on)}>
                      <span className="min-w-0 truncate">{o}</span>
                    </Check>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-[8px] flex items-center justify-between gap-[10px]">
              <Button variant="quiet" disabled={!value.length} onClick={() => onChange([])}>
                {ut("coh.pickClear")}
              </Button>
              <Button onClick={() => setOpen(false)}>{ut("common.close")}</Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ─────────── метки активных условий ─────────── */

/**
 * Метка условия с «×». Вся метка не кнопка: нажимается только крестик —
 * у диктора это «Прибрати: Стать: Чоловіки», а не безымянное «кнопка».
 */
export function FilterTag({ label, onRemove }: { label: string; onRemove: () => void }) {
  const { ut } = useLang();
  return (
    <li className="inline-flex h-[28px] max-w-full items-center gap-[4px] rounded-[4px] bg-primary-soft pl-[8px] pr-[2px] text-[13px] font-bold text-primary">
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        aria-label={`${ut("coh.removeTag")}: ${label}`}
        title={ut("coh.removeTag")}
        onClick={onRemove}
        className={cx(
          "relative m-0 grid size-[24px] min-h-0 shrink-0 place-items-center rounded-[3px] border-0 bg-transparent p-0 text-[13px] text-primary",
          "hover:bg-[var(--bg)]",
          /* мишень 44 — псевдоэлементом, как у глифов Button */
          "after:absolute after:left-1/2 after:top-1/2 after:size-[44px] after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
          FOCUS,
        )}
      >
        <IconClose />
      </button>
    </li>
  );
}

/* ─────────── полоски долей ─────────── */

/**
 * Разбивка полосками: подпись, число, доля и тонкая полоса под ними.
 *
 * Не таблица из двух колонок, как было: по таблице «Рота А 34 / Рота Б 12»
 * соотношение приходится считать в уме, а полоса показывает его сразу.
 * Цифры — моноширинные, чтобы столбец читался, а не прыгал.
 *
 * Выраженность — полоса цветом ступени (sev-*) ВМЕСТЕ с подписью и формой
 * точки: цвет никогда не работает один. Остальные разбивки — фиолетовым,
 * это один ряд, а не категории со своими цветами.
 *
 * Скрытая ячейка — прочерк с подписью «приховано» для диктора и в
 * подсказке, без полосы (см. barRows): тот же знак и то же слово, что в
 * статистике, чтобы «скрыто порогом» читалось одинаково во всей консоли.
 */
export function ShareBars({
  title,
  rows,
  label,
  severity,
  limit = 8,
}: {
  title: string;
  rows: BarRow[];
  label: (key: string) => string;
  /** Ключи — ступени выраженности: полоса цветом ступени и точка формой */
  severity?: boolean;
  /** Сколько строк показать до «ще N» */
  limit?: number;
}) {
  const { ut } = useLang();
  const [all, setAll] = useState(false);
  const id = useId();
  const visible = all ? rows : rows.slice(0, limit);
  const rest = rows.length - visible.length;
  const sev = (key: string): Severity | null => (key in SEVERITY_LABEL ? (key as Severity) : null);
  return (
    <div className="min-w-0">
      <h3 id={id} className="m-0 mb-[10px] text-[15px] font-bold leading-[20px] text-primary">
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">{ut("chart.noData")}</p>
      ) : (
        <ul aria-labelledby={id} className="m-0 flex list-none flex-col gap-[10px] p-0">
          {visible.map((r) => {
            const level = severity ? sev(r.key) : null;
            return (
              <li key={r.key} className="min-w-0">
                <div className="flex items-baseline gap-[10px] text-[13px] leading-[18px]">
                  <span className="flex min-w-0 flex-1 items-center gap-[6px] text-text">
                    {level ? <SeverityDot level={level} /> : null}
                    <span className="truncate">{label(r.key)}</span>
                  </span>
                  {r.count === null ? (
                    <span title={ut("st.hidden")} className="font-mono tabular-nums text-muted">
                      <span aria-hidden>—</span>
                      <span className="sr-only">{ut("st.hidden")}</span>
                    </span>
                  ) : (
                    <>
                      <span className="font-mono tabular-nums text-text">{r.count}</span>
                      <span className="w-[40px] shrink-0 text-right font-mono tabular-nums text-muted">
                        {r.share === null ? "" : `${r.share}%`}
                      </span>
                    </>
                  )}
                </div>
                {/* полоса — рисунок числа рядом; диктору хватает числа */}
                <div aria-hidden className="mt-[4px] h-[4px] rounded-[2px] bg-primary-soft">
                  {r.width !== null && r.width > 0 ? (
                    <div
                      className={cx("h-full rounded-[2px]", level ? SEV_BAR[level] : "bg-primary")}
                      style={{ width: `${Math.max(2, Math.round(r.width * 100))}%` }}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > limit ? (
        <Button variant="quiet" className="mt-[6px] -ml-[14px]" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? ut("coh.less") : `${ut("coh.more")} ${rest}`}
        </Button>
      ) : null}
    </div>
  );
}

const SEV_BAR: Record<Severity, string> = {
  none: "bg-[var(--sev-none)]",
  mild: "bg-[var(--sev-mild)]",
  moderate: "bg-[var(--sev-moderate)]",
  severe: "bg-[var(--sev-severe)]",
};

/* ─────────── поимённый список ─────────── */

/**
 * Человек когорты — строка в манере списка пациентов (PersonGrid, f05):
 * имя 13/700 фиолетовым ссылкой на карточку, под ним мета серым, справа
 * галочка выбора. Третья строка — последнее прохождение выборки: метка
 * выраженности, методика и день; ссылка ведёт в само прохождение.
 *
 * Две колонки, а не три, как в списке пациентов: у строки подбора на одну
 * строчку больше, и в трети колонки 1200 метка с названием методики
 * обрезалась бы на первом же длинном названии.
 */
export function MemberList({
  people,
  selected,
  onToggle,
  surveyTitle,
  dayOf,
}: {
  people: CohortMember[];
  selected: ReadonlySet<string>;
  onToggle: (userId: string) => void;
  surveyTitle: (id: string) => string | undefined;
  dayOf: (iso: string) => string;
}) {
  const { ut } = useLang();
  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-x-[44px] p-0 max-[900px]:grid-cols-1">
      {people.map((p) => {
        const meta = [
          p.email,
          p.unit,
          p.locality,
          p.sex === "male" ? ut("adm.male") : p.sex === "female" ? ut("adm.female") : null,
          p.birthYear ? `${p.birthYear}${ut("pg.yearSuffix")}` : null,
        ].filter(Boolean) as string[];
        return (
          <li
            key={p.userId}
            className={cx(
              "-ml-[4px] flex min-h-[66px] items-center gap-[10px] rounded-[4px] py-[6px] pl-[4px]",
              "has-[a:hover]:bg-primary-tint has-[a:focus-visible]:bg-primary-tint",
              selected.has(p.userId) && "bg-primary-tint",
            )}
          >
            <div className="min-w-0 flex-1">
              <Link
                to={`/patients/${p.userId}`}
                className="block truncate text-[13px] font-bold leading-[18px] text-primary no-underline hover:underline"
              >
                {p.fullName}
              </Link>
              <div className="flex gap-[10px] overflow-hidden text-[13px] leading-[18px] text-muted">
                {meta.map((m, i) => (
                  <span key={i} className="truncate">
                    {m}
                  </span>
                ))}
              </div>
              {p.last ? (
                <div className="mt-[3px] flex min-w-0 items-center gap-[8px] text-[13px] leading-[18px] text-muted">
                  {p.last.severity ? (
                    <SeverityTag level={p.last.severity} className="shrink-0 py-0">
                      {ut(SEVERITY_LABEL[p.last.severity])}
                    </SeverityTag>
                  ) : null}
                  <Link
                    to={`/surveys/${p.last.surveyId}/responses/${p.last.responseId}`}
                    className="min-w-0 truncate text-muted no-underline hover:text-primary hover:underline"
                  >
                    {surveyTitle(p.last.surveyId) ?? ut("coh.lastResult")}
                    {p.last.submittedAt ? ` · ${dayOf(p.last.submittedAt)}` : ""}
                  </Link>
                </div>
              ) : null}
            </div>
            <label className="m-0 grid size-[44px] shrink-0 cursor-pointer place-items-center">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={selected.has(p.userId)}
                onChange={() => onToggle(p.userId)}
                aria-label={`${ut("pg.select")}: ${p.fullName}`}
              />
              <span
                aria-hidden
                className={cx(
                  "grid size-[22px] place-items-center rounded-[4px] border-2 border-border bg-[var(--bg)]",
                  "peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--focus)] peer-focus-visible:ring-offset-2",
                )}
              >
                {selected.has(p.userId) ? <span className="size-[12px] rounded-[2px] bg-primary" /> : null}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
