import type { ReactNode } from "react";
import { useLang } from "../../lang";
import { IconSearchGlass, Loading } from "../../ui";
import { IconCaret } from "../../ui/glyphs";
import { cx } from "../../ui/cx";
import { listBody } from "../../ui/paging";
import { Button, Input } from "../../ui/primitives";

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

/* значение, которое успокоилось, — общее со слоем загрузки (useResource.ts) */
export { useDebounced } from "../../useResource";

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

/**
 * Место списка вкладки: что стоит вместо строк, пока их нет, и отказ
 * поверх уже показанных (w14:webtails).
 *
 * Три вкладки — «Користувачі», «Сесії», «Аудит» — писали это каждая сама,
 * одной и той же тернарной лесенкой «отказ → скелет → пусто → строки». В
 * ней была общая дыра: отказ ПЕРЕЧИТЫВАНИЯ стирал показанные строки. Журнал,
 * долистанный до пятой сотни записей, на неудачном «Показати ще» исчезал
 * целиком, и на его месте стоял отказ; список учёток после «вимкнути»
 * (перечитывание упало) — тоже. Правило консоли для списков другое
 * (listBody в ui/paging.ts, как у очереди случаев): пока строк нет — отказ
 * на их месте с «повторити»; когда строки есть — отказ строкой над ними, а
 * строки остаются: устаревший список с пометкой полезнее пустого.
 *
 * «Порожньо» — только по ответу сервера: пока ответа нет (грузится или нет
 * связи) — скелет, а не «нікого не знайдено».
 *
 * Строки — функцией: рисуются только тогда, когда они есть, и экран может
 * обращаться к данным без проверок на null.
 */
export function ListPlace({
  items,
  error,
  onRetry,
  empty,
  rows = 6,
  children,
}: {
  items: readonly unknown[] | null;
  error: string | null;
  onRetry: () => void;
  /** Что сказать, когда сервер ответил пустым: по отбору и без него это разные слова */
  empty: string;
  rows?: number;
  children: () => ReactNode;
}) {
  const { ut } = useLang();
  const view = listBody(items, error);
  if (view.body === "failed" || view.body === "loading") return <Loading rows={rows} error={error} onRetry={onRetry} />;
  return (
    <>
      {view.stale ? (
        <div role="alert" className="mb-[12px] flex items-center gap-[10px] border-b border-hairline py-[8px]">
          <p className="m-0 min-w-0 flex-1 text-[13px] text-danger">{view.stale}</p>
          <Button variant="quiet" size="sm" onClick={onRetry}>
            {ut("common.retry")}
          </Button>
        </div>
      ) : null}
      {view.body === "empty" ? <p className="m-0 py-[24px] text-[13px] text-muted">{empty}</p> : children()}
    </>
  );
}
