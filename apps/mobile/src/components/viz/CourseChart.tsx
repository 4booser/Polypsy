import { useState } from "react";
import { View } from "react-native";
import Svg, { ClipPath, Circle, Defs, G, Line, Polyline, Rect, Text as SvgText } from "react-native-svg";
import type { Severity } from "@quizzy/shared";
import { useLang } from "@/lang";
import { useChart, useColors, useIsDark } from "../../theme";
import { SevPill } from "../../ui/Pill";
import { T } from "../../ui/Text";
import { courseLayout, type CourseBand, type CoursePoint } from "./course";
import { formatShort, svgFont, useMeasuredWidth } from "./primitives";

export type { CourseBand, CoursePoint };

/**
 * Курс по одной шкале на ширину телефона — «phone_course» набора
 * (screens/mobile_staff.py).
 *
 * Что на нём и зачем:
 *  — полосы выраженности со словами: число читают через полосу, в которой
 *    оно стоит, текущая полоса подсвечена;
 *  — межі похибки от базового замера (± порог надёжного изменения): всё,
 *    что внутри, — не изменение, а шум измерения; граница со стороны
 *    «краще» — пунктиром;
 *  — «сьогодні» и будущее справа от неё приглушено;
 *  — сигнал риска — красной меткой на оси, это риск для человека;
 *  — нажатие на точку — значение, слово полосы, дата и изменение от старта.
 *
 * Чего нет, хотя в наборе есть: прогноза («тренд, не оцінка»), цели курса и
 * сессий на оси — сервер их не отдаёт, а придумывать их на телефоне нельзя.
 */
export function CourseChart({
  points,
  max,
  min = 0,
  bands = [],
  better,
  unit,
  rc,
  today,
  signals = [],
  height = 156,
  valueLabel = formatShort,
}: {
  points: CoursePoint[];
  /** Верх шкалы; низ — min */
  max: number;
  min?: number;
  /** Полосы выраженности снизу вверх; step — ступень набора 0…4 */
  bands?: CourseBand[];
  /** Куда лучше: «краще ↓» у симптомов, «краще ↑» у благополучия */
  better?: "up" | "down";
  /** Подпись шкалы слева над осью: «бали 0–27» */
  unit?: string;
  /** Порог надёжного изменения (полуширина меж похибки); нет — зона не рисуется */
  rc?: number | null;
  /** «Сьогодні», мс */
  today?: number;
  /** Сигналы риска на оси времени */
  signals?: { t: number; label: string }[];
  /** Высота поля графика без подписей дат */
  height?: number;
  valueLabel?: (v: number) => string;
}) {
  const { ut } = useLang();
  const c = useColors();
  const chart = useChart();
  const darkTheme = useIsDark();
  const [width, onLayout] = useMeasuredWidth(326);
  const [picked, setPicked] = useState<number | null>(null);

  if (points.length === 0) return null;

  const L = courseLayout({ points, max, min, bands, rc, today, signals, width, plotHeight: height });
  const ink = darkTheme ? c.vink : c.v;
  const sel = picked ?? points.length - 1;
  const selPoint = points[sel]!;
  const base = points[0]!;
  const fill = (cls: "b0" | "b1" | "bc") => (cls === "bc" ? chart.plotc : cls === "b1" ? chart.plot2 : chart.plot);

  /** Подпись с ореолом цвета подложки: читается поверх полос и линий */
  const halo = (key: string, x: number, y: number, text: string, color: string, bg: string, weight: 600 | 700 | 800, size: number, anchor: "start" | "middle" | "end") => (
    <G key={key}>
      <SvgText x={x} y={y} fontSize={size} {...svgFont(weight)} textAnchor={anchor} fill={bg} stroke={bg} strokeWidth={4} strokeLinejoin="round">
        {text}
      </SvgText>
      <SvgText x={x} y={y} fontSize={size} {...svgFont(weight)} textAnchor={anchor} fill={color}>
        {text}
      </SvgText>
    </G>
  );

  const a11y = points.map((p) => `${valueLabel(p.value)} (${p.label})`).join(", ");
  const delta = selPoint.value - base.value;
  const deltaText = `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${valueLabel(Math.abs(delta))}`;

  return (
    <View onLayout={onLayout} style={{ gap: 10 }}>
      <Svg width={width} height={L.totalHeight} accessibilityLabel={a11y} accessible>
        <Defs>
          <ClipPath id="course-plot">
            <Rect x={L.left} y={L.top} width={L.plotWidth} height={L.plotHeight} rx={12} />
          </ClipPath>
        </Defs>

        {/* шкала и направление: «бали 0–27, краще ↓» */}
        {unit || better ? (
          <SvgText x={0} y={L.top - 12} fontSize={11} {...svgFont(600)} fill={c.muted}>
            {unit ? `${unit}${better ? ", " : ""}` : ""}
            {better ? `${ut("mui.better")} ${better === "up" ? "↑" : "↓"}` : ""}
          </SvgText>
        ) : null}

        <G clipPath="url(#course-plot)">
          <Rect x={L.left} y={L.top} width={L.plotWidth} height={L.plotHeight} fill={chart.plot} />
          {L.bands.map((b) => (
            <Rect key={`b${b.from}`} x={L.left} y={b.y0} width={L.plotWidth} height={b.y1 - b.y0} fill={fill(b.cls)} />
          ))}
          {L.bands
            .filter((b) => b.from > min)
            .map((b) => (
              <Line key={`s${b.from}`} x1={L.left} x2={L.left + L.plotWidth} y1={b.y1} y2={b.y1} stroke={chart.plotline} strokeWidth={2} />
            ))}
          {L.futureX !== null ? (
            <Rect x={L.futureX} y={L.top} width={L.left + L.plotWidth - L.futureX} height={L.plotHeight} fill={chart.future} />
          ) : null}
          {L.zone ? <Rect x={L.left} y={L.zone.y0} width={L.plotWidth} height={L.zone.y1 - L.zone.y0} fill={chart.rcz} /> : null}
        </G>

        {/* слово полосы — у правого края; текущая — фиолетовым */}
        {L.bands.map((b) =>
          b.label
            ? halo(`bl${b.from}`, L.left + L.plotWidth - 6, b.labelY, b.label, b.cls === "bc" ? c.vink : c.muted, fill(b.cls), b.cls === "bc" ? 800 : 700, 11, "end")
            : null,
        )}

        {/* деления оси — границы полос и верх шкалы */}
        {L.ticks.map((t) => (
          <SvgText key={`t${t.v}`} x={L.left - 6} y={t.y + 4} fontSize={11} {...svgFont(600)} fill={c.muted} textAnchor="end">
            {valueLabel(t.v)}
          </SvgText>
        ))}

        {/* граница надёжного улучшения от старта — пунктиром со стороны «краще» */}
        {L.zone && better ? (
          <Line
            x1={L.left}
            x2={L.left + L.plotWidth}
            y1={better === "up" ? L.zone.y0 : L.zone.y1}
            y2={better === "up" ? L.zone.y0 : L.zone.y1}
            stroke={c.vink}
            strokeWidth={1.2}
            strokeDasharray="4 3"
            opacity={0.85}
          />
        ) : null}

        {L.todayX !== null ? (
          <>
            <Line x1={L.todayX} x2={L.todayX} y1={L.top - 6} y2={L.top + L.plotHeight} stroke={c.text} strokeWidth={1.2} />
            <SvgText x={L.todayX} y={L.top - 10} fontSize={11} {...svgFont(800)} fill={c.text} textAnchor={L.todayX > L.left + L.plotWidth - 30 ? "end" : "middle"}>
              {ut("mui.today")}
            </SvgText>
          </>
        ) : null}

        {L.pts.length > 1 ? (
          <Polyline
            points={L.pts.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke={ink}
            strokeWidth={3}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}

        {L.pts.map((p, i) => (
          <G key={`p${i}`}>
            {i === sel ? <Circle cx={p.x} cy={p.y} r={10} fill={c.vtint} /> : null}
            <Circle cx={p.x} cy={p.y} r={i === sel ? 6 : 5} fill={ink} stroke={darkTheme ? chart.plot : c.panel} strokeWidth={2.5} />
          </G>
        ))}
        {L.pts.map((p, i) =>
          p.labeled || i === sel
            ? halo(`v${i}`, p.x + (i === 0 && L.pts.length > 1 ? 9 : 0), p.labelY, valueLabel(points[i]!.value), c.text, fill(p.cls), 800, 13, i === 0 && L.pts.length > 1 ? "start" : "middle")
            : null,
        )}

        {/* сигнал риска — красной меткой на оси */}
        {L.signals.map((s, i) => (
          <G key={`r${i}`}>
            <Rect x={s.x - 4.5} y={L.top + L.plotHeight - 4.5} width={9} height={9} rx={2.5} fill={c.risk} />
            {halo(`rt${i}`, s.x + (s.x > L.left + L.plotWidth - 90 ? -9 : 9), L.top + L.plotHeight - 7, s.label, c.riskink, c.panel, 700, 11, s.x > L.left + L.plotWidth - 90 ? "end" : "start")}
          </G>
        ))}

        {/* даты замеров под осью; сегодняшняя — жирнее */}
        {L.pts.map((p, i) => (
          <SvgText
            key={`d${i}`}
            x={p.x}
            y={L.top + L.plotHeight + 16}
            fontSize={11}
            {...svgFont(p.isToday ? 800 : 600)}
            fill={p.isToday ? c.text : c.muted}
            textAnchor={L.pts.length > 1 && i === 0 ? "start" : L.pts.length > 1 && i === L.pts.length - 1 ? "end" : "middle"}
          >
            {p.dateHidden ? "" : points[i]!.label}
          </SvgText>
        ))}

        {/* зоны нажатия: от середины до середины между точками */}
        {L.hits.map((h, i) => (
          <Rect
            key={`h${i}`}
            x={h.x0}
            y={L.top}
            width={h.x1 - h.x0}
            height={L.plotHeight + 22}
            fill="transparent"
            onPress={() => setPicked(i)}
          />
        ))}
      </Svg>

      {/* выбранный замер: значение, слово полосы, дата и изменение от старта */}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 8, rowGap: 4 }} accessibilityLiveRegion="polite">
        <T v="headline" num>
          {valueLabel(selPoint.value)}
        </T>
        {selPoint.severity || selPoint.bandLabel ? (
          <SevPill small severity={(selPoint.severity ?? "none") as Severity} step={selPoint.step} label={selPoint.bandLabel ?? undefined} />
        ) : null}
        <T v="sub" num>
          {selPoint.label}
          {sel > 0 ? `, ${ut("mui.fromStart").replace("{d}", deltaText)}` : ""}
        </T>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 6 }}>
        <LegendItem label={ut("mui.measures")}>
          <View style={{ width: 18, height: 3, borderRadius: 2, backgroundColor: ink }} />
        </LegendItem>
        {L.zone ? (
          <LegendItem label={ut("mui.rcZone")}>
            <View style={{ width: 16, height: 10, borderRadius: 3, backgroundColor: chart.rcz, borderWidth: 1, borderColor: c.vink, borderStyle: "dashed" }} />
          </LegendItem>
        ) : null}
        {L.signals.length ? (
          <LegendItem label={ut("mui.signal")}>
            <View style={{ width: 9, height: 9, borderRadius: 2.5, backgroundColor: c.risk }} />
          </LegendItem>
        ) : null}
      </View>
    </View>
  );
}

function LegendItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {children}
      <T v="sub" size={13} tone="text2">
        {label}
      </T>
    </View>
  );
}
