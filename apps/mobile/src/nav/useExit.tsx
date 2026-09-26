import { useCallback, useEffect, useRef } from "react";
import { BackHandler, Platform, Pressable, Text } from "react-native";
import { useRouter, useSegments, type Href } from "expo-router";
import { spacing, useColors } from "@/theme";
import { exitFrom } from "./exits";

/**
 * Исполнение решения exitFrom (exits.ts): назад, если есть куда, иначе — на
 * известное место заменой. Замена снимает текущий экран так же, как «назад»,
 * поэтому подтверждение выхода из незавершённого прохождения (beforeRemove в
 * survey/[id].tsx) срабатывает и здесь.
 */
export function useExit(): () => void {
  const router = useRouter();
  const segments = useSegments();
  return useCallback(() => {
    const exit = exitFrom(segments, router.canGoBack());
    if (!exit) return;
    if (exit.kind === "back") router.back();
    else router.replace(exit.href as Href);
  }, [router, segments]);
}

/**
 * Кнопка «назад» на Android там, где стеку возвращаться некуда.
 *
 * Навигатор обрабатывает кнопку сам, пока может; когда не может, система
 * сворачивает приложение — с экрана аналитики, открытого по ссылке, это
 * выглядит как «приложение закрылось», а при следующем открытии человек
 * оказывается там же. Обработчик вступает только тогда: стек может
 * вернуться — отдаём кнопку навигатору, не может и у экрана есть запасное
 * место — уходим туда; корень потока (вход, вкладки) — отдаём системе.
 *
 * Сегменты берутся из ref: подписка одна на всё приложение, а экран под ней
 * меняется.
 */
export function useHardwareBackFallback(): void {
  const router = useRouter();
  const segments = useSegments();
  const current = useRef<readonly string[]>(segments);
  current.current = segments;

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      const exit = exitFrom(current.current, router.canGoBack());
      if (exit?.kind !== "replace") return false;
      router.replace(exit.href as Href);
      return true;
    });
    return () => sub.remove();
  }, [router]);
}

/**
 * Левая кнопка шапки для экрана, позади которого может не оказаться ничего.
 *
 * Есть куда вернуться — не рисуется вовсе, и остаётся системная стрелка со
 * своим жестом. Некуда — вместо пустого места слева появляется «Закрити»,
 * уводящая на запасное место. Годится как `headerLeft` стека:
 * `headerLeft: ({ canGoBack }) => <ExitHeaderButton canGoBack={canGoBack} … />`.
 */
export function ExitHeaderButton({
  canGoBack,
  label,
  accessibilityLabel,
  always = false,
}: {
  canGoBack: boolean;
  label: string;
  accessibilityLabel?: string;
  /** Рисовать и тогда, когда стрелка была бы: у раздела аналитики своя подпись «‹ Меню» */
  always?: boolean;
}) {
  const c = useColors();
  const exit = useExit();
  if (canGoBack && !always) return null;
  return (
    <Pressable
      onPress={exit}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      hitSlop={12}
      style={{ paddingRight: spacing.sm }}
    >
      <Text style={{ color: c.primary, fontSize: 16 }}>{label}</Text>
    </Pressable>
  );
}
