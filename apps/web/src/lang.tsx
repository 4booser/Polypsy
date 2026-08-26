import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { detectLang, makeUiT, type Lang, type UiKey } from "@quizzy/shared";

/**
 * Язык интерфейса публичных страниц (киоск, приглашение).
 *
 * Определяется по языкам браузера (uk-* → украинский), переключается вручную
 * и запоминается. Контент методик сервер отдаёт по заголовку Accept-Language —
 * браузер шлёт его сам; выбранный вручную язык добавляется параметром.
 */
const KEY = "quizzy.web.lang";

interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
  ut: (k: UiKey) => string;
}

const Ctx = createContext<LangState | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangRaw] = useState<Lang>(() => {
    const saved = localStorage.getItem(KEY);
    if (saved === "uk" || saved === "ru") return saved;
    return detectLang(navigator.languages ?? [navigator.language]);
  });
  const value = useMemo<LangState>(
    () => ({
      lang,
      setLang: (l) => {
        localStorage.setItem(KEY, l);
        setLangRaw(l);
      },
      ut: makeUiT(lang),
    }),
    [lang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang(): LangState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLang вне LangProvider");
  return ctx;
}

/** Кнопки-переключатели языка для публичных страниц */
export function LangSwitch() {
  const { lang, setLang } = useLang();
  return (
    <div className="lang-switch" role="group" aria-label="Мова / Язык">
      <button className={lang === "uk" ? "active" : ""} onClick={() => setLang("uk")}>УКР</button>
      <button className={lang === "ru" ? "active" : ""} onClick={() => setLang("ru")}>РУС</button>
    </div>
  );
}
