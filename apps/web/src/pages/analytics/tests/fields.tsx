import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, type Patient } from "../../../api";
import { useLang } from "../../../lang";
import { cx } from "../../../ui/cx";
import { IconCaret } from "../../../ui/glyphs";
import { Input } from "../../../ui/primitives";
import { findSurveys, type Scope, type SurveyChoice } from "./model";

/*
 * Поля строки фильтров вкладки «Тести».
 *
 * Все — залитого вида (`fill`, #f0ecff без рамки): по дизайн-системе это
 * вид поля фильтра и показа состояния, в отличие от контурного поля формы.
 * Высота 36 и радиус 5 — общие с Input.
 *
 * Свои, а не взятые из раздела статистики (statistics/parts.tsx): у того
 * своя сетка «вид поля» под кадры f09/f23, и привязка к нему связала бы два
 * раздела, которые правят разные люди по разным кадрам.
 */

const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]";

/** Плашка выпадающего списка: рамка #999999 и тень — как у меню консоли */
const PLATE =
  "absolute left-0 top-[calc(100%+4px)] z-50 m-0 max-h-[320px] w-full min-w-[280px] list-none overflow-y-auto rounded-[5px] border border-border-strong bg-[var(--bg)] px-0 py-[4px] shadow-pop";

const OPTION = "flex min-h-[32px] cursor-pointer items-center justify-between gap-[12px] px-[10px] py-[5px] text-[15px] leading-[19px]";

/* ─────────── выбор из списка ─────────── */

/**
 * Выбор в залитом силуэте.
 *
 * Select из primitives умеет только контурные виды (`list`, `bare`), а
 * заливку поверх них классом не наложить: `bg-[var(--bg)]` и
 * `bg-primary-soft` в одной строке спорят, и кто победит, решает порядок в
 * собранном CSS. Поэтому свой элемент — тот же штатный <select> с тем же
 * треугольником 9×5 цветом рамки поля, что у Select.
 */
export function FillSelect({
  label,
  value,
  onChange,
  children,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("relative", className)}>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          "h-9 w-full min-w-0 cursor-pointer appearance-none truncate rounded-[5px] border-0 bg-primary-soft pl-[10px] pr-[28px]",
          "text-[17px] text-text",
          FOCUS,
        )}
      >
        {children}
      </select>
      <span aria-hidden className="pointer-events-none absolute right-[10px] top-1/2 flex -translate-y-1/2 text-field-border">
        <IconCaret />
      </span>
    </div>
  );
}

/* ─────────── «Усі пацієнти / Один пацієнт» ─────────── */

/**
 * Переключатель «Хто»: две белые плашки на сиреневой полосе.
 *
 * Вид взят с панели инструментов заключения (f36/f37, Button variant
 * "paper"): на залитой полосе выбранное — белое. Два состояния из двух — это
 * радиогруппа, а не селект: оба варианта видны сразу, и выбор делается одним
 * нажатием, а не двумя.
 *
 * Стрелки ← → переключают, как положено радиогруппе; Tab уходит дальше с
 * выбранной плашки (у второй tabIndex −1).
 */
export function ScopeSwitch({ value, onChange }: { value: Scope; onChange: (v: Scope) => void }) {
  const { ut } = useLang();
  const options: [Scope, string][] = [
    ["all", ut("ant.allPatients")],
    ["patient", ut("ant.onePatient")],
  ];
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = value === "all" ? "patient" : "all";
    /* currentTarget после обработки события обнуляется — берём его сейчас */
    const root = e.currentTarget;
    onChange(next);
    requestAnimationFrame(() => root.querySelector<HTMLElement>(`[data-scope="${next}"]`)?.focus());
  };
  return (
    <div
      role="radiogroup"
      aria-label={ut("ant.who")}
      onKeyDown={onKey}
      className="flex h-9 shrink-0 items-center gap-[3px] rounded-[5px] bg-primary-soft p-[3px]"
    >
      {options.map(([scope, label]) => (
        <button
          key={scope}
          type="button"
          role="radio"
          data-scope={scope}
          aria-checked={value === scope}
          tabIndex={value === scope ? 0 : -1}
          onClick={() => onChange(scope)}
          className={cx(
            "h-[30px] min-h-0 whitespace-nowrap rounded-[4px] border-0 px-[10px] text-[15px] font-bold leading-none",
            "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
            value === scope ? "bg-[var(--bg)] text-primary" : "bg-transparent text-primary-dim hover:text-primary",
            FOCUS,
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* ─────────── поле с поиском и списком ─────────── */

/**
 * Общее у поиска теста и поиска пациента: поле-комбобокс и список под ним.
 *
 * Стрелки ходят по списку, Enter выбирает, Esc закрывает; фокус остаётся в
 * поле (aria-activedescendant), иначе уход фокуса закрывал бы список раньше,
 * чем дойдёт нажатие. Ушёл из поля, не выбрав, — в поле снова выбранное:
 * набранное, но не выбранное читалось бы как фильтр, которого нет.
 */
function Combo<T extends { id: string }>({
  label,
  placeholder,
  shownText,
  query,
  onQuery,
  items,
  selected,
  onPick,
  render,
  empty,
  className,
}: {
  label: string;
  placeholder: string;
  /** Что стоит в поле, пока список закрыт: выбранное */
  shownText: string;
  query: string;
  onQuery: (q: string) => void;
  /** null — список не показывается (ещё нечего искать) */
  items: T[] | null;
  selected: string | null;
  onPick: (item: T) => void;
  render: (item: T) => ReactNode;
  empty: string;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const shown = open && items ? items : null;

  useEffect(() => setActive(0), [items]);

  const pick = (item: T) => {
    setOpen(false);
    onPick(item);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!shown?.length) {
      if (e.key === "ArrowDown") setOpen(true);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + step + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = shown[active];
      if (item) pick(item);
    }
  };

  return (
    <div className={cx("relative", className)}>
      <Input
        look="fill"
        role="combobox"
        aria-label={label}
        aria-expanded={!!shown}
        aria-controls={shown ? id : undefined}
        aria-autocomplete="list"
        aria-activedescendant={shown?.[active] ? `${id}-${active}` : undefined}
        placeholder={placeholder}
        ph="plain"
        value={open ? query : shownText}
        onFocus={() => {
          onQuery("");
          setOpen(true);
        }}
        onChange={(e) => {
          onQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKey}
        onBlur={() => setOpen(false)}
        autoComplete="off"
        maxLength={120}
        className="truncate pr-[28px]"
      />
      <span aria-hidden className="pointer-events-none absolute right-[10px] top-1/2 flex -translate-y-1/2 text-field-border">
        <IconCaret />
      </span>
      {shown ? (
        <ul id={id} role="listbox" aria-label={label} className={PLATE}>
          {shown.length === 0 ? (
            <li className="px-[10px] py-[5px] text-[15px] text-muted">{empty}</li>
          ) : (
            shown.map((item, i) => (
              <li
                key={item.id}
                id={`${id}-${i}`}
                role="option"
                aria-selected={item.id === selected}
                /* фокус остаётся в поле: иначе blur закрыл бы список раньше щелчка */
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(item)}
                onMouseEnter={() => setActive(i)}
                className={cx(OPTION, i === active && "bg-primary-tint", item.id === selected ? "font-bold text-primary" : "text-text")}
              >
                {render(item)}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * «Тест»: поиск методики по названию, у каждой — число прохождений.
 *
 * Число стоит в списке не для красоты: методика без прохождений даст пустой
 * экран, и узнать это лучше до выбора, а не после.
 */
export function SurveyPicker({
  choices,
  value,
  valueTitle,
  onChange,
  className,
}: {
  choices: SurveyChoice[] | null;
  value: string | null;
  valueTitle: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  const { ut } = useLang();
  const [q, setQ] = useState("");
  return (
    <Combo
      label={ut("ant.test")}
      placeholder={ut("ant.testSearch")}
      shownText={valueTitle}
      query={q}
      onQuery={setQ}
      items={choices ? findSurveys(choices, q) : null}
      selected={value}
      onPick={(s) => onChange(s.id)}
      empty={ut("ant.noTests")}
      className={className}
      render={(s) => (
        <>
          <span className="min-w-0 truncate">{s.title}</span>
          <span className="shrink-0 font-mono text-[12px] font-normal tabular-nums text-muted">
            {s.responseCount}
            <span className="sr-only"> {ut("ant.responsesLower")}</span>
          </span>
        </>
      )}
    />
  );
}

/**
 * «Пацієнт»: поиск по имени в зоне видимости сотрудника.
 *
 * Те же люди, что в разделе «Пацієнти» (GET /api/access/patients): сервер
 * отдаёт только тех, кого сотруднику видеть положено, а аналитика проверит
 * это ещё раз (assertPatientAccess). Поиск ждёт паузу в наборе и начинается
 * с двух букв: сервер расшифровывает ФИО на каждый запрос.
 *
 * Имя выбранного приходит сверху (`valueName`) — экран и так читает
 * динамику этого человека, где имя есть; второй запрос карточки ради
 * подписи в поле был бы лишним чтением персональных данных.
 */
export function PatientPicker({
  value,
  valueName,
  onChange,
  className,
}: {
  value: string | null;
  valueName: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  const { ut } = useLang();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Patient[] | null>(null);
  const live = useRef(0);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setFound(null);
      return;
    }
    const ticket = ++live.current;
    const timer = setTimeout(() => {
      void api
        .patients({ search: text })
        .then((r) => {
          if (live.current === ticket) setFound(r.items.slice(0, 10));
        })
        .catch(() => {
          if (live.current === ticket) setFound([]);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <Combo
      label={ut("ant.patient")}
      placeholder={ut("ant.patientSearch")}
      shownText={valueName}
      query={q}
      onQuery={setQ}
      items={found}
      selected={value}
      onPick={(p) => onChange(p.id)}
      empty={ut("ant.noPatients")}
      className={className}
      render={(p) => (
        <>
          <span className="min-w-0 truncate">{p.fullName}</span>
          {p.unit ? <span className="shrink-0 text-[12px] font-normal text-muted">{p.unit}</span> : null}
        </>
      )}
    />
  );
}
