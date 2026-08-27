import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { prefStorage } from "./storage";

/**
 * Собственное укрупнение шрифта поверх системного.
 *
 * Системный масштаб приложение уважает и так. Но на методике в двести
 * пунктов человек сидит сорок минут, и часть обследуемых приходит после
 * бессонной смены или с контузией — им нужен размер крупнее того, что стоит
 * в системе, а лезть в настройки телефона посреди обследования никто не
 * будет.
 *
 * Множитель, а не набор размеров: он применяется к любому кеглю и не требует
 * заводить второй комплект чисел, который разъедется с первым.
 */
const KEY = "quizzy.textScale";
const STEPS = [1, 1.15, 1.3] as const;

interface Ctx {
  scale: number;
  /** Следующий шаг по кругу: одна кнопка вместо трёх */
  cycle: () => void;
  /** Размер с учётом укрупнения */
  fs: (base: number) => number;
}

const TextScaleCtx = createContext<Ctx>({ scale: 1, cycle: () => {}, fs: (b) => b });

export function TextScaleProvider({ children }: { children: ReactNode }) {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    void prefStorage.get(KEY).then((v) => {
      const n = Number(v);
      if (STEPS.includes(n as never)) setScale(n);
    });
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      scale,
      cycle: () => {
        const next = STEPS[(STEPS.indexOf(scale as never) + 1) % STEPS.length]!;
        setScale(next);
        void prefStorage.set(KEY, String(next));
      },
      fs: (base: number) => Math.round(base * scale),
    }),
    [scale],
  );

  return <TextScaleCtx.Provider value={value}>{children}</TextScaleCtx.Provider>;
}

export const useTextScale = () => useContext(TextScaleCtx);
