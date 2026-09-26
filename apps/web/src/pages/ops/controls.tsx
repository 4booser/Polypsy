import { useEffect, useState, type ReactNode } from "react";
import { IconSearchGlass } from "../../ui";
import { IconCaret } from "../../ui/glyphs";
import { cx } from "../../ui/cx";
import { Input } from "../../ui/primitives";

/*
 * Общие детали вкладок «Користувачі», «Сесії», «Аудит»: поле поиска с лупой,
 * залитый выбор фильтра, шапка колонок и строка списка.
 *
 * Своими, а не общими из ui/: залитого выбора в Select нет (у него рамка
 * #cccccc или контур поля), а переопределять рамку и заливку снаружи
 * классом нельзя — в Tailwind две утилиты одного свойства спорят, и
 * побеждает не последняя. Тот же довод и тот же вид, что у FillSelect
 * раздела «Лікарі» (people/StaffList.tsx); вынести оба в ui/ стоит, когда
 * появится третий.
 */

/** Значение, которое успокоилось: поиск на сервере не должен уходить на каждую букву */
export function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Поле поиска фильтра: залитое (look="fill" — фильтр, а не форма), лупа справа */
export function SearchField({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <span className={cx("relative block min-w-0", className)}>
      <Input
        look="fill"
        ph="plain"
        placeholder={label}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pr-[34px]"
        autoComplete="off"
        spellCheck={false}
      />
      <span aria-hidden className="pointer-events-none absolute right-[6px] top-1/2 -translate-y-1/2 text-text-2 [&>svg]:size-[22px]">
        <IconSearchGlass />
      </span>
    </span>
  );
}

/**
 * Выбор-фильтр в залитом силуэте поля. Пустой выбор («Усі ролі») набран
 * подписью поля — 17/700 фиолетовым, выбранный — начертанием данных:
 * заполненный фильтр отличается от пустого с первого взгляда.
 */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  const empty = !value || value === options[0]?.value;
  return (
    <span className={cx("relative block min-w-0", className)}>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          "h-9 w-full min-w-0 appearance-none truncate rounded-[5px] border-0 bg-primary-soft pl-[10px] pr-[30px] text-[17px]",
          empty ? "font-bold text-primary" : "font-normal text-text",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span aria-hidden className="pointer-events-none absolute right-[11px] top-1/2 flex -translate-y-1/2 text-primary">
        <IconCaret />
      </span>
    </span>
  );
}

/**
 * Шапка колонок списка: подписи 13/700 серым, один раз над строками.
 *
 * В карточке пациента подпись стоит в каждой строке (там строк пять, и у
 * каждой свои три абзаца); здесь строк сотня, и подпись в каждой съела бы
 * треть высоты. На узком окне шапки нет: строки складываются в столбик, и
 * каждое значение там подписано само (см. Cell).
 */
export function ColumnHead({ grid, labels }: { grid: string; labels: (string | null)[] }) {
  return (
    <div
      aria-hidden
      className={cx(grid, "border-b border-hairline pb-[8px] text-[13px] font-bold leading-[16px] text-muted max-[900px]:hidden")}
    >
      {labels.map((l, i) => (
        <span key={i} className="min-w-0 truncate">
          {l ?? ""}
        </span>
      ))}
    </div>
  );
}

/**
 * Ячейка строки: на широком окне — просто значение под своей колонкой, на
 * узком — с подписью перед ним (шапки колонок там нет).
 */
export function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx("min-w-0 text-[15px] leading-[20px] text-text-2", className)}>
      <span className="hidden text-[13px] font-bold text-muted max-[900px]:inline">{label}: </span>
      {children}
    </div>
  );
}

/**
 * Строка списка: разделитель #cccccc снизу, подсветка --primary-tint при
 * наведении на её ссылку или фокусе внутри — как строки карточки пациента.
 */
export function rowClass(grid: string): string {
  return cx(
    grid,
    "items-start border-b border-hairline py-[12px]",
    "transition-colors duration-[var(--dur-fast)] has-[a:hover]:bg-primary-tint has-[:focus-visible]:bg-primary-tint",
    "max-[900px]:grid-cols-1 max-[900px]:gap-y-[6px]",
  );
}

/** Имя строки 17/700 фиолетовым: ссылка на карточку человека */
export const nameClass =
  "block text-[17px] font-bold leading-[22px] text-primary no-underline hover:no-underline [overflow-wrap:anywhere] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]";

/** Мета под именем: 13–15 серым, длинная почта ломается где угодно, а не вылезает из колонки */
export const metaClass = "block text-[13px] leading-[18px] text-muted [overflow-wrap:anywhere]";
