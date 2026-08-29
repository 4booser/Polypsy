import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { chartDark, chartLight, chartNight, dark, light, night } from "./palettes";
import { prefStorage } from "./storage";
import { SEVERITY_FILL, formatDuration as sharedDuration, type Severity } from "@quizzy/shared";





/*
 * Цвета берутся из общего пакета: «умеренная выраженность» обязана быть
 * одного цвета в отчёте на бумаге, на экране специалиста и на телефоне
 * обследуемого. Два набора значений однажды разошлись бы.
 */
export const severityColor = SEVERITY_FILL;

/**
 * Подписи степеней. Только для мест, где нет доступа к языковому контексту
 * (конструктор в мобилке). Везде, где есть `ut`, брать из словаря: там
 * подпись двуязычна, а здесь всегда по-русски.
 */
export const severityLabel: Record<Severity, string> = {
  none: "Норма",
  mild: "Лёгкая",
  moderate: "Умеренная",
  severe: "Выраженная",
};

export type Colors = typeof light;
export type ChartColors = typeof chartLight;

/**
 * Выбор темы.
 *
 * Системной настройки мало: приложение открывают и в казарме после отбоя, и в
 * кабинете при дневном свете, а телефон об этом не знает. Выбор хранится на
 * устройстве и переживает перезапуск.
 */
const THEME_KEY = "quizzy.theme";

export type ThemeChoice = "system" | "dark" | "light" | "night";


interface ThemeState {
  choice: ThemeChoice;
  setChoice: (c: ThemeChoice) => void;
  /*
   * Что рисовать. Ночной режим — отдельное значение, а не «тёмный»: экраны,
   * которые решают по нему (графики, метки выраженности), обязаны видеть
   * разницу, иначе ночью они нарисуют дневные цвета на тёплом фоне.
   */
  resolved: "dark" | "light" | "night";
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
  const resolved = useTheme().resolved;
  if (resolved === "night") return night;
  return resolved === "dark" ? dark : light;
}


export function useChart(): ChartColors {
  const resolved = useTheme().resolved;
  if (resolved === "night") return chartNight;
  return resolved === "dark" ? chartDark : chartLight;
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
/*
 * Скругления уменьшены вслед за консолью: крупный радиус на телефоне
 * визуально «надувает» карточки, а на экране прохождения важнее, чтобы
 * вариант ответа читался как кнопка, а не как капсула.
 */
export const radius = { sm: 6, md: 10, lg: 14 } as const;

/**
 * Типографика.
 *
 * Дисплейная гарнитура нужна только заголовкам и крупным числам; текст
 * пунктов методики набирается системным шрифтом — он лучше приспособлен к
 * длинному чтению и уважает системный масштаб.
 */
export const type = {
  display: { fontSize: 26, fontWeight: "600" as const, letterSpacing: -0.4 },
  title: { fontSize: 19, fontWeight: "600" as const, letterSpacing: -0.2 },
  body: { fontSize: 16, fontWeight: "400" as const },
  small: { fontSize: 14, fontWeight: "400" as const },
  caption: { fontSize: 12, fontWeight: "500" as const },
  /** Цифры выравниваются по столбцу: баллы и таймеры не должны «прыгать» */
  mono: { fontVariant: ["tabular-nums"] } as { fontVariant: ["tabular-nums"] },
} as const;

/** Длительность — из общего пакета, чтобы формат совпадал с консолью */
export const formatDuration = sharedDuration;
