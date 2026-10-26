import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type Ref } from "react";
import { api, type Patient } from "../api";
import { useLang } from "../lang";
import { Avatar, Ic } from "../ui";
import { placePopover } from "../ui/Popover";
import { cx } from "../ui/cx";
import { Button, Input } from "../ui/primitives";
import { useDebounced, useResource, type Resource } from "../useResource";

/**
 * Выбор пациента зоны — с поиском на сервере (#174).
 *
 * GET /api/access/patients отдаёт не больше ста человек: ФИО зашифровано,
 * упорядочить и листать его в SQL нечем, поэтому сервер ищет сам и
 * обрезает выдачу (routes/access.ts, PATIENT_LIMIT). «Доступ до методики»,
 * «Набори» и «Провести методику» брали первую сотню без поиска и фильтровали
 * её у себя: сто первого человека нельзя было ни найти, ни назначить, а
 * «никого не найдено» выглядело как «его нет в зоне». Теперь набранное
 * уходит серверу, а усечённая выдача говорит о себе — «звузьте пошук».
 * Образец — «Додати пацієнта» в группах (patientGroups/dialogs.tsx).
 */

export interface PatientsFound {
  items: Patient[];
  truncated: boolean;
}

/** Запрос поиска: пустая строка — без параметра (первые сто по алфавиту) */
export function searchPatients(query: string): Promise<PatientsFound> {
  const search = query.trim();
  return api.patients(search ? { search } : {});
}

/**
 * Найденные сервером на набранное — не на каждую букву. `onlyTyped` — не
 * спрашивать, пока ничего не набрано (наборам первая сотня по алфавиту ни к
 * чему: предложения там появляются только под набранным).
 */
export function usePatientSearch(
  query: string,
  options: { onlyTyped?: boolean } = {},
): Resource<PatientsFound> & { stale: boolean } {
  const typed = query.trim();
  const settled = useDebounced(typed, 300);
  const res = useResource(() => searchPatients(settled), [settled], { enabled: !options.onlyTyped || settled !== "" });
  /*
   * Выдача по прежнему запросу: набранное ещё не устоялось или ответ на него
   * не пришёл, а useResource держит прежние данные на время загрузки. Enter по
   * такой выдаче выбрал бы человека из чужого поиска — и обследование ушло бы
   * не тому пациенту.
   */
  return { ...res, stale: typed !== settled || res.loading || res.refreshing };
}

/** Кого выбирает Enter: подсвеченного — и только из выдачи по тому, что набрано сейчас */
export function enterPick(items: readonly Patient[], at: number, stale: boolean | undefined): Patient | null {
  return stale ? null : (items[at] ?? null);
}

/** Вторая строка о человеке: подразделение, а без него — почта (она же вход) */
export function patientSub(p: Patient): string {
  return p.unit ?? p.email;
}

/**
 * Плашка списка — как у меню набора и полей с поиском «Аналітики тестів».
 * На экране она стоит position: fixed по расчёту placePopover (как поповеры
 * набора): панель «Кого обстежуємо» обрезает выступающее (overflow: clip), и
 * список под полем срезался по её нижнему краю. absolute — запасное место до
 * первого замера и в разметке без браузера.
 */
const PLATE =
  "kit-scroll absolute left-0 top-[calc(100%+4px)] z-50 max-h-[340px] w-full min-w-[300px] overflow-y-auto rounded-[12px] border border-border bg-panel p-1 shadow-pop";

/**
 * Разметка выбора — отдельно от состояния, чтобы её можно было нарисовать в
 * тесте.
 *
 * Одно поле, а не два: прежде человека искали в поле «Пошук пацієнта» и
 * выбирали рядом в родном списке «Кого обстежуємо». Теперь это комбобокс:
 * набрал — список найденных под полем, стрелки ходят по нему, Enter
 * выбирает, Esc закрывает; фокус остаётся в поле (aria-activedescendant).
 * Шаг стрелкой — ещё не выбор: прежние замеры человека (чтение со строкой
 * журнала) грузятся только по Enter или щелчку. Выбранный стоит плашкой с
 * «Змінити»: смена снимает выбор целиком, и сохранить обследование, пока
 * новый человек не выбран, нельзя — ни за прежнего, ни «за кого-нибудь».
 */
export function PatientPickerView({
  label,
  query,
  onQuery,
  found,
  chosen,
  onPick,
  onChange,
  open,
  onOpen,
  active,
  onActive,
  inputRef,
  changeRef,
  anchorRef,
  plateRef,
  plateStyle,
  autoFocus,
  className,
}: {
  /** Имя поля для диктора и подпись списка: «Кого обстежуємо» */
  label: string;
  query: string;
  onQuery: (q: string) => void;
  /** stale — выдача по прежнему запросу: её видно, но Enter по ней не выбирает */
  found: Pick<Resource<PatientsFound>, "data" | "error"> & { stale?: boolean };
  /** Выбранный; null — выбора нет, на месте плашки поле поиска */
  chosen: Patient | null;
  onPick: (p: Patient) => void;
  /** «Змінити»: снять выбор и вернуться к полю */
  onChange: () => void;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** Подсвеченный стрелками пункт */
  active: number;
  onActive: (i: number) => void;
  inputRef?: Ref<HTMLInputElement>;
  changeRef?: Ref<HTMLButtonElement>;
  /** Коробка поля — от неё считается место списка */
  anchorRef?: Ref<HTMLDivElement>;
  plateRef?: Ref<HTMLDivElement>;
  /** Место списка на экране (fixed); без него — под полем в потоке панели */
  plateStyle?: CSSProperties;
  autoFocus?: boolean;
  className?: string;
}) {
  const { ut } = useLang();
  const id = useId();
  const items = found.data?.items ?? [];
  const listed = open && items.length > 0;
  const at = Math.min(active, Math.max(0, items.length - 1));

  /* подсвеченный пункт — в поле зрения списка: длинная выдача листается стрелками */
  useEffect(() => {
    if (listed) document.getElementById(`${id}-${at}`)?.scrollIntoView?.({ block: "nearest" });
  }, [listed, at, id]);

  if (chosen) {
    return (
      <div className={cx("flex min-h-[52px] min-w-0 items-center gap-3 rounded-control bg-violet-tint py-2 pl-2.5 pr-2", className)}>
        <Avatar name={chosen.fullName} size={32} />
        <span className="flex min-w-0 flex-1 flex-col">
          <b className="truncate text-body font-extrabold leading-[18px] text-text">{chosen.fullName}</b>
          <small className="truncate text-caption text-text-2">{patientSub(chosen)}</small>
        </span>
        <Button ref={changeRef} size="xs" variant="secondary" aria-label={ut("pp.changeWho")} onClick={onChange}>
          {ut("pp.change")}
        </Button>
      </div>
    );
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        onOpen(false);
      } else if (query) {
        onQuery("");
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        onOpen(true);
        onActive(0);
        return;
      }
      if (!items.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      onActive((at + step + items.length) % items.length);
      return;
    }
    if (e.key === "Enter" && listed) {
      e.preventDefault();
      // подсвеченный пункт прежней выдачи — не выбор: ждём выдачу по набранному
      const p = enterPick(items, at, found.stale);
      if (p) onPick(p);
    }
  };

  return (
    <div className={cx("relative min-w-0", className)}>
      <div ref={anchorRef}>
        <Input
          ref={inputRef}
          role="combobox"
          aria-label={label}
          aria-expanded={listed}
          aria-controls={listed ? id : undefined}
          aria-autocomplete="list"
          aria-activedescendant={listed ? `${id}-${at}` : undefined}
          placeholder={ut("pp.placeholder")}
          icon={<Ic.search />}
          value={query}
          autoFocus={autoFocus}
          autoComplete="off"
          maxLength={120}
          onChange={(e) => {
            onQuery(e.target.value);
            onOpen(true);
            onActive(0);
          }}
          onMouseDown={() => onOpen(true)}
          onKeyDown={onKey}
          onBlur={() => onOpen(false)}
          className="w-full"
        />
      </div>
      {open ? (
        <div ref={plateRef} className={PLATE} style={plateStyle}>
          {listed ? (
            <ul id={id} role="listbox" aria-label={label} aria-busy={found.stale || undefined} className={cx("m-0 list-none p-0", found.stale && "opacity-60")}>
              {items.map((p, i) => (
                <li
                  key={p.id}
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={i === at}
                  data-patient={p.id}
                  /* фокус остаётся в поле: иначе blur закрыл бы список раньше щелчка */
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(p)}
                  onMouseEnter={() => onActive(i)}
                  className={cx(
                    "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-1.5",
                    i === at ? "bg-violet-tint" : "bg-transparent",
                  )}
                >
                  <Avatar name={p.fullName} size={28} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-body font-bold text-text">{p.fullName}</span>
                    <small className="truncate text-caption text-muted">{patientSub(p)}</small>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 px-2.5 py-2 text-body text-muted">{found.data ? ut("pt.nobodyFound") : ut("common.loading")}</p>
          )}
          {found.data?.truncated ? <p className="m-0 border-t border-divider px-2.5 pb-1 pt-2 text-caption text-muted">{ut("pg.truncated")}</p> : null}
        </div>
      ) : null}
      {found.error ? <p className="m-0 mt-1.5 text-caption text-danger">{found.error}</p> : null}
    </div>
  );
}

/**
 * Выбор пациента одним полем с поиском. Выбранный — целиком, а не id: экран
 * рисует его плашкой и после возврата со страницы «Обстеження збережено»,
 * когда поиск уже ничего о нём не помнит.
 */
export function PatientPicker({
  value,
  onChange,
  label,
  onPicked,
  className,
}: {
  value: Patient | null;
  onChange: (p: Patient | null) => void;
  label: string;
  /**
   * Куда деть фокус после выбора (поле быстрого ввода — следующий шаг). Без
   * него фокус встаёт на «Змінити»: поле поиска с выбором исчезает, и фокус
   * не должен уходить в никуда.
   */
  onPicked?: () => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const found = usePatientSearch(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const plateRef = useRef<HTMLDivElement>(null);
  const [plateStyle, setPlateStyle] = useState<CSSProperties | undefined>(undefined);
  /*
   * Список — над панелью, а не внутри неё: position: fixed под полем (или
   * над ним, если снизу тесно), заново на прокрутке и смене размера окна.
   * До отрисовки — useLayoutEffect, чтобы срезанный кадр не мелькнул.
   */
  useLayoutEffect(() => {
    if (!open) {
      setPlateStyle(undefined);
      return;
    }
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const plate = plateRef.current;
      if (!anchor || !plate) return;
      const at = placePopover({
        trigger: { top: anchor.top, left: anchor.left, width: anchor.width, height: anchor.height },
        pop: { width: anchor.width, height: plate.offsetHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        side: "bottom",
        align: "start",
        gap: 4,
      });
      setPlateStyle({ position: "fixed", top: at.top, left: at.left, width: anchor.width });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, found.data]);
  /* куда вернуть фокус после смены плашки на поле и обратно — до отрисовки нового узла его нет */
  const [focusTo, setFocusTo] = useState<"input" | "change" | null>(null);
  useEffect(() => {
    if (focusTo === "input") inputRef.current?.focus();
    if (focusTo === "change") changeRef.current?.focus();
    if (focusTo) setFocusTo(null);
  }, [focusTo]);

  return (
    <PatientPickerView
      label={label}
      query={query}
      onQuery={setQuery}
      found={found}
      chosen={value}
      onPick={(p) => {
        setOpen(false);
        setQuery("");
        onChange(p);
        if (onPicked) onPicked();
        else setFocusTo("change");
      }}
      onChange={() => {
        onChange(null);
        setActive(0);
        setFocusTo("input");
      }}
      open={open}
      onOpen={setOpen}
      active={active}
      onActive={setActive}
      inputRef={inputRef}
      changeRef={changeRef}
      anchorRef={anchorRef}
      plateRef={plateRef}
      plateStyle={plateStyle}
      autoFocus={!value}
      className={className}
    />
  );
}
