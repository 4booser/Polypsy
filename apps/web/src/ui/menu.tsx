import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { isTopLayer, useFocusTrap } from "./index";
import { cx } from "./cx";
import { Button, type ButtonProps } from "./primitives";

/*
 * Всплывающее меню за глифом: «+» над списком, «⋯» в строке, «▾» у крошки,
 * шестерёнка у заголовка карточки и над структурой модели.
 *
 * Написано в каталоге тестов (SurveyList.tsx, волна 3), и три экрана волны 4
 * — карточки людей, аналитика, группы — принесли по своей копии той же
 * ловушки фокуса с обходом стрелками. Так и появляются два меню, из которых
 * одно закрывается по Esc, а другое нет; поэтому здесь одно на всех, а
 * экраны отличаются только тем, что кладут внутрь.
 *
 * Меню на кадрах трёх видов, и это не три компонента, а один параметр
 * `align`:
 *  - «left» — меню списка (f07: «+», «⋯», «▾» у крошки): плашка с рамкой
 *    шириной от 220, пункты 13/400 у левого края, как в бургере шапки;
 *  - «right» — меню карточки (f15, f38 и весь раздел людей — f04, f30, f31,
 *    f40, f41, f43, f47, f48, f50: шестерёнка справа от заголовка): плашка
 *    142×94 с рамкой #999999 и тенью, пункты 15/400 серым прижаты к правому
 *    краю, к самой шестерёнке;
 *  - «right-out» — плашка с рамкой #999999, раскрытая ВНИЗ от глифа и
 *    выровненная по его ЛЕВОМУ краю, то есть уходящая вправо от колонки
 *    формы. Так нарисовано меню структуры аналитической модели (f19:
 *    шестерня 1125…1149, плашка 1125…1283) — и иначе плашка легла бы
 *    поверх полей карточки, которые в этот момент читают.
 *
 * Числа «right» — замеры семи кадров раздела людей, числа «right-out» —
 * замеры f19 и только его. Разводить их пришлось дважды: сначала правка
 * «right-out» переписала «right» и задела меню чужих разделов, потом сверка
 * людей перемерила «right» по своим кадрам. Замер одного кадра не
 * распространяется на меню, которое на нём не нарисовано, — поэтому ветки
 * держатся раздельно, и у каждой в комментарии стоит свой кадр.
 * Выравнивание — параметром, а не вторым классом снаружи: `text-left` и
 * `text-right` в одной строке классов спорят, и кто из них победит, решает
 * порядок в собранном CSS, а не в разметке. По той же причине цвет пункта —
 * тоном (`tone`), а не наложением «опасного» класса поверх обычного: два
 * `text-*` в одной строке — тот же спор.
 *
 * Что обещает клавиатуре и диктору: role="menu" с aria-expanded и
 * aria-controls на глифе (ссылка на меню — только пока оно есть: idref в
 * пустоту — ошибка ARIA), фокус на первом пункте, стрелки, Home, End, Esc,
 * Tab по кругу (общая ловушка useFocusTrap), возврат фокуса на глиф при
 * закрытии, область нажатия 44 (Button size="glyph"). Подложка отвечает на
 * нажатие мимо меню — без неё щелчок «закрыть» попадал бы в ссылку строки
 * под меню.
 */

export type MenuAlign = "left" | "right" | "right-out";
export type MenuTone = "normal" | "danger" | "disabled";

/*
 * Пункт меню — обычная строка, а не Button: кнопка макета полужирная и
 * залитая, и шесть таких подряд в столбик читались бы как шесть главных
 * действий. `border-0 bg-transparent min-h-0` гасят правила наследия для
 * <button>. Недоступный пункт остаётся в меню и принимает фокус (см.
 * ActionMenu): атрибут disabled вынул бы его из обхода стрелками, и стрелки,
 * дойдя до него, застревали бы на соседе.
 */
export function menuItemClass(align: MenuAlign = "left", tone: MenuTone = "normal"): string {
  return cx(
    "flex w-full items-center rounded-[4px] border-0 bg-transparent font-normal no-underline",
    "h-auto min-h-0 transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
    /*
     * Пункт меню карточки: отступ 12 и шаг 30 — замер кадра f47 (чернила
     * «Редагувати» кончаются на 1393 при правом крае плашки 1405, чернила
     * трёх пунктов на 212, 242 и 272).
     */
    align === "left"
      ? "gap-2 px-3 py-2 text-left text-[13px] leading-[19px]"
      : align === "right"
        ? "justify-end px-[12px] py-[5px] text-right text-[15px] leading-[20px]"
        /* 5 + 20 + 5 = 30 — шаг пунктов f19; высотой `h-[30px]` спорить с `h-auto` выше нельзя */
        : "justify-end px-[10px] py-[5px] text-right text-[17px] leading-[20px]",
    tone === "disabled"
      ? "cursor-not-allowed text-faint"
      : tone === "danger"
        ? "text-danger hover:bg-danger-soft hover:text-danger hover:no-underline"
        : cx(
            /*
             * Серый пункта — --muted (#595959) для обеих правых веток: на
             * кадрах f47 и f19 чернила пункта (102,102,102); чистый #666666
             * тоже проходит по контрасту, но ступень словаря к нему ближе и
             * не заводит второго серого.
             */
            align === "left" ? "text-text" : "text-muted",
            "hover:bg-primary-soft hover:text-primary hover:no-underline",
          ),
  );
}

/** Пункт меню списка — самый частый случай, чтобы не писать вызов в каждой строке */
export const menuItem = menuItemClass("left");

/*
 * Плашка. У меню карточки тень — токен, а не число: в тёмной теме плашка
 * белой не будет. `items-stretch` растягивает пункты на всю ширину, чтобы
 * область нажатия не кончалась на тексте.
 */
function plateClass(align: MenuAlign): string {
  return cx(
    "absolute z-50 flex flex-col items-stretch outline-none",
    align === "left"
      ? "right-0 top-[calc(100%+6px)] min-w-[220px] gap-0.5 rounded-md border border-border bg-surface p-1 shadow-panel"
      : "rounded-[5px] bg-[var(--bg)] shadow-pop",
    /*
     * Плашка карточки — 142×94 по рамке, и рамка #999999 в пиксель.
     *
     * Замер по самой рамке (153,153,153), без тени: f47 x 1264…1405,
     * y 200…293; те же 142×94 на f30, f31, f40, f43, f50 (на f04 высота 97 —
     * единственный кадр из семи). Прежние «146×97» были сняты вместе с тенью
     * и давали плашку на 14px выше кадра. 94 = 2 рамки + 1 + три пункта по
     * 30 + 1, отсюда py-[1px]; зазор от глифа 8 (на кадре 9).
     */
    align === "right"
      ? "right-0 top-[calc(100%+8px)] min-w-[142px] border border-border-strong py-[1px]"
      : "",
    /*
     * Плашка структуры модели — замер f19. Левый край плашки (1125) совпадает
     * с ЛЕВЫМ краем шестерни (ink 1125…1149), а не с правым: вертикальная
     * рамка #999999 стоит ровно на 1125, правая — на 1283. Ширина 159,
     * 10px под коробкой глифа (низ коробки 296, верх плашки 306).
     *
     * Тень при этом остаётся: на кадре под рамкой лежит мягкий градиент (при
     * x=1200 пиксели 464…470 идут 193→252), и именно его первая редакция
     * приняла за низ плашки — оттого и «поле 7»: настоящий низ рамки на 463.
     */
    align === "right-out"
      ? "left-0 top-[calc(100%+10px)] min-w-[159px] border border-border-strong py-[3px]"
      : "",
  );
}

/**
 * Глиф, раскрывающий меню; содержимое — через функцию, чтобы пункт мог
 * закрыть меню сам, а между пунктами могла стоять черта (<hr>).
 *
 * Ловушка фокуса — общая (useFocusTrap): она же уводит фокус внутрь и
 * возвращает его на глиф при закрытии, поэтому окно, открытое из пункта
 * меню, запоминает «открывшим» именно глиф, а не исчезнувший пункт.
 */
export function MenuButton({
  label,
  glyph,
  align = "left",
  className,
  triggerClassName,
  triggerSize = "glyph",
  children,
}: {
  /** Имя меню для диктора: у глифа подписи нет */
  label: string;
  glyph: ReactNode;
  align?: MenuAlign;
  className?: string;
  /*
   * Раскрывающий элемент — не всегда глиф в квадрате 27. На кадрах
   * f23_1/f24_1 меню языка раскрывает короткая надпись «Укр» без рамки, и
   * втиснуть её в `size="glyph"` нельзя: квадрат 27 обрежет слово. Поэтому
   * размер и классы кнопки — параметры с макетным умолчанием, а не зашитые
   * значения. Альтернатива — второй компонент рядом — принесла бы вторую
   * копию ловушки фокуса и обхода стрелками, ради чего этот файл и написан.
   */
  triggerClassName?: string;
  triggerSize?: ButtonProps["size"];
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const ref = useFocusTrap<HTMLDivElement>(open);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    /*
     * Открытое меню стоит на первом пункте, а не на пустом контейнере:
     * ловушка фокуса переносит фокус на контейнер, и диктор объявлял бы
     * «меню» без пункта под курсором. Ловушка сама пункт не выбирает — она
     * общая на все слои и не знает, что внутри меню.
     */
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      /* только верхний слой: окно поверх меню не должно гасить оба и не должно листать меню под собой */
      if (!isTopLayer(ref)) return;
      if (e.key === "Escape") {
        close();
        return;
      }
      /*
       * Стрелки, Home и End — то, что role="menu" обещает клавиатуре. Ловушка
       * заворачивает Tab по кругу, но человек, услышавший «меню», жмёт стрелку
       * вниз — и до этого обработчика на стрелку не отвечал никто.
       */
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? items.length - 1
            : e.key === "ArrowDown"
              ? (at + 1) % items.length
              : at <= 0
                ? items.length - 1
                : at - 1;
      items[next]?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close, ref]);

  return (
    <div className={cx("relative inline-flex", className)}>
      <Button
        size={triggerSize}
        variant="ghost"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {glyph}
      </Button>
      {open ? (
        <>
          <div aria-hidden onClick={close} className="fixed inset-0 z-40" />
          <div ref={ref} id={id} role="menu" aria-label={label} tabIndex={-1} className={plateClass(align)}>
            {children(close)}
          </div>
        </>
      ) : null}
    </div>
  );
}

/*
 * Меню карточки, заданное списком, а не разметкой: у шестерёнки карточки
 * пункты — всегда переход или действие, без черт и вложенных списков, и
 * описать их данными короче и однороднее, чем повторять <button
 * role="menuitem"> в каждой карточке.
 *
 * Пункт бывает ссылкой (переход) или действием (кнопка) — и то и другое с
 * role="menuitem", чтобы диктор видел одно меню, а не ссылки вперемешку с
 * кнопками. Недоступный пункт остаётся в меню с aria-disabled, а не
 * пропадает: на кадре все пункты нарисованы всегда, и человек, не нашедший
 * «Редагувати» в чужой карточке, решил бы, что меню сломано.
 */
export interface MenuEntry {
  label: string;
  /** Ссылка — переход; без неё пункт — действие */
  to?: string;
  onSelect?: () => void;
  /** Пункт есть, но сейчас недоступен; подсказка объясняет почему */
  disabled?: boolean;
  hint?: string;
  danger?: boolean;
}

export function ActionMenu({
  label,
  glyph,
  entries,
  className,
  triggerSize,
  triggerClassName,
}: {
  label: string;
  glyph: ReactNode;
  entries: MenuEntry[];
  className?: string;
  /*
   * Раскрывающий элемент бывает не глифом: счётчик выборки «18 вибрано»
   * раскрывает своё меню сам, потому что кадр f05 не рисует рядом с ним
   * ничего. Оба свойства просто передаются ниже — MenuButton умел это и
   * раньше, а ActionMenu их глотал, и место с надписью вместо глифа
   * приходилось бы писать MenuButton-ом с копией разметки пунктов.
   */
  triggerSize?: ButtonProps["size"];
  triggerClassName?: string;
}) {
  return (
    <MenuButton
      label={label}
      glyph={glyph}
      align="right"
      className={className}
      triggerSize={triggerSize}
      triggerClassName={triggerClassName}
    >
      {(close) =>
        entries.map((it) => {
          const disabled = !!it.disabled;
          const cls = menuItemClass("right", disabled ? "disabled" : it.danger ? "danger" : "normal");
          if (it.to && !disabled) {
            return (
              <Link key={it.label} role="menuitem" to={it.to} className={cls} onClick={close}>
                {it.label}
              </Link>
            );
          }
          return (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              aria-disabled={disabled || undefined}
              title={disabled ? it.hint : undefined}
              className={cls}
              onClick={() => {
                if (disabled) return;
                close();
                it.onSelect?.();
              }}
            >
              {it.label}
            </button>
          );
        })
      }
    </MenuButton>
  );
}
