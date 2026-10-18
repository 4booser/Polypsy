import { View } from "react-native";
import Svg, { Circle, G, Text as SvgText } from "react-native-svg";
import { font } from "../../fonts";
import { useColors } from "../../theme";

/**
 * Знак учреждения — круг и буквы POLSY, тот же рисунок, что в консоли
 * (apps/web/src/shell/Logo.tsx): крупные P и Y на общей базовой линии,
 * мелкие O, L и S между ними. Буквы — латинские знаки рисунка, а не слово,
 * поэтому не идут через словарь.
 *
 * Плашка — белая в обеих темах, знак фиолетовым бренда: знак учреждения не
 * меняет цвет от темы, а на полосе плашка и делает его знаком, а не пятном.
 */
export function LogoTile({ size = 36 }: { size?: 36 | 40 }) {
  const c = useColors();
  const mark = size === 40 ? 28 : 26;
  // Manrope, если загрузился; иначе системный — знак остаётся знаком
  const f = font(700);
  const face = "fontFamily" in f ? f.fontFamily : undefined;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round((size * 11) / 36),
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: c.onfill,
        borderWidth: 1,
        borderColor: c.bcardline,
      }}
    >
      <Svg width={mark} height={mark} viewBox="0 0 70 70">
        <Circle cx="35" cy="35" r="34" fill="none" stroke={c.v} strokeWidth={1.7} />
        <G fill={c.v} fontWeight="700" textAnchor="middle" fontFamily={face}>
          <SvgText x="15.2" y="46" fontSize="30">
            P
          </SvgText>
          <SvgText x="54" y="46" fontSize="30">
            Y
          </SvgText>
          <SvgText x="29.6" y="34" fontSize="17.9">
            O
          </SvgText>
          <SvgText x="41.7" y="34" fontSize="17.9">
            L
          </SvgText>
          <SvgText x="34.5" y="50" fontSize="17.9">
            S
          </SvgText>
        </G>
      </Svg>
    </View>
  );
}
