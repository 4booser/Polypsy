import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { detectLang, makeUiT, type Lang, type UiKey } from "@quizzy/shared";

/**
 * Язык консоли.
 *
 * Госпиталь украинский, и держать оболочку только на русском — не мелочь:
 * специалист читает эти экраны каждый день. Содержимое методик уже
 * двуязычно, а обёртка вокруг него была зашита в разметку.
 *
 * По умолчанию — из настроек браузера (uk-* → украинский), переключается в
 * боковой панели и запоминается. Тот же выбор уходит в Accept-Language,
 * чтобы сервер отдавал контент методик на том же языке.
 */
const KEY = "quizzy.web.lang";

/** Текущий выбор — синхронно для api.ts, который живёт вне React */
export let currentLang: Lang = "uk";

interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Перевод по ключу */
  ut: (k: UiKey) => string;
}

const Ctx = createContext<LangState | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangRaw] = useState<Lang>(() => {
    const saved = localStorage.getItem(KEY);
    if (saved === "uk" || saved === "ru") return saved;
    return detectLang(navigator.languages ?? [navigator.language]);
  });

  useEffect(() => {
    currentLang = lang;
    localStorage.setItem(KEY, lang);
    // язык страницы — для экранного диктора и переносов слов
    document.documentElement.lang = lang;
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
    <div className="lang-switch" role="group" aria-label="Мова / Язык">
      <button className={lang === "uk" ? "active" : ""} onClick={() => setLang("uk")}>УКР</button>
      <button className={lang === "ru" ? "active" : ""} onClick={() => setLang("ru")}>РУС</button>
    </div>
  );
}
