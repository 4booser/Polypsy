import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, type Patient } from "../../../api";
import { useLang } from "../../../lang";
import { cx } from "../../../ui/cx";
import { FilterChip } from "../../../ui/filters";
import { Ic } from "../../../ui/icons";
import { MenuButton, MenuSeparator, menuItemClass } from "../../../ui/menu";
import { Input } from "../../../ui/primitives";
import { useDebounced, useResource } from "../../../useResource";
import { findSurveys, type SurveyChoice } from "./model";

/*
 * Поля панели фильтров «Аналітики тестів» (analytics-tests).
 *
 * Тест и пациент — поля с поиском (их десятки и сотни), группа, период и
 * версия — чипы с меню значений: выбирают из немногого, а применённый
 * фильтр виден тонированным чипом с крестиком.
 */

/** Плашка выпадающего списка — как у меню набора */
const PLATE =
  "kit-scroll absolute left-0 top-[calc(100%+4px)] z-50 m-0 max-h-[340px] w-full min-w-[300px] list-none overflow-y-auto rounded-[12px] border border-border bg-panel p-1 shadow-pop";

const OPTION = "flex min-h-9 cursor-pointer items-center justify-between gap-3 rounded-[8px] px-2.5 py-1.5 text-body leading-[18px]";

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
  icon,
  shownText,
  query,
  onQuery,
  items,
  selected,
  onPick,
  render,
  empty,
  head,
  className,
}: {
  label: string;
  placeholder: string;
  icon: ReactNode;
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
  /** Подпись над пунктами: «Тести за кількістю проходжень» */
  head?: string;
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
        role="combobox"
        aria-label={label}
        aria-expanded={!!shown}
        aria-controls={shown ? id : undefined}
        aria-autocomplete="list"
        aria-activedescendant={shown?.[active] ? `${id}-${active}` : undefined}
        placeholder={placeholder}
        value={open ? query : shownText}
        icon={icon}
        suffix={<Ic.chevronDown size={14} />}
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
        className="w-full"
      />
      {shown ? (
        <ul id={id} role="listbox" aria-label={label} className={PLATE}>
          {head ? (
            <li role="presentation" className="px-2.5 pb-1 pt-1.5 text-caption font-bold text-muted">
              {head}
            </li>
          ) : null}
          {shown.length === 0 ? (
            <li className="px-2.5 py-2 text-body text-muted">{empty}</li>
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
                className={cx(OPTION, i === active && "bg-violet-tint", item.id === selected ? "font-bold text-violet-ink" : "font-medium text-text")}
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
      icon={<Ic.clipboard />}
      shownText={valueTitle}
      query={q}
      onQuery={setQ}
      items={choices ? findSurveys(choices, q) : null}
      selected={value}
      onPick={(s) => onChange(s.id)}
      empty={ut("ant.noTests")}
      head={ut("ant.testsByCount")}
      className={className}
      render={(s) => (
        <>
          <span className="min-w-0 truncate">{s.title}</span>
          <span className="shrink-0 text-caption font-bold tabular-nums text-muted">
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
  /*
   * Загрузкой по успокоившейся строке вместо своего номера билета: ответ
   * ложится под ту строку, которую спрашивали, а стёртая до одной буквы
   * строка больше не получает запоздалый список прежней.
   */
  const typed = q.trim();
  const text = useDebounced(typed, 250);
  const searching = typed.length >= 2 && text.length >= 2;
  const search = useResource(
    () =>
      api
        .patients({ search: text })
        .then((r) => r.items.slice(0, 10))
        .catch(() => [] as Patient[]),
    [text],
    { enabled: searching },
  );
  const found = searching ? search.data : null;

  return (
    <Combo
      label={ut("ant.patient")}
      placeholder={ut("ant.patientSearch")}
      icon={<Ic.user />}
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
          {p.unit ? <span className="shrink-0 text-caption font-medium text-muted">{p.unit}</span> : null}
        </>
      )}
    />
  );
}

/* ─────────── чип с меню значений ─────────── */

export interface ChipOption<K extends string> {
  key: K;
  label: string;
  /** Справа приглушённо: число, «зараз» */
  aside?: ReactNode;
  icon?: ReactNode;
  /** Черта перед пунктом */
  ruled?: boolean;
}

/**
 * Чип фильтра с меню значений (.fchip набора): «Група усі ⌄». Применённый
 * фильтр — тонированный, крестик рядом снимает его (`onClear`). Пункт
 * меню — radio: выбранный отмечен галочкой.
 */
export function ChipMenu<K extends string>({
  label,
  value,
  on,
  onClear,
  options,
  current,
  onPick,
  head,
}: {
  label: string;
  value: ReactNode;
  on: boolean;
  onClear?: () => void;
  options: ChipOption<K>[];
  current: K | null;
  onPick: (key: K) => void;
  head?: string;
}) {
  return (
    <span className="inline-flex">
      <MenuButton
        label={label}
        plateClassName="min-w-[250px]"
        trigger={(t) => (
          <FilterChip label={label} value={value} on={on} onClick={t.onClick} onClear={on ? onClear : undefined} expanded={t["aria-expanded"]} />
        )}
      >
        {(close) => (
          <>
            {head ? <div className="px-2.5 pb-1 pt-2 text-caption font-bold text-muted">{head}</div> : null}
            {options.map((o) => [
              o.ruled ? <MenuSeparator key={`${o.key}-rule`} /> : null,
              <button
                key={o.key}
                type="button"
                role="menuitemradio"
                aria-checked={o.key === current}
                className={menuItemClass("left")}
                onClick={() => {
                  close();
                  onPick(o.key);
                }}
              >
                {o.icon ? <span className="inline-flex text-muted">{o.icon}</span> : null}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.aside !== undefined ? <span className="text-caption font-bold tabular-nums text-muted">{o.aside}</span> : null}
                {o.key === current ? <Ic.check size={15} className="text-violet-ink" /> : null}
              </button>,
            ])}
          </>
        )}
      </MenuButton>
    </span>
  );
}
