import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { NativeModules, Platform } from "react-native";
import { prefStorage } from "./storage";
import { detectLang, makeUiT, type Lang, type UiKey } from "@quizzy/shared";

/**
 * Язык интерфейса мобилки.
 *
 * По умолчанию — из локали устройства (uk-* → украинский), переключается в
 * профиле и запоминается. Контент методик сервер отдаёт по Accept-Language,
 * который выставляет client.ts из этого же значения.
 */
const KEY = "quizzy.lang";

/** Текущий выбор — синхронно для API-клиента (он вне React) */
export let currentLang: Lang = "uk";

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
  ut: (k: UiKey) => string;
}

const Ctx = createContext<LangState | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangRaw] = useState<Lang>(() => detectLang(deviceLocales()));

  useEffect(() => {
    prefStorage.get(KEY).then((saved) => {
      if (saved === "uk" || saved === "ru") setLangRaw(saved);
    });
  }, []);

  useEffect(() => {
    currentLang = lang;
  }, [lang]);

  const value = useMemo<LangState>(
    () => ({
      lang,
      setLang: (l) => {
        void prefStorage.set(KEY, l);
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
