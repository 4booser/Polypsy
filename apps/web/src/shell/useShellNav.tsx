import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { sectionOf, subNavFor, type NavAccess, type NavCounts, type SectionKey, type SubNavData } from "./nav";
import { SubNav } from "./SubNav";

/*
 * Навигация консоли для экранов — хуки поверх данных nav.ts.
 *
 * Оболочка (App.tsx) кладёт сюда, кто вошёл (права) и счётчики консоли, и
 * сама рисует рельсу и колонку подразделов раздела. Экрану это ничего не
 * стоит. Хуки нужны экрану, которому навигация нужна в своём месте: своя
 * колонка вместо колонки раздела (оглавление, разделы настроек — набор
 * рисует их тем же .snav), пункт «назад» к разделу, число у вкладки.
 *
 * Вне оболочки консоли (кабинет пациента, гостевые страницы) значения нет —
 * хуки отвечают пусто, а не падают.
 */

export interface ShellNav {
  access: NavAccess;
  counts: NavCounts;
  /** Что человек убрал с глаз в настройках рабочего места */
  hidden: readonly string[];
}

const Ctx = createContext<ShellNav | null>(null);

export function ShellNavProvider({ value, children }: { value: ShellNav; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Права вошедшего и счётчики консоли; вне оболочки консоли — null */
export function useShellNav(): ShellNav | null {
  return useContext(Ctx);
}

/**
 * Подразделы раздела: по адресу экрана или названного явно. null — у
 * раздела колонки нет или вне оболочки консоли.
 */
export function useSubNav(section?: SectionKey): SubNavData | null {
  const nav = useContext(Ctx);
  const { pathname } = useLocation();
  const key = section ?? sectionOf(pathname);
  return useMemo(() => (nav && key ? subNavFor(key, pathname, nav.access, nav.counts) : null), [nav, key, pathname]);
}

/** Колонка подразделов текущего раздела — то, что оболочка ставит между рельсой и экраном */
export function SectionColumn() {
  const data = useSubNav();
  return data ? <SubNav data={data} /> : null;
}
