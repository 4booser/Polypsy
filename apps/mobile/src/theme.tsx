import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import {
  CHARTS,
  PALETTES,
  SEVERITIES,
  SHADOWS,
  type ChartPalette,
  type Palette,
  type SeverityPalette,
  type Shadows,
} from "./palettes";
import { prefStorage } from "./storage";
import { currentLang } from "./currentLang";
import { font } from "./fonts";
import { SEVERITY_FILL, formatDuration as sharedDuration, type Severity, type UiKey } from "@quizzy/shared";

/*
 * Заливка выраженности, одинаковая во всех темах, — для экранов, ещё не
 * переписанных на useSeverity(). Новые места берут ступени темы: «помірна»
 * обязана быть одного цвета на экране специалиста и на телефоне, а ступени
 * консоли подобраны под подложку каждой темы (packages/shared/src/palette.ts).
 */
export const severityColor = SEVERITY_FILL;

/**
 * Ключи подписей степеней — как в консоли, из общего словаря.
 *
 * Здесь лежала своя копия подписей простыми строками, с оговоркой «только
 * для мест, где нет языкового контекста». Оговорка устарела: оба места,
 * которые ею пользовались, языковой контекст имеют. Копия же означала
 * русские подписи в украинском режиме и второй список, который однажды
 * разойдётся с первым.
 */
export const severityKey = {
  none: "severity.none",
  mild: "severity.mild",
  moderate: "severity.moderate",
  severe: "severity.severe",
} as const satisfies Record<Severity, UiKey>;

export type Colors = Palette;
export type ChartColors = ChartPalette;

/**
 * Выбор темы.
 *
 * Системной настройки мало: приложение открывают и в казарме после отбоя, и в
 * кабинете при дневном свете, а телефон об этом не знает. Выбор хранится на
 * устройстве и переживает перезапуск.
 */
const THEME_KEY = "quizzy.theme";

export type ThemeChoice = "system" | "dark" | "light" | "night";
export type ResolvedTheme = "dark" | "light" | "night";

interface ThemeState {
  choice: ThemeChoice;
  setChoice: (c: ThemeChoice) => void;
  /*
   * Что рисовать. Ночной режим — отдельное значение, а не «тёмный»: экраны,
   * которые решают по нему (графики, метки выраженности), обязаны видеть
   * разницу, иначе ночью они нарисуют дневные цвета на тусклом листе.
   */
  resolved: ResolvedTheme;
}

const ThemeCtx = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme() === "dark" ? "dark" : "light";
  const [choice, setChoiceRaw] = useState<ThemeChoice>("system");

  useEffect(() => {
    void prefStorage.get(THEME_KEY).then((saved) => {
      if (saved === "dark" || saved === "light" || saved === "system" || saved === "night") {
        setChoiceRaw(saved);
      }
    });
  }, []);

  const value = useMemo<ThemeState>(
    () => ({
      choice,
      resolved: choice === "system" ? system : choice,
      setChoice: (next) => {
        setChoiceRaw(next);
        void prefStorage.set(THEME_KEY, next);
      },
    }),
    [choice, system],
  );

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeCtx);
  // без провайдера отдаём системную тему: экраны вне оболочки (сплэш) целы
  const system = useColorScheme() === "dark" ? "dark" : "light";
  return ctx ?? { choice: "system", resolved: system, setChoice: () => {} };
}

export function useColors(): Colors {
  return PALETTES[useTheme().resolved];
}

export function useChart(): ChartColors {
  return CHARTS[useTheme().resolved];
}

/** Ступени выраженности текущей темы: цвет с подложкой, четыре степени и пять ступеней */
export function useSeverity(): SeverityPalette {
  return SEVERITIES[useTheme().resolved];
}

/** Тени текущей темы */
export function useShadows(): Shadows {
  return SHADOWS[useTheme().resolved];
}

/** Светлая или тёмная — для строки состояния и системных элементов */
export function useIsDark(): boolean {
  return useTheme().resolved !== "light";
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/**
 * Скругления набора: поле и кнопка 12, панель 14, плитка ответа и список 16,
 * лист снизу 22. Прежние sm/md/lg ведут на них же.
 */
export const radius = {
  sm: 10,
  md: 14,
  lg: 16,
  control: 12,
  panel: 14,
  tile: 16,
  sheet: 22,
  pill: 999,
} as const;

/**
 * Типографика телефона — Manrope, шкала набора (CSS_PHONE в kit/page.py).
 *
 * Тело не мельче 16: обследуемый читает методику сорок минут, часто после
 * бессонной смены. Цифры — моноширинные (tabular-nums): баллы, таймеры и
 * счётчики не «прыгают», а стоят столбцом.
 *
 * Стили — геттеры, а не готовые объекты: начертание зависит от того,
 * загрузился ли шрифт (fonts.ts), а это выясняется после загрузки модуля.
 */
const tracking = (size: number, em: number) => Math.round(size * em * 100) / 100;

export const type = {
  /** Крупный заголовок экрана на полосе — 30/36 */
  get largeTitle() {
    return { fontSize: 30, lineHeight: 36, letterSpacing: tracking(30, -0.03), ...font(800) };
  },
  /** Формулировка пункта методики — 25/33 */
  get question() {
    return { fontSize: 25, lineHeight: 33, letterSpacing: tracking(25, -0.02), ...font(800) };
  },
  /** Заголовок листа снизу — 22/28 */
  get sheetTitle() {
    return { fontSize: 22, lineHeight: 28, letterSpacing: tracking(22, -0.02), ...font(800) };
  },
  /** Заголовок раздела — 18/24 */
  get section() {
    return { fontSize: 18, lineHeight: 24, letterSpacing: tracking(18, -0.015), ...font(800) };
  },
  /** Компактный заголовок шапки — 17/22 */
  get navTitle() {
    return { fontSize: 17, lineHeight: 22, letterSpacing: tracking(17, -0.01), ...font(800) };
  },
  /** Заголовок строки и карточки — 16/22 */
  get headline() {
    return { fontSize: 16, lineHeight: 22, letterSpacing: tracking(16, -0.01), ...font(800) };
  },
  /** Подзаголовок под крупным заголовком — 16/22 */
  get lead() {
    return { fontSize: 16, lineHeight: 22, ...font(600) };
  },
  /** Заметка и пояснение в панели — 15/21 */
  get note() {
    return { fontSize: 15, lineHeight: 21, ...font(500) };
  },
  /** Подпись под заголовком строки — 14/19 */
  get sub() {
    return { fontSize: 14, lineHeight: 19, ...font(600) };
  },
  /** Крупное число с выраженностью — 44 */
  get number() {
    return { fontSize: 44, lineHeight: 48, letterSpacing: tracking(44, -0.04), ...font(800) };
  },

  /* прежние имена — экраны до переписывания */
  get display() {
    return { fontSize: 26, lineHeight: 32, letterSpacing: tracking(26, -0.025), ...font(800) };
  },
  get title() {
    return { fontSize: 18, lineHeight: 24, letterSpacing: tracking(18, -0.015), ...font(800) };
  },
  get body() {
    return { fontSize: 16, lineHeight: 24, ...font(500) };
  },
  get small() {
    return { fontSize: 14, lineHeight: 19, ...font(500) };
  },
  get caption() {
    return { fontSize: 12, lineHeight: 16, ...font(600) };
  },
  /** Цифры выравниваются по столбцу: баллы и таймеры не должны «прыгать» */
  mono: { fontVariant: ["tabular-nums"] } as { fontVariant: ["tabular-nums"] },
};

/**
 * Длительность — из общего пакета, чтобы формат совпадал с консолью.
 *
 * Язык — текущий язык приложения (currentLang): единицы у языков разные
 * («4 хв», «4 мин», «4 min»). Модуль, а не хук: зовут её прямо в разметке
 * десятка экранов, и каждый из них и так перерисовывается при смене языка.
 */
export const formatDuration = (ms: number): string => sharedDuration(ms, currentLang);
