/**
 * Палитры приложения — без React и без react-native.
 *
 * Отдельным модулем, потому что контраст цветов проверяется тестом, а
 * `theme.tsx` тянет `useColorScheme` из react-native и в тестовом процессе не
 * загружается: react-native написан на Flow и не разбирается. Цвета — данные,
 * и место им там, откуда их можно взять без оболочки.
 */
import {
  SEVERITY_SCREEN_DARK,
  SEVERITY_SCREEN_LIGHT,
  SEVERITY_STEPS_SCREEN_BG_DARK,
  SEVERITY_STEPS_SCREEN_BG_LIGHT,
  SEVERITY_STEPS_SCREEN_DARK,
  SEVERITY_STEPS_SCREEN_LIGHT,
  type Severity,
} from "@quizzy/shared";

/*
 * «Виразна» — оформление Polypsy 2.0, телефонная форма.
 *
 * Значения — из набора дизайна (.superdesign/ui3/kit/page.py, словари LIGHT и
 * DARK), те же, что в консоли (apps/web/src/styles/tokens.css). Имена — как в
 * наборе: по ним разметку kit/*.py можно сверять строчка в строчку. Отступления
 * от набора те же, что в консоли, и подписаны на месте.
 *
 * Правила цвета:
 *  — фиолетовый — бренд, основное действие, выбор и «моё», больше ничего;
 *  — янтарь (warn) — «требует внимания»: просрочено, ждёт, не принято;
 *  — красный — только риск для человека: сигнал, критический ответ, 103;
 *    удаление и выход — обычные кнопки, ошибка формы — красный текст;
 *  — зелёный — сделано и надёжное улучшение;
 *  — выраженность никогда не говорит одним цветом: рядом всегда слово.
 *
 * Прежние имена (bg, card, cardAlt, primary, primaryText, accent, danger)
 * остаются и ведут на набор — экраны, ещё не переписанные, уже стоят в новой
 * палитре.
 */
export interface Palette {
  /* земля и поверхности: земля темнее листа, панели лежат на ней */
  ground: string;
  panel: string;
  panel2: string;
  sunk: string;
  sunk2: string;
  border: string;
  divider: string;
  ctl: string;
  /** Рамка поля ввода: 3:1 к листу и к земле — поле видно и в плохом свете */
  field: string;
  /* текст */
  text: string;
  text2: string;
  muted: string;
  /* фиолетовый: заливка, наведение, мягкие заливки, текст, кольцо, линия */
  v: string;
  vhov: string;
  vtint: string;
  vtint2: string;
  vink: string;
  vring: string;
  vline: string;
  /** Текст и значки на заливке фиолетовым или красным */
  onfill: string;
  /* полоса наверху экрана: шапка, крупный заголовок, полоса карточки */
  band: string;
  bcard: string;
  bcardline: string;
  tabhov: string;
  /* риск, внимание, сделано, сведения */
  risk: string;
  riskink: string;
  risktint: string;
  risktint2: string;
  riskline: string;
  warn: string;
  warntint: string;
  warntint2: string;
  warnline: string;
  good: string;
  goodtint: string;
  goodline: string;
  info: string;
  infotint: string;
  infotint2: string;
  /* всплывающее сообщение и подложка листа */
  tipbg: string;
  tipink: string;
  tipmute: string;
  scrim: string;
  /* прежние имена */
  bg: string;
  card: string;
  cardAlt: string;
  primary: string;
  primaryText: string;
  accent: string;
  danger: string;
}

export const light: Palette = {
  ground: "#F5F3FA",
  panel: "#FFFFFF",
  panel2: "#FAF8FD",
  sunk: "#F3EFF9",
  sunk2: "#E9E2F3",
  border: "#E6E1F0",
  divider: "#EFEBF5",
  ctl: "#D4CBE3",
  // набор рисует рамку поля ctl (1.56:1) — в плохом свете поле теряется
  field: "#8A80A0",
  text: "#221A33",
  text2: "#433A57",
  // на ступень темнее набора (#695F80), как в консоли: ≥ 5:1 на самой глубокой поверхности
  muted: "#645B7A",
  v: "#663399",
  vhov: "#55287F",
  vtint: "#EFE8F7",
  vtint2: "#E4D7F4",
  vink: "#5A2C8E",
  vring: "#663399",
  vline: "#D5C4EB",
  onfill: "#FFFFFF",
  band: "#EFE8F7",
  bcard: "#FFFFFF",
  bcardline: "#E2D6F1",
  tabhov: "rgba(102, 51, 153, 0.08)",
  risk: "#C62828",
  riskink: "#B71C1C",
  risktint: "#FCEBEC",
  risktint2: "#F9DEE0",
  riskline: "#F1C1C5",
  warn: "#8A5300",
  warntint: "#FFF1D9",
  warntint2: "#FCE6BF",
  warnline: "#EDD6A6",
  // на полшага темнее набора (#2E7D32), как в консоли: «зроблено» на своей подложке ≥ 4.5:1
  good: "#2C7A30",
  goodtint: "#E7F3E8",
  goodline: "#C9E1CB",
  info: "#2F4BA0",
  infotint: "#EAEFFB",
  infotint2: "#DCE4F7",
  tipbg: "#221A33",
  tipink: "#FFFFFF",
  tipmute: "#CEC4DE",
  scrim: "rgba(34, 26, 51, 0.42)",
  bg: "#F5F3FA",
  card: "#FFFFFF",
  cardAlt: "#F3EFF9",
  primary: "#663399",
  primaryText: "#FFFFFF",
  accent: "#8A5300",
  danger: "#B71C1C",
};

export const dark: Palette = {
  ground: "#141019",
  panel: "#1E1826",
  panel2: "#221B2B",
  sunk: "#272030",
  sunk2: "#30283B",
  border: "#2E2638",
  divider: "#2A2232",
  ctl: "#463A56",
  field: "#75698A",
  text: "#EDE8F5",
  text2: "#CEC5DD",
  muted: "#A79CBA",
  /*
   * Заливка фиолетовым темнее текста фиолетовым: белый на #7443AD — 6.67:1,
   * а как текст на тёмной земле он не читается. Текстом, линией и кольцом
   * идёт светлая ступень vink.
   */
  v: "#7443AD",
  vhov: "#8453BF",
  vtint: "#2C2140",
  vtint2: "#3A2B55",
  vink: "#C3A6F0",
  vring: "#C3A6F0",
  vline: "#4D3B70",
  onfill: "#FFFFFF",
  band: "#211932",
  bcard: "#271F35",
  bcardline: "#392D4E",
  tabhov: "rgba(195, 166, 240, 0.08)",
  risk: "#CF3434",
  riskink: "#FF8F86",
  risktint: "#3A1820",
  risktint2: "#4B1E29",
  riskline: "#6E2B36",
  warn: "#F0B957",
  warntint: "#2E2516",
  warntint2: "#3D311A",
  warnline: "#5A4626",
  good: "#74D19C",
  goodtint: "#15281E",
  goodline: "#24462F",
  info: "#A3B8F2",
  infotint: "#1D2340",
  infotint2: "#283055",
  tipbg: "#EDE8F5",
  tipink: "#141019",
  tipmute: "#433A57",
  scrim: "rgba(5, 3, 8, 0.62)",
  bg: "#141019",
  card: "#1E1826",
  cardAlt: "#272030",
  // основной цвет служит и текстом, и мелкой заливкой — светлая ступень, как в консоли
  primary: "#C3A6F0",
  primaryText: "#141019",
  accent: "#F0B957",
  danger: "#FF8F86",
};

/**
 * Ночная — тёмная, только тусклее: для дежурств и казармы после отбоя.
 *
 * Не отдельный мир, а та же тёмная «Виразна», уведённая вниз: земля почти
 * чёрная, текст на треть тусклее (≈ 12:1 вместо 14:1 у тёмной), фиолетовый
 * приглушён. Экран не светит на всю комнату, но обследование на двести
 * пунктов по-прежнему читается — контраст держит порог 4.5:1 и для
 * приглушённого текста.
 *
 * Прежняя ночная палитра была тёплой, без синего, — и вместе с брендом
 * теряла фиолетовый выбор и «моё»: выбранный ответ ночью выглядел не так,
 * как днём. Набор описывает ночную тему одним словом — «тусклее» (экран
 * профиля сотрудника, m-st-profile), — и она именно такая.
 *
 * Выраженность и риск не приглушаются: риск не становится меньше оттого,
 * что отбой. Ступени — тёмные из общего пакета.
 */
export const night: Palette = {
  ground: "#0C0A0F",
  panel: "#151119",
  panel2: "#18141D",
  sunk: "#1C1722",
  sunk2: "#231D2A",
  border: "#262030",
  divider: "#201A27",
  ctl: "#3D3349",
  field: "#6E6283",
  text: "#D2CBDD",
  text2: "#B7AEC6",
  muted: "#958BA6",
  v: "#5F3A91",
  vhov: "#6B44A1",
  vtint: "#211A2D",
  vtint2: "#2C2240",
  vink: "#A88DD3",
  vring: "#A88DD3",
  vline: "#3A2D52",
  onfill: "#EDE8F5",
  band: "#18121F",
  bcard: "#1D1726",
  bcardline: "#2E2440",
  tabhov: "rgba(168, 141, 211, 0.08)",
  risk: "#B83333",
  riskink: "#E8807A",
  risktint: "#2B1319",
  risktint2: "#36171F",
  riskline: "#55222B",
  warn: "#D6A453",
  warntint: "#231D11",
  warntint2: "#2E2515",
  warnline: "#45371D",
  good: "#68BC8D",
  goodtint: "#10201A",
  goodline: "#1C3527",
  info: "#93A5DA",
  infotint: "#161B31",
  infotint2: "#1E2440",
  tipbg: "#D2CBDD",
  tipink: "#0C0A0F",
  tipmute: "#3D3349",
  scrim: "rgba(0, 0, 0, 0.66)",
  bg: "#0C0A0F",
  card: "#151119",
  cardAlt: "#1C1722",
  primary: "#A88DD3",
  primaryText: "#0C0A0F",
  accent: "#D6A453",
  danger: "#E8807A",
};

/**
 * Палитра графиков.
 *
 * series — ряды c1…c5 набора, проверенные валидатором палитры (соседние пары
 * при всех видах цветового зрения). Закреплены за методиками: PHQ-9 c1, GAD-7
 * c2, PCL-5 c3, WHO-5 c4; c5 — прочее и сравнение. Назначаются по порядку и
 * не перетасовываются при смене числа рядов. В тёмной теме все пары проходят
 * только первые три: в точечных формах — не больше трёх цветов, четвёртый ряд
 * держится формой метки.
 *
 * Выраженность — отдельные зарезервированные роли (useSeverity в theme.tsx)
 * и рядами данных не служит никогда.
 */
export interface ChartPalette {
  series: string[];
  /** Один ряд — фиолетовый набора (--series) */
  bar: string;
  /** Линия сетки */
  grid: string;
  /** Базовая линия */
  base: string;
  /** Подписи осей */
  axis: string;
  /** Поле графика и полосы тяжести: обычная, чередующаяся, текущая */
  plot: string;
  plot2: string;
  plotc: string;
  /** Граница между полосами — цвет листа */
  plotline: string;
  /** Будущее справа от «сегодня» */
  future: string;
  /** Зона надёжного изменения от базового замера */
  rcz: string;
  /** Дорожка полосы и шкалы */
  track: string;
  /** Тепловая лестница h1…h5 — один фиолетовый тон — и текст на каждой ступени */
  heat: string[];
  heatInk: string[];
}

export const chartLight: ChartPalette = {
  series: ["#663399", "#B26A00", "#00897A", "#2F6BD0", "#8E86A0"],
  bar: "#663399",
  grid: light.divider,
  base: light.ctl,
  axis: light.muted,
  plot: "#FAF8FD",
  plot2: "#F2EDF9",
  plotc: "#E9E0F6",
  plotline: "#FFFFFF",
  future: "rgba(255, 255, 255, 0.55)",
  rcz: "rgba(102, 51, 153, 0.07)",
  track: "#E3DCEE",
  heat: ["#EFE8F7", "#DCCDEE", "#BB9DDE", "#8A5EC0", "#663399"],
  heatInk: ["#4E2678", "#4E2678", "#2E1650", "#FFFFFF", "#FFFFFF"],
};

export const chartDark: ChartPalette = {
  series: ["#9D73DC", "#C07C00", "#0F9C8C", "#5089EA", "#7A7190"],
  bar: "#C3A6F0",
  grid: dark.divider,
  base: dark.ctl,
  axis: dark.muted,
  plot: "#231C2C",
  plot2: "#292133",
  plotc: "#33274A",
  plotline: "#1E1826",
  future: "rgba(20, 16, 25, 0.38)",
  rcz: "rgba(195, 166, 240, 0.09)",
  track: "#3A3047",
  heat: ["#2C2140", "#3D2D5C", "#563F84", "#7A57B4", "#A982E3"],
  heatInk: ["#E6DAF8", "#E6DAF8", "#FFFFFF", "#FFFFFF", "#141019"],
};

/*
 * Ночью ряды те же и в том же порядке: серия «первая» обязана оставаться
 * первой, иначе один и тот же график днём и ночью показывал бы разные ряды
 * одним цветом. Тускнеют поле, сетка и подписи — вслед за листом.
 */
export const chartNight: ChartPalette = {
  ...chartDark,
  bar: night.vink,
  grid: night.divider,
  base: night.ctl,
  axis: night.muted,
  plot: "#1A151F",
  plot2: "#1F1925",
  plotc: "#281F37",
  plotline: night.panel,
  future: "rgba(12, 10, 15, 0.38)",
  rcz: "rgba(168, 141, 211, 0.08)",
  track: "#2E2638",
};

/**
 * Выраженность на экране телефона — из общего пакета, как в консоли.
 *
 * Пять ступеней (s0…s4) с подложками: шкалы вроде PHQ-9 различают «помірно
 * тяжку» и «тяжку». Четыре степени (Severity) — на них же: тяжёлая — s4.
 * Цвет ступени — и надпись на её подложке, и закрашенный отрезок шкалы.
 */
export interface SeverityPalette {
  /** Цвет степени: метка на графике и надпись на подложке */
  color: Record<Severity, string>;
  /** Подложка плашки степени */
  tint: Record<Severity, string>;
  /** Пять ступеней s0…s4 и их подложки */
  steps: readonly string[];
  stepTints: readonly string[];
}

const fourOfFive = (steps: readonly string[]): Record<Severity, string> => ({
  none: steps[0]!,
  mild: steps[1]!,
  moderate: steps[2]!,
  severe: steps[4]!,
});

export const severityLight: SeverityPalette = {
  color: SEVERITY_SCREEN_LIGHT,
  tint: fourOfFive(SEVERITY_STEPS_SCREEN_BG_LIGHT),
  steps: SEVERITY_STEPS_SCREEN_LIGHT,
  stepTints: SEVERITY_STEPS_SCREEN_BG_LIGHT,
};

export const severityDark: SeverityPalette = {
  color: SEVERITY_SCREEN_DARK,
  tint: fourOfFive(SEVERITY_STEPS_SCREEN_BG_DARK),
  steps: SEVERITY_STEPS_SCREEN_DARK,
  stepTints: SEVERITY_STEPS_SCREEN_BG_DARK,
};

/**
 * Тени — только у того, что висит или зовёт нажать: основная кнопка, лист
 * снизу, всплывающее сообщение, карточка на полосе. Панель на тёмной земле
 * тени не имеет вовсе. Запись — boxShadow (React Native 0.76+ и веб).
 */
export interface Shadows {
  panel: string;
  banner: string;
  tile: string;
  pop: string;
  sheet: string;
  primary: string;
}

const shadowLight: Shadows = {
  panel: "0px 1px 2px rgba(34, 26, 51, 0.04)",
  banner: "0px 1px 2px rgba(34, 26, 51, 0.05), 0px 6px 18px -10px rgba(76, 40, 120, 0.22)",
  tile: "0px 1px 2px rgba(34, 26, 51, 0.1), 0px 0px 0px 1px rgba(102, 51, 153, 0.1)",
  pop: "0px 18px 40px -12px rgba(34, 26, 51, 0.24), 0px 2px 8px rgba(34, 26, 51, 0.06)",
  sheet: "0px -2px 8px rgba(34, 26, 51, 0.06), 0px -24px 48px -16px rgba(34, 26, 51, 0.28)",
  primary: "0px 1px 2px rgba(102, 51, 153, 0.25), 0px 6px 14px -6px rgba(102, 51, 153, 0.55)",
};

const shadowDark: Shadows = {
  panel: "0px 0px 0px rgba(0, 0, 0, 0)",
  banner: "0px 1px 2px rgba(0, 0, 0, 0.3), 0px 8px 20px -12px rgba(0, 0, 0, 0.6)",
  tile: "0px 1px 2px rgba(0, 0, 0, 0.35), 0px 0px 0px 1px rgba(195, 166, 240, 0.14)",
  pop: "0px 18px 44px -12px rgba(0, 0, 0, 0.62), 0px 2px 8px rgba(0, 0, 0, 0.32)",
  sheet: "0px -2px 8px rgba(0, 0, 0, 0.3), 0px -24px 48px -16px rgba(0, 0, 0, 0.7)",
  primary: "0px 1px 2px rgba(0, 0, 0, 0.4), 0px 6px 14px -6px rgba(116, 67, 173, 0.6)",
};

/** Все палитры разом — для проверок контраста */
export const PALETTES = { light, dark, night } as const;
export const SHADOWS = { light: shadowLight, dark: shadowDark, night: shadowDark } as const;
export const CHARTS = { light: chartLight, dark: chartDark, night: chartNight } as const;
/** Ночью ступени — тёмные: риск не приглушается */
export const SEVERITIES = { light: severityLight, dark: severityDark, night: severityDark } as const;
