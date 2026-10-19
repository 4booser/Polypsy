import { useSyncExternalStore } from "react";

/*
 * Тема — выбор человека из трёх: светлая, тёмная, «як у системі».
 *
 * Выбор живёт там же, где жил: в браузере под ключом quizzy.theme.v2 (чтобы
 * консоль не мигнула чужим оформлением, пока летит профиль) и в настройках
 * рабочего места на сервере (сотрудник садится за разные машины). Здесь
 * только одно место, где он хранится в памяти вкладки: переключатель на
 * полосе, «Обліковий запис», профиль пациента и палитра команд читали и
 * писали его каждый по-своему, и смена темы в одном месте не доходила до
 * другого — переключатель на полосе показывал прежнюю тему.
 *
 * Умолчание прежнее — светлая: макет нарисован на белом листе. «Як у
 * системі» — выбор, а не умолчание: системная настройка на общем
 * компьютере кабинета часто не отражает освещения помещения.
 */

export type ThemeChoice = "light" | "dark" | "system";
export type Theme = "light" | "dark";

export const THEME_KEY = "quizzy.theme.v2";
export const THEME_CHOICES: readonly ThemeChoice[] = ["light", "dark", "system"];

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === "light" || v === "dark" || v === "system";
}

function readStored(): ThemeChoice {
  try {
    const v = typeof localStorage === "undefined" ? null : localStorage.getItem(THEME_KEY);
    return isThemeChoice(v) ? v : "light";
  } catch {
    // хранилище закрыто (приватный режим) — консоль работает в умолчании
    return "light";
  }
}

let choice: ThemeChoice = readStored();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  /*
   * Системная тема меняется сама — вечером, по расписанию ОС. При выборе
   * «як у системі» консоль обязана поменяться вместе с ней, без перезагрузки.
   */
  const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(DARK_QUERY) : null;
  mq?.addEventListener("change", fn);
  return () => {
    listeners.delete(fn);
    mq?.removeEventListener("change", fn);
  };
}

export function getThemeChoice(): ThemeChoice {
  return choice;
}

/** Системная тема прямо сейчас */
export function systemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

/** Какую тему рисовать при этом выборе */
export function resolveTheme(c: ThemeChoice, system: Theme = systemTheme()): Theme {
  return c === "system" ? system : c;
}

/**
 * Поменять выбор во вкладке и в браузере.
 *
 * `remember: false` — когда выбор пришёл с сервера при входе: он и так
 * лежит в профиле, а писать его в браузер значило бы, что умолчание
 * общего компьютера переписывает каждый вошедший. Запись в профиль —
 * дело вызывающего (App.persist): здесь про сервер не знают.
 */
export function setThemeChoice(next: ThemeChoice, { remember = true }: { remember?: boolean } = {}): void {
  if (remember) {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // запись запрещена — выбор действует до перезагрузки
    }
  }
  if (next === choice) return;
  choice = next;
  emit();
}

/**
 * Вернуть выбор этого браузера: вошедший ушёл, а тему из его профиля браузер
 * не запоминал (`remember: false` при входе). Иначе на общем компьютере
 * следующий — и экран входа до него — получал тему ушедшего.
 */
export function restoreStoredTheme(): void {
  setThemeChoice(readStored(), { remember: false });
}

/** Выбор человека — то, что отмечено на переключателе */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, getThemeChoice, (): ThemeChoice => "light");
}

/** Тема, которую рисовать: выбор с учётом системы */
export function useResolvedTheme(): Theme {
  const c = useThemeChoice();
  const sys = useSyncExternalStore(subscribe, systemTheme, (): Theme => "light");
  return resolveTheme(c, sys);
}

/** Только для проверок: вернуть хранилище в исходное состояние */
export function resetThemeForTest(next: ThemeChoice = readStored()): void {
  choice = next;
  emit();
}
