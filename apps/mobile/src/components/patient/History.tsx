import { Fragment } from "react";
import { View } from "react-native";
import { useLang } from "../../lang";
import { useColors } from "../../theme";
import { Icon } from "../../ui/Icon";
import { T } from "../../ui/Text";
import { localDecimal } from "../viz/math";

/** Сколько последних замеров стоит плитками: больше трёх на 390 не читается */
const HISTORY_TILES = 3;

/** Балл для человека: целое как есть, дробное — с одним знаком и запятой по-украински и по-русски */
export const formatScore = (v: number) => (Number.isInteger(v) ? String(v) : localDecimal(String(Math.round(v * 10) / 10)));

/**
 * Последние замеры плитками «дата — значение» через шеврон; последний —
 * фиолетовым. Не график: по трём точкам на телефоне график показывает шум,
 * а читается как тенденция; три числа с датами говорят ровно то, что
 * известно. Так на «Здоров’ї» и в итоге методики.
 */
export function HistoryTiles({ points, label }: { points: { submittedAt: string; value: number }[]; label: string }) {
  const c = useColors();
  const { locale } = useLang();
  const tiles = points.slice(-HISTORY_TILES);
  const day = (iso: string) => new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
  return (
    <View accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 }}>
      {tiles.map((p, i) => {
        const now = i === tiles.length - 1;
        return (
          <Fragment key={`${p.submittedAt}-${i}`}>
            {i ? <Icon name="chevron-right" size={15} color={c.muted} /> : null}
            <View
              accessible
              accessibilityLabel={`${day(p.submittedAt)}: ${formatScore(p.value)}`}
              style={{
                flex: 1,
                height: 40,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 6,
                paddingHorizontal: 12,
                borderRadius: 12,
                backgroundColor: now ? c.vtint : c.sunk,
                borderWidth: now ? 1 : 0,
                borderColor: c.vline,
              }}
            >
              <T v="sub" num scale={false} color={now ? c.vink : c.muted}>
                {day(p.submittedAt)}
              </T>
              <T v="headline" size={17} num scale={false} color={now ? c.vink : c.text}>
                {formatScore(p.value)}
              </T>
            </View>
          </Fragment>
        );
      })}
    </View>
  );
}
