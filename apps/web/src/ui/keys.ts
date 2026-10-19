import { useEffect, useRef } from "react";

/*
 * Знак клавиши по её месту в английской раскладке: без Shift и с ним.
 *
 * Консоль открывают на украинской и русской раскладке. Там место «/» печатает
 * «.», место «[» — «х», место «]» — «ї» или «ъ», и знак из события (e.key)
 * с подсказкой «/» не совпадает. Подсказки консоли пишут знак, нарисованный
 * на клавише латиницей, — и работать обязана та клавиша, на которой он
 * нарисован.
 */
const PLACES: Record<string, readonly [string, string]> = {
  Slash: ["/", "?"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Backquote: ["`", "~"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
};

/**
 * Под какими именами нажатие ищется в карте клавиш — по порядку.
 *
 *  1. Буква — по месту клавиши (e.code «KeyJ» → «j», с Shift сперва «J»):
 *     на кириллической раскладке J печатает «о», а K — «л», и карта
 *     `{ j, k }` по знаку молчала бы ровно у тех, кто печатает нотатки
 *     по-украински. Цифра и знак — тоже по месту («Slash» → «/»).
 *  2. Сам код клавиши: «KeyJ», «Digit1», «BracketLeft» — для карт,
 *     написанных кодами (так их пишут прежние useCodeKeys экранов).
 *  3. Знак из события (e.key) как есть и строчным: «Escape», «Enter»,
 *     стрелки, знак, набранный по-своему («?» на Shift+7 русской
 *     раскладки), и клавиатуры без кода (экранная, ввод с подбором).
 *
 * Цифр цифрового блока по месту нет: при выключенном NumLock «1» блока —
 * это End, и цифра там была бы не той клавишей. Включённый NumLock
 * печатает цифру, и её находит пункт 3.
 */
export function hotkeyNames(e: Pick<KeyboardEvent, "key" | "code" | "shiftKey">): string[] {
  const names: string[] = [];
  const code = e.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter) {
    if (e.shiftKey) names.push(letter);
    names.push(letter.toLowerCase());
  }
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  if (digit && !e.shiftKey) names.push(digit);
  const place = PLACES[code];
  if (place) names.push(place[e.shiftKey ? 1 : 0]);
  if (code) names.push(code);
  const key = e.key ?? "";
  if (key) names.push(key, key.toLowerCase());
  return names;
}

/**
 * Открыт ли над экраном слой, под которым клавиши экрана молчат: окно
 * (Modal), палитра команд, меню «Ще розділи» — любой модальный слой, кроме
 * ящика набора.
 *
 * Без этого N на списке моделей заводил новую модель под открытым окном
 * удаления, цифры 1–6 переключали вкладки за окном выгрузки, а J/K ходили по
 * строкам под окном пресетов. Ящик (`data-drawer`) решает сам: его клавиши
 * (1–3 разбора, J/K «Хто це») — его дело, а экран, которому при открытом
 * ящике надо молчать, выключает свою карту вторым аргументом useHotkeys.
 */
export function layerAbove(doc: Pick<Document, "querySelector"> | undefined = typeof document === "undefined" ? undefined : document): boolean {
  return !!doc?.querySelector('[aria-modal="true"]:not([data-drawer])');
}

/** Действие карты для нажатия: первое имя из hotkeyNames, у которого оно есть */
export function hotkeyFor<F>(map: Record<string, F | undefined>, e: Pick<KeyboardEvent, "key" | "code" | "shiftKey">): F | undefined {
  for (const name of hotkeyNames(e)) {
    const handler = map[name];
    if (handler) return handler;
  }
  return undefined;
}

/**
 * Горячие клавиши экрана.
 *
 * Разбор трёхсот случаев мышью — это лишний час работы каждый день.
 * Клавиши не срабатывают, пока курсор в поле ввода: иначе набор комментария
 * «н» превращался бы в «не подтверждён». Esc работает и в поле: он про
 * «уйти отсюда», а не про действие.
 *
 * Буквы, цифры и знаки ищутся по месту клавиши, а не по знаку (hotkeyNames):
 * карта `{ j, k, "/", "[" }` работает и на украинской, и на русской
 * раскладке. Писать в карту кириллицу («о» рядом с «j») больше не нужно.
 *
 * Сочетания с модификаторами пропускаем: Cmd+K и Ctrl+F принадлежат
 * браузеру и палитре, и перехватывать их без крайней нужды — способ
 * разозлить человека. Нажатие, которое уже обработал кто-то ближе к полю
 * (меню, строка таблицы, поповер — preventDefault), и набор с подбором
 * (isComposing) тоже не наши. Под открытым окном или палитрой клавиши
 * молчат (layerAbove); ящик решает сам.
 */
export function useHotkeys(map: Record<string, (() => void) | undefined>, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.isComposing) return;
      if (layerAbove()) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        if (e.key !== "Escape") return;
      }
      const handler = hotkeyFor(ref.current, e);
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
