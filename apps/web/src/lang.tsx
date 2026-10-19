import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { detectLang, isLang, type Lang, type UiKey } from "@quizzy/shared";
import { hasLanguage, loadLanguage, makeUiT } from "./dictionary";
import { LANG_KEY } from "./langKey";

/**
 * Язык консоли.
 *
 * Госпиталь украинский, и держать оболочку только на русском — не мелочь:
 * специалист читает эти экраны каждый день. Содержимое методик уже
 * двуязычно, а обёртка вокруг него была зашита в разметку.
 *
 * По умолчанию — из настроек браузера (первый из uk/ru/en в списке языков,
 * см. detectLang), переключается в верхней панели и запоминается. Тот же
 * выбор уходит в Accept-Language — сервер выбирает по нему язык названий
 * методик, инструкций и текстов отказов.
 *
 * Долгое время это было написано здесь, но не сделано в api.ts: заголовок не
 * отправлялся, сервер отвечал по умолчанию по-украински, и переключатель
 * менял только оболочку.
 */

/**
 * Текущий выбор — синхронно для api.ts, который живёт вне React.
 *
 * Начальное значение читается здесь же, при загрузке модуля, а не только в
 * эффекте провайдера. Иначе первые запросы страницы успевали уйти с языком
 * по умолчанию: провайдер применяет сохранённый выбор уже после первого
 * рендера, и человек с русской консолью видел, как названия методик
 * приезжают украинскими и через мгновение меняются.
 */
export let currentLang: Lang = readSavedLang();

/*
 * Язык документа — тот же, что у оболочки, и с первого кадра.
 *
 * По атрибуту `lang` пишут даты и длительности (format.ts) и числа (ui/
 * numbers.ts) — функции вне React. Атрибут ставился эффектом провайдера, то
 * есть ПОСЛЕ отрисовки: при переключении языка экран перерисовывался новыми
 * словами, а даты на нём печатались прежним языком и оставались такими до
 * следующей перерисовки («жовтня» посреди русского экрана). Index.html
 * открывается с «ru», и первый кадр украинской консоли тоже шёл русскими
 * датами. Теперь атрибут и `currentLang` меняются раньше перерисовки.
 */
function applyDocumentLang(lang: Lang): void {
  currentLang = lang;
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}
applyDocumentLang(currentLang);

function readSavedLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (isLang(saved)) return saved;
    return detectLang(navigator.languages ?? [navigator.language]);
  } catch {
    // приватный режим и киоски без хранилища: язык берётся из браузера
    return "uk";
  }
}

interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Перевод по ключу; второй аргумент — чем заменить неизвестный ключ, см. makeUiT */
  ut: (k: UiKey, fallback?: string) => string;
}

const Ctx = createContext<LangState | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangRaw] = useState<Lang>(readSavedLang);
  /* последний выбор: словарь, доехавший после другого нажатия, его не перебивает */
  const wanted = useRef<Lang>(lang);
  /*
   * Словарь в памяти — только выбранного языка (dictionary/index.ts), и
   * другой язык сначала догружается, а уже потом меняет экран. Язык
   * документа — до перерисовки, а не эффектом после неё (applyDocumentLang).
   *
   * Не доехал (нет сети, кусок прежней выкатки) — экран остаётся на прежнем
   * языке, целиком, а не наполовину переведённым; следующее нажатие пробует
   * снова.
   */
  const setLang = useCallback((next: Lang) => {
    wanted.current = next;
    const apply = () => {
      if (wanted.current !== next) return;
      applyDocumentLang(next);
      setLangRaw(next);
    };
    if (hasLanguage(next)) apply();
    else
      loadLanguage(next).then(apply, (error: unknown) => {
        console.warn("словарь языка не загрузился", next, error);
      });
  }, []);

  useEffect(() => {
    // язык страницы — для экранного диктора и переносов слов; и в начале, и после выбора
    applyDocumentLang(lang);
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* приватный режим: выбор живёт до перезагрузки */
    }
    /*
     * Заголовок вкладки тоже следует за языком.
     *
     * Он был зашит в index.html по-русски и оставался таким при украинском
     * интерфейсе. Место видное: вкладка, закладка, история браузера — и
     * единственное, где язык не переключался вовсе.
     */
    document.title = makeUiT(lang)("app.title");
  }, [lang]);

  const value = useMemo<LangState>(() => ({ lang, setLang, ut: makeUiT(lang) }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang(): LangState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLang вне LangProvider");
  return ctx;
}

/**
 * Язык экрана для частей набора, которые только печатают числа (счётчик
 * вкладки, пилюля-счётчик, число у заголовка): внутри провайдера — его выбор
 * и перерисовка при смене, вне провайдера — текущий язык модуля, а не
 * исключение. Разряды в счётчике — не повод требовать провайдер от каждого
 * места, где стоит полоса вкладок.
 */
export function useScreenLang(): Lang {
  return useContext(Ctx)?.lang ?? currentLang;
}
