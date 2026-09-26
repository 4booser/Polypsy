import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { NativeModules, Platform } from "react-native";
import { prefStorage } from "./storage";
import { setCurrentLang } from "./currentLang";
import { refreshPushLang } from "./push";
import { LOCALE_OF, detectLang, isLang, makeUiT, type Lang, type UiKey } from "@quizzy/shared";

/**
 * Язык интерфейса мобилки.
 *
 * По умолчанию — из локали устройства (первый из uk/ru/en в списке языков
 * телефона, см. detectLang), переключается в профиле и на входе и
 * запоминается. Контент методик сервер отдаёт по Accept-Language,
 * который выставляет client.ts из этого же значения.
 */
const KEY = "quizzy.lang";

/*
 * Текущий выбор — синхронно для тех, кто вне React. Значение живёт в
 * отдельном модуле без зависимостей: его спрашивает и очередь несданных
 * прохождений, а она обязана оставаться проверяемой без эмулятора.
 */
export { currentLang } from "./currentLang";

function deviceLocales(): string[] {
  if (Platform.OS === "web" && typeof navigator !== "undefined") {
    return [...(navigator.languages ?? [navigator.language])];
  }
  const settings = NativeModules.SettingsManager?.settings;
  const ios = settings?.AppleLanguages as string[] | undefined;
  const android = NativeModules.I18nManager?.localeIdentifier as string | undefined;
  return ios ?? (android ? [android] : []);
}

interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Перевод по ключу; второй аргумент — чем заменить неизвестный ключ, см. makeUiT */
  ut: (k: UiKey, fallback?: string) => string;
  /**
   * Локаль дат и времени — по языку приложения, а не устройства.
   *
   * Экраны писали `toLocaleDateString([])`, то есть по локали телефона: на
   * украинском приложении в телефоне с английской системой дата выходила
   * американской — «9/2/2026», месяц первым. Теперь дата говорит на том же
   * языке, что и подпись рядом с ней (LOCALE_OF: у английского en-GB).
   */
  locale: string;
}

const Ctx = createContext<LangState | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangRaw] = useState<Lang>(() => detectLang(deviceLocales()));

  useEffect(() => {
    prefStorage.get(KEY).then((saved) => {
      if (isLang(saved)) setLangRaw(saved);
    });
  }, []);

  useEffect(() => {
    setCurrentLang(lang);
    /*
     * После setCurrentLang, а не в setLang: регистрация уходит с заголовком
     * Accept-Language из currentLang, и до этой строки там ещё старый язык.
     */
    void refreshPushLang();
  }, [lang]);

  const value = useMemo<LangState>(
    () => ({
      lang,
      setLang: (l) => {
        void prefStorage.set(KEY, l);
        setLangRaw(l);
      },
      ut: makeUiT(lang),
      locale: LOCALE_OF[lang],
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
