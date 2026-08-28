import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { prefStorage } from "./storage";
import { SEVERITY_FILL, formatDuration as sharedDuration, type Severity } from "@quizzy/shared";

/*
 * Палитра «Пульт» — та же, что в консоли.
 *
 * Приложение открывают в казарме после отбоя и в кабинете без окна, поэтому
 * основная тема тёмная, а светлая подобрана отдельно, а не инверсией.
 * Янтарный занят смыслом «требует внимания» и на кнопки не идёт: если им
 * покрашено всё подряд, он перестаёт что-либо значить.
 */
const light = {
  bg: "#f7f9f8",
  card: "#ffffff",
  cardAlt: "#f0f4f3",
  text: "#0e1a1c",
  muted: "#5b6f71",
  border: "#d9e2e0",
  primary: "#0f6f77",
  primaryText: "#ffffff",
  accent: "#8f5600",
  danger: "#b93030",
};

const dark: typeof light = {
  bg: "#0c1416",
  card: "#121d20",
  cardAlt: "#18272b",
  text: "#e8f0ee",
  muted: "#93acaa",
  border: "#22353a",
  primary: "#6fc3c9",
  primaryText: "#08100f",
  accent: "#ffb000",
  danger: "#d95757",
};

/**
 * Палитра диаграмм.
 *
 * severity — зарезервированные статусные роли: они одинаковы в обеих темах и
 * никогда не переиспользуются под серии данных. На светлой поверхности warning и
 * serious дают контраст ниже 3:1, поэтому выраженность везде рисуется как
 * «цветная метка + подпись», а не цветом в одиночку.
 *
 * series — категориальные слоты в фиксированном порядке; они назначаются по
 * порядку и не перетасовываются при смене числа серий.
 */
const chartLight = {
  series: ["#1f6f9e", "#b35a24", "#2f7d52", "#6a4aa0", "#8a6f14", "#2f7f7a"],
  bar: light.primary,
  grid: "#dbe4e2",
  axis: "#5b6f71",
};

const chartDark: typeof chartLight = {
  series: ["#3d9bd4", "#d97b3f", "#4a9d6e", "#9b7bd4", "#c9a227", "#4fb3ad"],
  bar: dark.primary,
  grid: "#22353a",
  axis: "#93acaa",
};

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

export type ThemeChoice = "system" | "dark" | "light";

interface ThemeState {
  choice: ThemeChoice;
  setChoice: (c: ThemeChoice) => void;
  resolved: "dark" | "light";
}

const ThemeCtx = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme() === "dark" ? "dark" : "light";
  const [choice, setChoiceRaw] = useState<ThemeChoice>("system");

  useEffect(() => {
    void prefStorage.get(THEME_KEY).then((saved) => {
      if (saved === "dark" || saved === "light" || saved === "system") setChoiceRaw(saved);
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
  return useTheme().resolved === "dark" ? dark : light;
}

export function useChart(): ChartColors {
  return useTheme().resolved === "dark" ? chartDark : chartLight;
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
