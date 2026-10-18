import Svg, { Circle, Ellipse, Line, Path, Polygon, Polyline, Rect } from "react-native-svg";
import { ICONS, type IconName } from "./icons";

export type { IconName };

/**
 * Значок набора на сетке 24, штрих 2 (lucide).
 *
 * Значок — украшение при подписи: голосовой доступ читает кнопку или строку,
 * в которой он стоит, а не саму картинку. Поэтому он скрыт от диктора, и
 * значок без подписи рядом — ошибка разметки, а не экономия места.
 */
export function Icon({
  name,
  size = 20,
  color,
  strokeWidth = 2,
}: {
  name: IconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {ICONS[name].map(([tag, a], i) => {
        switch (tag) {
          case "path":
            return <Path key={i} d={a.d} />;
          case "circle":
            return <Circle key={i} cx={a.cx} cy={a.cy} r={a.r} />;
          case "rect":
            return <Rect key={i} x={a.x ?? 0} y={a.y ?? 0} width={a.width} height={a.height} rx={a.rx} ry={a.ry} />;
          case "line":
            return <Line key={i} x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} />;
          case "polyline":
            return <Polyline key={i} points={a.points} />;
          case "polygon":
            return <Polygon key={i} points={a.points} />;
          case "ellipse":
            return <Ellipse key={i} cx={a.cx} cy={a.cy} rx={a.rx} ry={a.ry} />;
        }
        return null;
      })}
    </Svg>
  );
}
