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
    /*
      Сегментированный переключатель, а не две кнопки рядом: две кнопки
      выглядят как два действия, а здесь одно состояние из двух. Текущий язык
      виден заливкой, а не только жирностью — жирность на трёх буквах
      прописными не читается.
    */
    <div
      role="group"
      aria-label="Мова / Язык"
      className="flex items-center gap-0.5 rounded-sm border border-border bg-surface-2 p-0.5"
    >
      {(["uk", "ru"] as const).map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => setLang(code)}
          aria-pressed={lang === code}
          className={
            "min-h-0 rounded-[4px] px-2 py-1 text-micro font-semibold tracking-[var(--tracking-label)] " +
            "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] " +
            (lang === code
              ? "bg-surface-3 text-text"
              : "text-faint hover:text-text")
          }
        >
          {code === "uk" ? "УКР" : "РУС"}
        </button>
      ))}
    </div>
  );
}
