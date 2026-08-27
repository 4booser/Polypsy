import { useColorScheme } from "react-native";
import { SEVERITY_FILL, formatDuration as sharedDuration, type Severity } from "@quizzy/shared";

const light = {
  bg: "#f6f7f9",
  card: "#ffffff",
  cardAlt: "#f1f3f6",
  text: "#111318",
  muted: "#6b7280",
  border: "#e3e6ea",
  primary: "#3b5bfd",
  primaryText: "#ffffff",
  danger: "#d03b3b",
};

const dark: typeof light = {
  bg: "#0f1115",
  card: "#181b21",
  cardAlt: "#20242c",
  text: "#f3f4f6",
  muted: "#9aa1ad",
  border: "#2a2f38",
  primary: "#6b83ff",
  primaryText: "#0f1115",
  danger: "#e05a5a",
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
  series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"],
  bar: light.primary,
  grid: "#e1e0d9",
  axis: "#898781",
};

const chartDark: typeof chartLight = {
  series: ["#3987e5", "#d95926", "#199e70", "#c98500"],
  bar: dark.primary,
  grid: "#2c2c2a",
  axis: "#898781",
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

export function useColors(): Colors {
  return useColorScheme() === "dark" ? dark : light;
}

export function useChart(): ChartColors {
  return useColorScheme() === "dark" ? chartDark : chartLight;
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 12, lg: 16 } as const;

/** Длительность — из общего пакета, чтобы формат совпадал с консолью */
export const formatDuration = sharedDuration;
