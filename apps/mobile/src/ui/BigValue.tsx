import type { ReactNode } from "react";
import { View } from "react-native";
import type { Severity } from "@quizzy/shared";
import { useLang } from "../lang";
import { useColors } from "../theme";
import { SevPill } from "./Pill";
import { T } from "./Text";

/**
 * Крупное число с его смыслом: «14 з 27 — помірна».
 *
 * Число без сравнения и без слова — это не результат, а цифра: каждое крупное
 * значение несёт выраженность словом и, где есть, с чем сравнивать («було
 * 19», изменение от старта). Цвет степени — только на плашке со словом.
 */
export function BigValue({
  value,
  of,
  unit,
  severity,
  step,
  severityLabel,
  below,
  size = 44,
}: {
  value: number | string;
  /** Максимум шкалы: «з 27» */
  of?: number;
  /** Единица вместо максимума: «%» */
  unit?: string;
  severity?: Severity;
  /** Ступень набора 0…4, если у методики пять полос */
  step?: 0 | 1 | 2 | 3 | 4;
  /** Слово полосы методики; без него — слово степени из словаря */
  severityLabel?: string;
  /** Строка под числом: «було 19», изменение и его надёжность */
  below?: ReactNode;
  size?: 44 | 32;
}) {
  const c = useColors();
  const { ut } = useLang();
  const tail = unit ?? (of !== undefined ? `${ut("common.of")} ${of}` : null);
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 8, rowGap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <T v="number" size={size} num scale={false}>
            {value}
          </T>
          {tail ? (
            <T v="body" size={size === 44 ? 17 : 15} weight={700} color={c.muted} num scale={false}>
              {tail}
            </T>
          ) : null}
        </View>
        {severity || step !== undefined ? <SevPill severity={severity} step={step} label={severityLabel} /> : null}
      </View>
      {typeof below === "string" ? <T v="sub">{below}</T> : below}
    </View>
  );
}
