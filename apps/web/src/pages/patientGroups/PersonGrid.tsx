import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useLang } from "../../lang";
import { cx } from "../../ui/cx";
import { personMeta, type PersonLike } from "./model";

/*
 * Список людей в три колонки — кадры f05 и f20 макета.
 *
 * На обоих кадрах строка одна и та же: ПІБ 13/700 фиолетовым ссылкой, под
 * ним мета 13/400 серым, справа квадратный чекбокс; шаг строк 58px, три
 * колонки. Поэтому компонент один, а экранов два: список пациентов и
 * «Пацієнти Групи» в карточке. Разойтись им нельзя — человек ходит между
 * ними по десять раз на дню и читает строку не глядя.
 *
 * Чекбокс здесь — ВЫБОР, а не членство. На f05 под сеткой стоит «18 вибрано»,
 * то есть галочка копит выборку под действие; на f20 нарисована та же
 * галочка, и читать её иначе («в группе / не в группе») значило бы дать
 * одному знаку два смысла на соседних экранах. Действие над выборкой у
 * каждого экрана своё — добавить в группу, назначить тест, убрать из группы,
 * — и печатается оно рядом со счётчиком (SelectionBar).
 */

/**
 * Сетка на макете нарисована сплошным списком без шапки, а не таблицей: у
 * строки нет колонок, только имя, мета и галочка. Список (<ul>) читается
 * диктором как «список из 27 элементов» — ровно то, что нарисовано.
 * `data-patients` — опора для сквозных проверок: класс менять можно,
 * признак нет.
 */
export function PersonGrid({
  people,
  selected,
  onToggle,
  onFocus,
  focusedId,
  className,
}: {
  people: PersonLike[];
  selected: ReadonlySet<string>;
  onToggle: (userId: string) => void;
  /**
   * Нажатие по строке мимо ссылки и галочки — «а это кто?» для панели
   * контекста справа. Ссылка ведёт в карту, галочка выбирает; сама строка
   * отвечает на вопрос, не уводя с экрана (см. layout.tsx, п. 5).
   *
   * С клавиатуры строку не нажать — у <li> нет фокуса, и давать его ему
   * нельзя: внутри уже два элемента с фокусом (ссылка и галочка), а
   * вложенные остановки табуляции диктор читает как одну. Поэтому панель
   * идёт за фокусом: Tab на ссылку или галочку строки — и панель отвечает
   * про эту строку, без третьей остановки на каждого человека.
   */
  onFocus?: (person: PersonLike) => void;
  focusedId?: string | null;
  className?: string;
}) {
  const { ut } = useLang();
  const words = { male: ut("adm.male"), female: ut("adm.female"), year: ut("pg.yearSuffix") };
  return (
    <ul
      data-patients
      className={cx(
        "m-0 grid list-none grid-cols-3 gap-x-[48px] p-0",
        "max-[1000px]:grid-cols-2 max-[640px]:grid-cols-1",
        className,
      )}
    >
      {people.map((p) => {
        const checked = selected.has(p.userId);
        return (
          <li
            key={p.userId}
            onClick={onFocus ? () => onFocus(p) : undefined}
            /* focus всплывает (React слушает focusin): одно свойство на оба элемента строки */
            onFocus={onFocus ? () => onFocus(p) : undefined}
            className={cx(
              /* 58px — шаг строк макета: 13/18 имя + 13/18 мета + воздух */
              "flex min-h-[58px] items-center gap-[10px] rounded-[4px] pl-[4px] -ml-[4px]",
              "transition-colors duration-[var(--dur-fast)]",
              onFocus ? "cursor-default hover:bg-surface-2" : "",
              focusedId === p.userId ? "bg-surface-2" : "",
            )}
          >
            <div className="min-w-0 flex-1">
              <Link
                to={`/patients/${p.userId}`}
                onClick={(e) => e.stopPropagation()}
                className="block truncate text-[13px] font-bold leading-[18px] text-primary no-underline hover:underline"
              >
                {p.fullName}
              </Link>
              {/* мета в одну строку с зазорами, как на макете; лишнее режется, а не переносится */}
              <div className="flex gap-[10px] overflow-hidden text-[13px] leading-[18px] text-muted">
                {personMeta(p, words).map((m, i) => (
                  <span key={i} className="truncate">
                    {m}
                  </span>
                ))}
              </div>
            </div>
            <Checkbox
              checked={checked}
              onChange={() => onToggle(p.userId)}
              label={`${ut("pg.select")}: ${p.fullName}`}
            />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Галочка макета: квадрат 20×20 со скруглением, внутри — залитый фиолетовый
 * квадрат, когда отмечено. Не системная галочка с птичкой: на макете птички
 * нет, а `accent-color` рисует именно её.
 *
 * Область нажатия — подпись 44×44 вокруг поля (как у глифов Button: мишень
 * для пальца и для промаха мышью), сама картинка остаётся 20. Размер задан
 * стилем, а не классом: правило наследия `input[type="checkbox"] { width:
 * auto }` сильнее утилиты по специфичности и раздавило бы `size-5` молча.
 */
function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label
      className="grid size-[44px] shrink-0 cursor-pointer place-items-center"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={label}
        style={{ width: 20, height: 20 }}
        className={cx(
          "m-0 grid min-h-0 appearance-none place-items-center rounded-[4px] border border-border-strong bg-[var(--bg)] p-0",
          "before:size-[10px] before:rounded-[2px] before:content-['']",
          "checked:before:bg-primary",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2",
        )}
      />
    </label>
  );
}

/**
 * «18 вибрано» — нижний рядок кадра f05: число полужирным тёмным, слово
 * серым. Действия над выборкой печатаются рядом и только когда есть кого
 * выбрано: кнопка «Додати до групи» при нуле выбранных обещала бы действие,
 * которому не с кем случиться.
 *
 * `aria-live` — на счётчике, а не на всём рядке: диктор слышит «3 вибрано»
 * после каждой галочки, не уходя со списка, — иначе счётчик внизу экрана он
 * нашёл бы только Tab-ом до конца. На всём рядке живая область при переходе
 * 0→1 зачитывала бы вслед за счётчиком и появившиеся кнопки. `aria-atomic`:
 * меняется одно число, а прочесть надо всю фразу, не «три».
 */
export function SelectionBar({
  count,
  onClear,
  children,
}: {
  count: number;
  onClear: () => void;
  children?: ReactNode;
}) {
  const { ut } = useLang();
  return (
    <div className="mt-[40px] flex flex-wrap items-center gap-[14px] text-[16px] text-muted">
      <span aria-live="polite" aria-atomic="true">
        <strong className="font-bold text-text">{count}</strong> {ut("pg.selected")}
      </span>
      {count > 0 ? (
        <>
          {children}
          <button
            type="button"
            onClick={onClear}
            className="min-h-0 rounded-sm border-0 bg-transparent p-0 text-[13px] text-muted underline hover:text-primary"
          >
            {ut("pg.clearSelection")}
          </button>
        </>
      ) : null}
    </div>
  );
}
