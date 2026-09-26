import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { LANGS, LANG_NAMES, LANG_SELF_LABEL, detectLang, isLang, makeUiT, type Lang, type UiKey } from "@quizzy/shared";

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
const KEY = "quizzy.web.lang";

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

function readSavedLang(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
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

  useEffect(() => {
    currentLang = lang;
    localStorage.setItem(KEY, lang);
    // язык страницы — для экранного диктора и переносов слов
    document.documentElement.lang = lang;
    /*
     * Заголовок вкладки тоже следует за языком.
     *
     * Он был зашит в index.html по-русски и оставался таким при украинском
     * интерфейсе. Место видное: вкладка, закладка, история браузера — и
     * единственное, где язык не переключался вовсе.
     */
    document.title = makeUiT(lang)("app.title");
  }, [lang]);

  const value = useMemo<LangState>(
    () => ({ lang, setLang: setLangRaw, ut: makeUiT(lang) }),
    [lang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang(): LangState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLang вне LangProvider");
  return ctx;
}

/**
 * Переключатель языка. Одинаковый для публичных страниц (киоск, приглашение)
 * и боковой панели консоли — язык один на всё приложение, и два разных
 * переключателя означали бы два разных состояния.
 */
export function LangSwitch() {
  const { lang, setLang } = useLang();
  return (
    /*
      Сегментированный переключатель, а не кнопки рядом: кнопки выглядят
      как отдельные действия, а здесь одно состояние из нескольких. Текущий
      язык виден заливкой, а не только жирностью — жирность на трёх буквах
      прописными не читается.
    */
    <div
      role="group"
      /* многоязычное имя одной записью на оба переключателя — см. types.ts */
      aria-label={LANG_SELF_LABEL}
      className="flex items-center overflow-hidden rounded-md border border-hairline"
    >
      {/* все языки перечнем: третий язык появился здесь без правки разметки */}
      {LANGS.map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => setLang(code)}
          aria-pressed={lang === code}
          className={
            "min-h-0 rounded-md px-2.5 py-1.5 text-micro font-semibold tracking-[var(--tracking-label)] " +
            "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] " +
            /*
              Выбранный язык отмечен вписанной рамкой акцента, а не заливкой.
              Заливка внутри и без того обведённой группы даёт коробку в
              коробке; вписанная рамка занимает те же пиксели, что и граница
              группы, и читается как «эта доля выбрана».
            */
            (lang === code
              ? "text-primary shadow-[inset_0_0_0_1px_var(--primary)]"
              : "text-muted hover:text-text")
          }
        >
          {LANG_NAMES[code].short}
        </button>
      ))}
    </div>
  );
}
