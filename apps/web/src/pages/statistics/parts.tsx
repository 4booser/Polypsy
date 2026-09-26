import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import type { PatientGroupWithCounts, SampleFilters, Sex, StatCell } from "@quizzy/shared";
import { api, type Patient } from "../../api";
import { useLang } from "../../lang";
import { isTopLayer, useFocusTrap } from "../../ui";
import { cx } from "../../ui/cx";
import { Button } from "../../ui/primitives";
import { HIDDEN_MARK, cellText } from "./model";

/*
 * Детали раздела «Статистика», общие для его экранов, — и только для них.
 *
 * Здесь, а не в ui/: у кадров статистики свой набор полей, которого нет
 * больше нигде. Подпись внутри поля набрана 16/700 фиолетовым (f09, f23,
 * f29: капитель «Н» в «Назва тесту» — 11px, ширина слова 88 против 86 у того
 * же слова 17/400 на f17), тогда как общий Input держит 17/700 — и
 * переопределить кегль плейсхолдера классом снаружи нельзя: два
 * `placeholder:text-[…]` в одной строке классов спорят, и кто победит,
 * решает порядок в собранном CSS. Отвергнуто: добавлять в общий Input
 * третий вид подписи ради одного раздела — общий модуль правят параллельно
 * другие сборщики, а кадры остальных разделов этого кегля не просят.
 */

/* ─────────── глифы ─────────── */

/**
 * «−» карточки блока (f17) и строки фильтра (f23): штрих 5 в квадрате 27 —
 * близнец IconPlusThick (ui/glyphs.tsx), замер f17: чернила 1124…1150 × 265…269.
 * Локально, а не в glyphs.tsx: новых общих модулей волна не заводит.
 */
export function IconMinusThick() {
  return (
    <svg viewBox="0 0 27 27" width={27} height={27} aria-hidden focusable="false">
      <path d="M2.5 13.5h22" stroke="currentColor" strokeWidth={5} />
    </svg>
  );
}

/**
 * Вид «діаграма» строки заголовка f08: квадрат 27 с радиусом 3 и четыре
 * столбика. Замер f08 — рамка 1342…1368 × 153…179, столбики по чернилам
 * (x 7…10, 12…14, 17…19, 21…24 от левого края; верхушки 14, 10, 5, 14).
 */
export function IconViewChart() {
  return (
    <svg viewBox="0 0 27 27" width={27} height={27} aria-hidden focusable="false" fill="none">
      <rect x="1.25" y="1.25" width="24.5" height="24.5" rx="3" stroke="currentColor" strokeWidth={1.5} />
      <g fill="currentColor">
        <rect x="7" y="13.5" width="3" height="10" rx="1.5" />
        <rect x="11.75" y="9" width="3" height="14.5" rx="1" />
        <rect x="16.5" y="4.5" width="3" height="19" rx="1" />
        <rect x="21" y="13.5" width="3" height="10" rx="1.5" />
      </g>
    </svg>
  );
}

/**
 * Вид «перелік»: тот же квадрат, четыре строки «точка + черта» с шагом 4,5
 * (замер f08: 1382…1408, строки 158, 163, 167, 172).
 */
export function IconViewList() {
  return (
    <svg viewBox="0 0 27 27" width={27} height={27} aria-hidden focusable="false" fill="none">
      <rect x="1.25" y="1.25" width="24.5" height="24.5" rx="3" stroke="currentColor" strokeWidth={1.5} />
      <g fill="currentColor">
        {[5.5, 10, 14.5, 19].map((y) => (
          <g key={y}>
            <rect x="5" y={y} width="3" height="2.5" rx="1" />
            <rect x="9.5" y={y} width="13" height="2.5" rx="1" />
          </g>
        ))}
      </g>
    </svg>
  );
}

/* ─────────── поля ─────────── */

/**
 * Три начертания поля на кадрах раздела.
 *
 *   outline — f09/f18: рамка #666666, подпись 16/700 фиолетовым, отступ 10;
 *   fill    — f23/f29: заливка #f0ecff без рамки, та же подпись, отступ 8
 *             (чернила «Дата» на f29 — 223 при левом крае поля 215);
 *   plain   — f17: рамка #666666, подпись 17/400 серым (ph="plain" общего
 *             Input) — форма, где поле ещё только просит ввода.
 */
export type Look = "outline" | "fill" | "plain";

const SHELL: Record<Look, string> = {
  outline: "border border-field-border bg-[var(--bg)] px-[10px]",
  fill: "border-0 bg-primary-soft px-[8px]",
  plain: "border border-field-border bg-[var(--bg)] px-[10px]",
};

/**
 * Подпись поля — то, что видно в пустом поле. У текстовых полей она стоит
 * и в заполненном — слева от значения (см. StatInput); плейсхолдеров в
 * разделе больше нет, и их начертание здесь не заводится.
 */
export const LABEL: Record<Look, string> = {
  outline: "text-[16px] font-bold text-primary",
  fill: "text-[16px] font-bold text-primary",
  plain: "text-[17px] font-normal text-muted",
};

/** Набранное — данные, а не подпись: обычным начертанием, иначе заполненное не отличить от пустого */
const VALUE: Record<Look, string> = {
  outline: "text-[16px] font-normal text-text",
  fill: "text-[16px] font-normal text-text",
  plain: "text-[17px] font-normal text-text",
};

/** То же начертание красным — перевёрнутый диапазон; цвет не один: рядом строка ошибки и aria-invalid */
const VALUE_INVALID: Record<Look, string> = {
  outline: "text-[16px] font-normal text-danger",
  fill: "text-[16px] font-normal text-danger",
  plain: "text-[17px] font-normal text-danger",
};

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]";
/* кольцо на силуэте, когда фокус у поля внутри подписи */
const FOCUS_WITHIN = "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--focus)]";

/** Силуэт поля: 36 высотой, радиус 5 — общее у всех трёх начертаний */
export function shell(look: Look, extra?: string): string {
  return cx("flex h-9 min-w-0 items-center rounded-[5px]", SHELL[look], extra);
}

/*
 * Поле внутри силуэта: браузерные и наследные рамка, заливка и поля сняты —
 * силуэт рисует обёртка-подпись.
 */
const BARE_INPUT = "m-0 h-full min-h-0 w-full min-w-0 flex-1 border-0 bg-transparent p-0 outline-none";

/**
 * Текстовое поле с подписью внутри.
 *
 * Имя полю — aria-label тем же текстом, что стоит в подписи: подписи над
 * полем на кадрах нет. Видимое слово входит в звучащее целиком (WCAG 2.5.3).
 *
 * Решение заказчика 2026-09-26: адекватные фильтры. Подпись стоит в поле
 * ВСЕГДА, а не плейсхолдером: плейсхолдер исчезал при наборе, и заполненная
 * форма читалась как «25 — 45 · Київ» без единого слова о том, что это
 * возраст и город. Пустое поле выглядит ровно как на кадре — подпись
 * 16/700 фиолетовым у левого края; заполненное — «Вік від 25». Отвергнуто:
 * подпись над полем — у кадров раздела её нет, и строки формы разъехались
 * бы на шаг по вертикали.
 */
export function StatInput({
  look,
  label,
  className,
  invalid,
  ...rest
}: { look: Look; label: string; invalid?: boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, "placeholder">) {
  return (
    <label className={cx(shell(look), "m-0 w-full cursor-text gap-[8px]", FOCUS_WITHIN, className)}>
      <span aria-hidden className={cx("shrink-0 whitespace-nowrap", LABEL[look])}>
        {label}
      </span>
      <input
        aria-label={label}
        aria-invalid={invalid || undefined}
        className={cx(BARE_INPUT, invalid ? VALUE_INVALID[look] : VALUE[look])}
        {...rest}
      />
    </label>
  );
}

/**
 * Выбор в силуэте поля — без каретки: на кадрах (f09 «Стать», f17 «Варіант
 * результату») в правой трети поля нет ни одного пикселя, как и у `bare`
 * общего Select.
 *
 * Пустой выбор показывает подпись поля её же начертанием; выбранный —
 * начертанием данных. Класс собирается одной веткой, а не наложением
 * второго цвета поверх первого: два `text-*` в одной строке классов спорят.
 */
export function StatSelect({
  look,
  label,
  value,
  onChange,
  children,
  className,
  disabled,
}: {
  look: Look;
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cx(
        shell(look),
        /*
         * Ширина — либо своя от места, либо «во всю строку», но не обе
         * сразу. Прежде `w-full` стоял всегда, а место добавляло
         * `w-[96px]`: два правила ширины в одной строке классов спорят, и
         * победил `w-full` — «Стать» растягивалась на всю строку, а
         * «Населений пункт» справа сжимался до сиреневого огрызка в 10px.
         */
        className ?? "w-full",
        "appearance-none truncate disabled:opacity-45",
        value ? VALUE[look] : LABEL[look],
        FOCUS,
      )}
    >
      <option value="">{label}</option>
      {children}
    </select>
  );
}

/**
 * Показ значения в силуэте поля: название теста, подпись полосы, текст
 * вопроса, доля ответов. Не поле: править здесь нечего, и остановка
 * табуляции на каждой строке отчёта была бы шумом.
 *
 * Пустое — подпись с кадра («Варіант результату 1»), заполненное — данные
 * тем же начертанием: на f09/f29 эти поля показывают, а не просят. Диктору
 * подпись читается всегда (скрытой приставкой), иначе «Низький, 42%» без
 * «Варіант результату» не читается как строка отчёта.
 */
export function Readout({
  look,
  label,
  text,
  className,
  align = "start",
  title,
  pending,
}: {
  look: Look;
  label: string;
  text?: ReactNode;
  className?: string;
  align?: "start" | "center";
  title?: string;
  /**
   * Значение ещё не посчитано: плашка пустая, подпись — только диктору.
   *
   * Решение заказчика 2026-09-26 (замечание со стенда): подписи «Відсоток
   * відповідей 1…4» в пустых плашках до расчёта читались как данные или
   * поломка. Прочерк здесь не годится — в разделе он значит «приховано
   * порогом», и один знак с двумя смыслами путал бы именно тогда, когда
   * важно не путать. Что делать, чтобы плашки заполнились, говорит одна
   * строка под отчётом (st.percentPending).
   */
  pending?: boolean;
}) {
  const empty = text === undefined || text === null || text === "";
  return (
    <div
      title={title}
      className={cx(shell(look), LABEL[look], align === "center" && "justify-center", className)}
    >
      {empty && pending ? (
        <span className="sr-only">{label}</span>
      ) : empty ? (
        <span className="truncate">{label}</span>
      ) : (
        <span className="truncate">
          <span className="sr-only">{label}: </span>
          {text}
        </span>
      )}
    </div>
  );
}

/**
 * Ячейка отчёта: «42%» или прочерк.
 *
 * Прочерк несёт подпись «приховано» для диктора и в подсказке: знак «—» сам
 * по себе читается как «нет данных», а данные есть — сервер их не печатает,
 * потому что вместе с соседними числами они называют людей.
 */
export function CellText({ cell }: { cell: StatCell | null | undefined }) {
  const { ut } = useLang();
  const text = cellText(cell);
  if (text !== HIDDEN_MARK) return <>{text}</>;
  return (
    <span title={ut("st.hidden")}>
      <span aria-hidden>{HIDDEN_MARK}</span>
      <span className="sr-only">{ut("st.hidden")}</span>
    </span>
  );
}

/**
 * «ВШР» — пометка «високий ступінь ризику» на варианте ответа, кнопкой с
 * состоянием (aria-pressed). Нажатая — фиолетовым полужирным (так все «ВШР»
 * набраны на f09/f29), отпущенная — серым обычным (так пустая форма f17).
 * Цвет тут не единственный признак: меняется и начертание.
 */
export function VshrToggle({
  look,
  pressed,
  onToggle,
  className,
  align = "center",
}: {
  look: Look;
  pressed: boolean;
  onToggle: () => void;
  className?: string;
  align?: "start" | "center";
}) {
  const { ut } = useLang();
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={ut("st.vshrLong")}
      onClick={onToggle}
      className={cx(
        shell(look),
        align === "center" ? "justify-center" : "justify-start",
        pressed ? LABEL.outline : LABEL.plain,
        FOCUS,
        className,
      )}
    >
      {/* видимое слово входит в имя целиком (WCAG 2.5.3): голосом говорят «ВШР», а не расшифровку */}
      {ut("st.vshr")}
      <span className="sr-only"> — {ut("st.vshrLong")}</span>
    </button>
  );
}

/** Голый глиф «+»/«−» с областью нажатия 44 — Button size="glyph" */
export function GlyphButton({
  label,
  onClick,
  children,
  disabled,
  className,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    /*
     * Подсказка при наведении — то же слово, что у диктора: «−» у названия
     * пресета удаляет пресет целиком, и мышью об этом узнавали только из
     * окна подтверждения.
     */
    <Button
      size="glyph"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={className}
    >
      {children}
    </Button>
  );
}

/* ─────────── строки фильтра ─────────── */

/** «2026-09-01» → «01.09.2026»: дата выборки — день, без времени и пояса */
export function dayText(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}.${m}.${y}` : iso;
}

/** Период строкой: оба конца, один или ни одного */
export function periodText(from?: string | null, to?: string | null): string {
  if (from && to) return `${dayText(from)} – ${dayText(to)}`;
  if (from) return `${dayText(from)} –`;
  if (to) return `– ${dayText(to)}`;
  return "";
}

/**
 * «Дата» — одно поле на кадрах, а у выборки два конца периода.
 *
 * Поле показывает период строкой и раскрывает под собой два штатных поля
 * даты «Від / До». Отвергнуто: два поля в строке — на кадре их одно, и ряд
 * «Дата» с двумя половинами встал бы вразрез с рядом «Вік від — Вік до»,
 * где половины нарисованы; отвергнуто и одно поле текстом «01.09 – 30.09»
 * с разбором — ошибка набора молча становилась бы другим периодом.
 */
export function DateField({
  look,
  from,
  to,
  onChange,
  invalid,
}: {
  look: Look;
  from?: string | null;
  to?: string | null;
  onChange: (next: { from: string | null; to: string | null }) => void;
  /** Начало позже конца — период печатается красным, строка ошибки — у места */
  invalid?: boolean;
}) {
  const { ut } = useLang();
  const id = useId();
  const [open, setOpen] = useState(false);
  const ref = useFocusTrap<HTMLDivElement>(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopLayer(ref)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, ref]);
  const text = periodText(from, to);
  return (
    <div className="relative min-w-0 flex-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={text ? `${ut("st.date")}: ${text}` : ut("st.date")}
        aria-invalid={invalid || undefined}
        onClick={() => setOpen((v) => !v)}
        /* m-0, min-h-0, border-0: у кнопки в слое наследия свои поля, высота и рамка */
        className={cx(shell(look), "m-0 min-h-0 w-full gap-[8px] text-left", FOCUS)}
      >
        {/* подпись остаётся и у заполненного поля — см. StatInput */}
        <span className={cx("shrink-0", LABEL[look])}>{ut("st.date")}</span>
        {text ? <span className={cx("truncate", invalid ? VALUE_INVALID[look] : VALUE[look])}>{text}</span> : null}
      </button>
      {open ? (
        <>
          <div aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div
            ref={ref}
            id={id}
            role="dialog"
            aria-label={ut("st.date")}
            tabIndex={-1}
            className={cx(
              "absolute left-0 top-[calc(100%+6px)] z-50 flex items-end gap-[15px] rounded-[5px]",
              "border border-border-strong bg-[var(--bg)] p-[10px] shadow-pop",
            )}
          >
            {(
              [
                ["from", "st.dateFrom", from],
                ["to", "st.dateTo", to],
              ] as const
            ).map(([key, labelKey, value]) => (
              <label key={key} className="flex flex-col gap-[4px] text-[13px] text-muted">
                {ut(labelKey)}
                <input
                  type="date"
                  value={value ?? ""}
                  max={key === "from" ? (to ?? undefined) : undefined}
                  min={key === "to" ? (from ?? undefined) : undefined}
                  onChange={(e) =>
                    onChange({
                      from: key === "from" ? e.target.value || null : (from ?? null),
                      to: key === "to" ? e.target.value || null : (to ?? null),
                    })
                  }
                  className={cx(shell("outline"), VALUE.outline, FOCUS)}
                />
              </label>
            ))}
            {/* снять период одним нажатием, а не стирать два поля по очереди */}
            {from || to ? (
              <Button size="sm" variant="quiet" onClick={() => onChange({ from: null, to: null })}>
                {ut("st.clearDate")}
              </Button>
            ) : null}
            <Button size="sm" onClick={() => setOpen(false)}>
              {ut("common.close")}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * «Пацієнт» — поиск человека по имени в зоне видимости сотрудника.
 *
 * Список под полем — те же люди, что в разделе «Пацієнти» (GET
 * /api/access/patients): сервер отдаёт только тех, кого сотруднику видеть
 * положено, и расчёт проверит это ещё раз (assertFilterRefs). Выборка из
 * одного человека всегда ниже порога и приходит закрытой — строка на кадре
 * есть, и убирать её значило бы спорить с кадром, но чисел по одному
 * человеку экран не покажет никогда.
 */
export function PatientField({
  look,
  value,
  onChange,
}: {
  look: Look;
  value?: string | null;
  onChange: (patientId: string | null) => void;
}) {
  const { ut } = useLang();
  const id = useId();
  const [text, setText] = useState("");
  const [found, setFound] = useState<Patient[] | null>(null);
  const [open, setOpen] = useState(false);
  const known = useRef(new Map<string, string>());
  const listRef = useRef<HTMLDivElement>(null);

  /* имя сохранённого в фильтре человека — один раз, по идентификатору */
  useEffect(() => {
    if (!value) {
      setText("");
      return;
    }
    const name = known.current.get(value);
    if (name) {
      setText(name);
      return;
    }
    let live = true;
    void api
      .patientCard(value)
      .then((p) => {
        known.current.set(value, p.fullName);
        if (live) setText(p.fullName);
      })
      .catch(() => {
        if (live) setText(ut("st.patientUnavailable"));
      });
    return () => {
      live = false;
    };
  }, [value, ut]);

  /* поиск ждёт паузу в наборе: сервер расшифровывает ФИО на каждый запрос */
  useEffect(() => {
    if (!open) return;
    const q = text.trim();
    if (q.length < 2) {
      setFound(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void api
        .patients({ search: q })
        .then((r) => {
          if (live) setFound(r.items.slice(0, 8));
        })
        .catch(() => {
          if (live) setFound([]);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, open]);

  const choose = (p: Patient) => {
    known.current.set(p.id, p.fullName);
    setText(p.fullName);
    setOpen(false);
    onChange(p.id);
  };

  return (
    <div className="relative min-w-0 flex-1">
      {/* подпись остаётся и у заполненного поля — см. StatInput */}
      <label className={cx(shell(look), "m-0 w-full cursor-text gap-[8px]", FOCUS_WITHIN)}>
      <span aria-hidden className={cx("shrink-0 whitespace-nowrap", LABEL[look])}>
        {ut("st.patient")}
      </span>
      <input
        role="combobox"
        aria-expanded={open && !!found}
        aria-controls={open && found ? id : undefined}
        aria-autocomplete="list"
        aria-label={ut("st.patient")}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          /* стёртое имя — снятый критерий: иначе поле показывало бы пустоту, а фильтр держал человека */
          if (!e.target.value.trim()) onChange(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        /*
         * Ушёл из поля, не выбрав, — в поле снова тот, кто в фильтре (или
         * пусто): набранное, но не выбранное имя читалось бы как критерий,
         * которого в выборке нет.
         */
        onBlur={(e) => {
          /* Tab в список — не уход из поля: варианты выбирают и клавиатурой */
          if (listRef.current?.contains(e.relatedTarget as Node | null)) return;
          setOpen(false);
          setText(value ? (known.current.get(value) ?? "") : "");
        }}
        className={cx(BARE_INPUT, VALUE[look])}
        autoComplete="off"
      />
      </label>
      {open && found ? (
        <>
          <div aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div
            ref={listRef}
            id={id}
            role="listbox"
            aria-label={ut("st.patient")}
            className={cx(
              "absolute left-0 top-[calc(100%+4px)] z-50 w-full rounded-[5px]",
              "border border-border-strong bg-[var(--bg)] py-[4px] shadow-pop",
            )}
          >
            {found.length === 0 ? (
              <p className="m-0 px-[10px] py-[5px] text-[15px] text-muted">{ut("st.noPatients")}</p>
            ) : (
              found.map((p) => (
                <div
                  key={p.id}
                  role="option"
                  aria-selected={p.id === value}
                  tabIndex={0}
                  /* фокус остаётся в поле: иначе его уход закрыл бы список раньше, чем дойдёт нажатие */
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(p)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      choose(p);
                    }
                  }}
                  className={cx(
                    "flex h-[30px] cursor-pointer items-center px-[10px] text-[15px] text-text hover:bg-primary-tint",
                    FOCUS,
                  )}
                >
                  <span className="truncate">{p.fullName}</span>
                </div>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * «Вік від — Вік до»: два поля числа и тире между ними. Размеры тире и
 * просветов у кадров разные (f09 — тире 25 и просветы 10; f29 — 17 и 6;
 * f23 — 17 и 10), поэтому они — параметры места.
 */
export function AgeRow({
  look,
  min,
  max,
  onChange,
  dash,
  gap,
  invalid,
}: {
  look: Look;
  min?: number | null;
  max?: number | null;
  onChange: (next: { ageMin: number | null; ageMax: number | null }) => void;
  dash: 17 | 25;
  gap: 6 | 10;
  /** «від» больше «до» — оба поля красным; строку ошибки печатает место */
  invalid?: boolean;
}) {
  const { ut } = useLang();
  const num = (v: string) => {
    if (v === "") return null;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(120, n)) : null;
  };
  return (
    <div className={cx("flex min-w-0 flex-1 items-center", gap === 6 ? "gap-[6px]" : "gap-[10px]")}>
      <StatInput
        look={look}
        label={ut("st.ageFrom")}
        type="number"
        inputMode="numeric"
        min={0}
        max={120}
        invalid={invalid}
        value={min ?? ""}
        onChange={(e) => onChange({ ageMin: num(e.target.value), ageMax: max ?? null })}
      />
      {/* тире — рисунок #666666 в 2px, а не символ: на кадре оно длиннее «—» набора */}
      <span aria-hidden className={cx("h-[2px] shrink-0 bg-field-border", dash === 25 ? "w-[25px]" : "w-[17px]")} />
      <StatInput
        look={look}
        label={ut("st.ageTo")}
        type="number"
        inputMode="numeric"
        min={0}
        max={120}
        invalid={invalid}
        value={max ?? ""}
        onChange={(e) => onChange({ ageMin: min ?? null, ageMax: num(e.target.value) })}
      />
    </div>
  );
}

/** «Стать»: два значения сервера; пустое — критерия нет */
export function SexSelect({
  look,
  value,
  onChange,
  className,
}: {
  look: Look;
  value?: Sex | null;
  onChange: (v: Sex | null) => void;
  className?: string;
}) {
  const { ut } = useLang();
  return (
    <StatSelect
      look={look}
      label={ut("person.sex")}
      value={value ?? ""}
      onChange={(v) => onChange(v === "male" || v === "female" ? v : null)}
      className={className}
    >
      <option value="male">{ut("mp.male")}</option>
      <option value="female">{ut("mp.female")}</option>
    </StatSelect>
  );
}

/**
 * «Група пацієнтів» — своя группа сотрудника. Кадрами не нарисована: живёт
 * за «+» формы пресета (f23) и показывается на экране модели только у
 * выборки, где она уже задана, — иначе такая выборка считала бы по группе,
 * а экран об этом молчал.
 */
export function GroupSelect({
  look,
  value,
  onChange,
  groups,
}: {
  look: Look;
  value?: string | null;
  onChange: (v: string | null) => void;
  groups: PatientGroupWithCounts[] | null;
}) {
  const { ut } = useLang();
  const orphan = value && groups && !groups.some((g) => g.id === value) ? value : null;
  return (
    <StatSelect look={look} label={ut("st.group")} value={value ?? ""} onChange={(v) => onChange(v || null)}>
      {orphan ? <option value={orphan}>{ut("st.groupUnavailable")}</option> : null}
      {(groups ?? []).map((g) => (
        <option key={g.id} value={g.id}>
          {g.title}
        </option>
      ))}
    </StatSelect>
  );
}

/** Правка одного ключа фильтра с пустым значением как «ключа нет» */
export function patchFilters(f: SampleFilters, patch: Partial<SampleFilters>): SampleFilters {
  const next: Record<string, unknown> = { ...f, ...patch };
  for (const [k, v] of Object.entries(next)) if (v === null || v === undefined || v === "") delete next[k];
  return next as SampleFilters;
}
