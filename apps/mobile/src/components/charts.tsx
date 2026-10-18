import { View } from "react-native";
import type { Severity } from "@quizzy/shared";
import { radius, spacing, useChart, useColors, useSeverity } from "../theme";
import { SEVERITY_KEY } from "@quizzy/shared";
import { useLang } from "../lang";
import { T } from "../ui/Text";
import { Panel } from "../ui/Panel";
import { Body } from "./ui";

/**
 * Диаграммы собраны на View: столбики тонкие, с закруглённым концом и
 * прижаты к базовой линии, между сегментами — зазор цвета поверхности,
 * подписи стоят рядом со значением, сетка и оси приглушены.
 *
 * Цвета — палитра графиков «Виразной» (useChart): один ряд — фиолетовый
 * набора, дорожка — track; выраженность — ступени темы (useSeverity) и
 * всегда со словом.
 */

const BAR_HEIGHT = 10;
const SEGMENT_GAP = 2;

/** Крупная цифра-показатель с подписью. Без графика — это осознанно не диаграмма. */
export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  const c = useColors();
  return (
    <View
      style={{
        flex: 1,
        minWidth: 140,
        backgroundColor: c.panel,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: radius.panel,
        padding: spacing.lg,
        gap: 2,
      }}
    >
      <T v="sub">{label}</T>
      <T v="number" size={32} num scale={false}>
        {value}
      </T>
      {hint ? <T v="sub">{hint}</T> : null}
    </View>
  );
}

/** Горизонтальные столбики одной серии: величина + прямая подпись у каждого */
export function BarList({
  items,
  valueFormatter,
  /** Единица приписывается к числу вплотную: «37%», а не «37 · %» */
  unit,
}: {
  items: { label: string; value: number; caption?: string; color?: string }[];
  valueFormatter?: (value: number) => string;
  unit?: string;
}) {
  const chart = useChart();
  const max = Math.max(...items.map((i) => i.value), 1);

  return (
    <View style={{ gap: spacing.md }}>
      {items.map((item, i) => (
        <View key={i} style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: spacing.sm }}>
            <T v="body" size={15} style={{ flex: 1 }} numberOfLines={2}>
              {item.label}
            </T>
            <T v="sub" size={14} weight={700} tone="text2" num>
              {valueFormatter ? valueFormatter(item.value) : item.value}
              {unit ?? ""}
              {item.caption ? `, ${item.caption}` : ""}
            </T>
          </View>
          <View style={{ height: BAR_HEIGHT, backgroundColor: chart.track, borderRadius: BAR_HEIGHT / 2 }}>
            <View
              style={{
                height: BAR_HEIGHT,
                width: `${Math.max(2, (item.value / max) * 100)}%`,
                backgroundColor: item.color ?? chart.bar,
                borderRadius: BAR_HEIGHT / 2,
              }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Распределение по нормам: одна составная полоса + легенда.
 * Цвет выраженности всегда идёт с подписью — цвет не говорит один.
 */
export function SeverityBar({
  bands,
}: {
  bands: { label: string; severity: Severity; count: number; percent: number }[];
}) {
  const { ut } = useLang();
  const sev = useSeverity();
  const total = bands.reduce((sum, b) => sum + b.count, 0);
  if (!total) return <Body muted>{ut("mch.noDistribution")}</Body>;

  return (
    <View style={{ gap: spacing.md }}>
      <View style={{ flexDirection: "row", gap: SEGMENT_GAP, height: BAR_HEIGHT }}>
        {bands.map((b, i) => (
          <View
            key={i}
            style={{
              flex: Math.max(b.count, 0.001),
              backgroundColor: sev.color[b.severity],
              borderRadius: BAR_HEIGHT / 2,
            }}
          />
        ))}
      </View>
      <View style={{ gap: spacing.sm }}>
        {bands.map((b, i) => (
          <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: sev.color[b.severity] }} />
            <T v="body" size={15} style={{ flex: 1 }} numberOfLines={1}>
              {b.label}
            </T>
            <T v="sub" size={14} weight={700} tone="text2" num>
              {b.count}, {b.percent}%
            </T>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Метка выраженности: слово на подложке своей ступени — никогда не только цвет */
export function SeverityTag({ severity, label }: { severity: Severity; label?: string }) {
  const { ut } = useLang();
  const sev = useSeverity();
  return (
    <View
      style={{
        alignSelf: "flex-start",
        justifyContent: "center",
        height: 28,
        paddingHorizontal: 12,
        borderRadius: 14,
        backgroundColor: sev.tint[severity],
      }}
    >
      <T v="sub" size={14} weight={700} color={sev.color[severity]} scale={false}>
        {label ?? ut(SEVERITY_KEY[severity])}
      </T>
    </View>
  );
}

/** Вертикальная гистограмма числовых ответов */
export function Histogram({
  data,
  height = 96,
}: {
  data: { value: number; count: number }[];
  height?: number;
}) {
  const { ut } = useLang();
  const chart = useChart();
  if (!data.length) return <Body muted>{ut("mch.noNumeric")}</Body>;
  const max = Math.max(...data.map((d) => d.count), 1);

  return (
    <View style={{ gap: spacing.xs }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: SEGMENT_GAP, height }}>
        {data.map((d) => (
          <View key={d.value} style={{ flex: 1, alignItems: "center", gap: 2 }}>
            <T v="caption" size={11} weight={700} tone="text2" num scale={false}>
              {d.count}
            </T>
            <View
              style={{
                width: "100%",
                height: Math.max(3, (d.count / max) * (height - 18)),
                backgroundColor: chart.bar,
                borderTopLeftRadius: 4,
                borderTopRightRadius: 4,
              }}
            />
          </View>
        ))}
      </View>
      <View style={{ height: 1, backgroundColor: chart.base }} />
      <View style={{ flexDirection: "row", gap: SEGMENT_GAP }}>
        {data.map((d) => (
          <T key={d.value} v="caption" size={11} num scale={false} style={{ flex: 1, textAlign: "center" }}>
            {d.value}
          </T>
        ))}
      </View>
    </View>
  );
}

/** Динамика прохождений по дням */
export function Timeline({ data }: { data: { date: string; count: number }[] }) {
  const { ut } = useLang();
  const chart = useChart();
  if (!data.length) return <Body muted>{ut("mch.noResponses")}</Body>;

  const max = Math.max(...data.map((d) => d.count), 1);
  const first = data[0]!.date;
  const last = data[data.length - 1]!.date;
  const short = (iso: string) => iso.slice(8, 10) + "." + iso.slice(5, 7);

  return (
    <View style={{ gap: spacing.xs }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: SEGMENT_GAP, height: 64 }}>
        {data.map((d) => (
          <View
            key={d.date}
            style={{
              flex: 1,
              height: Math.max(3, (d.count / max) * 64),
              backgroundColor: chart.bar,
              borderTopLeftRadius: 3,
              borderTopRightRadius: 3,
            }}
          />
        ))}
      </View>
      <View style={{ height: 1, backgroundColor: chart.base }} />
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <T v="caption" size={11} num scale={false}>
          {short(first)}
        </T>
        <T v="caption" size={11} scale={false}>
          {ut("mv.peakPerDay").replace("{n}", String(max))}
        </T>
        <T v="caption" size={11} num scale={false}>
          {short(last)}
        </T>
      </View>
    </View>
  );
}

/** Блок диаграммы — панель набора с заголовком и подписью */
export function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Panel title={title} sub={subtitle} icon="chart-line">
      {children}
    </Panel>
  );
}
