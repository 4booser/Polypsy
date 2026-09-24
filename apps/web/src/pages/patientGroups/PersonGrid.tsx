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
 * — и лежит оно в меню «⋯» рядом со счётчиком (SelectionBar): на кадре под
 * сеткой напечатано только «18 вибрано».
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
        /* зазор колонок 44: левые края имён на f05 — 201/616/1030, шаг 415 при колонке 371 */
        "m-0 grid list-none grid-cols-3 gap-x-[44px] p-0",
        "max-[1000px]:grid-cols-2 max-[640px]:grid-cols-1",
        className,
      )}
    >
      {people.map((p) => {
        const checked = selected.has(p.userId);
        return (
          <li
            key={p.userId}
            /* focus всплывает (React слушает focusin): одно свойство на оба элемента строки */
            onFocus={onFocus ? () => onFocus(p) : undefined}
            className={cx(
              /* 58px — шаг строк макета: 13/18 имя + 13/18 мета + воздух */
              "flex min-h-[58px] items-center gap-[10px] rounded-[4px] pl-[4px] -ml-[4px]",
              "transition-colors duration-[var(--dur-fast)]",
              /*
               * Подсветка — --primary-tint (#f7f5fa), ровно как на кадрах f06 и
               * f13. Не --surface-2: та ступень разрешается в #f0ecff, то есть в
               * заливку плашек карточки, и подсветка выходила втрое плотнее
               * кадровой. Ложится по наведению на имя строки — единственное, на
               * что в строке можно нажать (галочка красит себя сама).
               */
              "has-[a:hover]:bg-primary-tint has-[a:focus-visible]:bg-primary-tint",
              focusedId === p.userId ? "bg-primary-tint" : "",
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
 * Галочка макета: квадрат 22×22 со скруглением и рамкой в два пикселя
 * #cccccc (--border), внутри — залитый фиолетовый квадрат 12, когда
 * отмечено. Замер f05: внешний квадрат x 1379…1400, y 305…326, рамка
 * (204,204,204) толщиной 2; внутренний 12 px. Прежние 20/1px/#999999 давали
 * галочку мельче кадровой и темнее её рамкой.
 *
 * Не системная галочка с птичкой: на макете птички нет, а `accent-color`
 * рисует именно её.
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
        style={{ width: 22, height: 22 }}
        className={cx(
          "m-0 grid min-h-0 appearance-none place-items-center rounded-[4px] border-2 border-border bg-[var(--bg)] p-0",
          "before:size-[12px] before:rounded-[2px] before:content-['']",
          "checked:before:bg-primary",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2",
        )}
      />
    </label>
  );
}

/**
 * «18 вибрано» — нижний рядок кадра f05, и на кадре в нём БОЛЬШЕ НИЧЕГО
 * нет: ни кнопок действий, ни ссылки «Зняти вибір». Действия над выборкой
 * экран кладёт в меню «⋯» рядом со счётчиком и передаёт их сюда потомком —
 * меню появляется только когда есть кого выбрано: пункт «Додати до групи»
 * при нуле выбранных обещал бы действие, которому не с кем случиться.
 *
 * `aria-live` — на счётчике, а не на всём рядке: диктор слышит «3 вибрано»
 * после каждой галочки, не уходя со списка, — иначе счётчик внизу экрана он
 * нашёл бы только Tab-ом до конца. На всём рядке живая область при переходе
 * 0→1 зачитывала бы вслед за счётчиком и появившиеся кнопки. `aria-atomic`:
 * меняется одно число, а прочесть надо всю фразу, не «три».
 */
export function SelectionBar({ count, children }: { count: number; children?: ReactNode }) {
  const { ut } = useLang();
  return (
    /*
     * 20/400 серым — замер f05: высота цифры «18» 14 px (y 850…863) при
     * кап-высоте 0,72 кегля даёт 19-20, цвет обоих слов (102,102,102).
     * Было 16, и число вдобавок набиралось почти чёрным (--text): на кадре
     * «18» отличается от «вибрано» только толщиной штриха.
     */
    <div className="mt-[40px] flex flex-wrap items-center gap-[14px] text-[20px] leading-none text-muted">
      <span aria-live="polite" aria-atomic="true">
        <strong className="font-bold">{count}</strong> {ut("pg.selected")}
      </span>
      {count > 0 ? children : null}
    </div>
  );
}
