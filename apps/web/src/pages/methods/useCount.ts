import { useCallback } from "react";
import type { UiKey } from "@quizzy/shared";
import { locale } from "../../format";
import { useLang } from "../../lang";
import { pluralForm } from "../../ui/plural";

/** Слова, которые раздел ставит при числе: «9 пунктів», «1 шкала», «231 людина» */
export type CountNoun = "items" | "scales" | "bands" | "methods" | "responses" | "people" | "admins" | "steps" | "batteries" | "groups";

/** Число с группировкой разрядов языка страницы: «1 342» */
export function num(n: number): string {
  return new Intl.NumberFormat(locale()).format(n);
}

/**
 * Число со словом в нужной форме (mc.n.<слово>.one|few|many). Только
 * слово — без числа — даёт `word`.
 */
export function useCount() {
  const { ut, lang } = useLang();
  return useCallback(
    (n: number, noun: CountNoun) => `${num(n)} ${ut(`mc.n.${noun}.${pluralForm(n, lang)}` as UiKey)}`,
    [ut, lang],
  );
}
