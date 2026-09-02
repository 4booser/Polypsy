import { Text, View } from "react-native";
import type { Severity } from "@quizzy/shared";
import { radius, severityColor, spacing, useChart, useColors } from "../theme";
import { SEVERITY_KEY } from "@quizzy/shared";
import { useLang } from "../lang";
import { Body, Card } from "./ui";

/**
 * Диаграммы собраны на View: столбики тонкие, с закруглённым концом и
 * прижаты к базовой линии, между сегментами — зазор цвета поверхности,
 * подписи стоят рядом со значением, сетка и оси приглушены.
 */

const BAR_HEIGHT = 10;
const SEGMENT_GAP = 2;

/** Крупная цифра-показатель. Без графика — это осознанно не диаграмма. */
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
        backgroundColor: c.card,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: spacing.lg,
        gap: 2,
      }}
    >
      <Text style={{ color: c.muted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: c.text, fontSize: 26, fontWeight: "700" }}>{value}</Text>
      {hint ? <Text style={{ color: c.muted, fontSize: 12 }}>{hint}</Text> : null}
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
  const c = useColors();
  const max = Math.max(...items.map((i) => i.value), 1);

  return (
    <View style={{ gap: spacing.md }}>
      {items.map((item, i) => (
        <View key={i} style={{ gap: spacing.xs }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.sm }}>
            <Text style={{ color: c.text, fontSize: 14, flex: 1 }} numberOfLines={2}>
              {item.label}
            </Text>
            <Text style={{ color: c.muted, fontSize: 13, fontVariant: ["tabular-nums"] }}>
              {valueFormatter ? valueFormatter(item.value) : item.value}
              {unit ?? ""}
              {item.caption ? ` · ${item.caption}` : ""}
            </Text>
          </View>
          <View style={{ height: BAR_HEIGHT, backgroundColor: chart.grid, borderRadius: radius.sm }}>
            <View
              style={{
                height: BAR_HEIGHT,
                width: `${Math.max(2, (item.value / max) * 100)}%`,
                backgroundColor: item.color ?? chart.bar,
                borderRadius: radius.sm,
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
 * Цвет выраженности всегда идёт с подписью — на светлой поверхности часть
 * статусных ролей не добирает 3:1, и подпись здесь обязательная страховка.
 */
export function SeverityBar({
  bands,
}: {
  bands: { label: string; severity: Severity; count: number; percent: number }[];
}) {
  const { ut } = useLang();
  const c = useColors();
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
              backgroundColor: severityColor[b.severity],
              borderRadius: radius.sm,
            }}
          />
        ))}
      </View>
      <View style={{ gap: spacing.sm }}>
        {bands.map((b, i) => (
          <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                backgroundColor: severityColor[b.severity],
              }}
            />
            <Text style={{ color: c.text, fontSize: 14, flex: 1 }} numberOfLines={1}>
              {b.label}
            </Text>
            <Text style={{ color: c.muted, fontSize: 13, fontVariant: ["tabular-nums"] }}>
              {b.count} · {b.percent}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Метка выраженности: кружок + текст, никогда не только цвет */
export function SeverityTag({ severity, label }: { severity: Severity; label?: string }) {
  const c = useColors();
  const { ut } = useLang();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
      <View
        style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: severityColor[severity] }}
      />
      <Text style={{ color: c.text, fontSize: 13, fontWeight: "600" }}>
        {label ?? ut(SEVERITY_KEY[severity])}
      </Text>
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
  const c = useColors();
  if (!data.length) return <Body muted>{ut("mch.noNumeric")}</Body>;
  const max = Math.max(...data.map((d) => d.count), 1);

  return (
    <View style={{ gap: spacing.xs }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: SEGMENT_GAP, height }}>
        {data.map((d) => (
          <View key={d.value} style={{ flex: 1, alignItems: "center", gap: 2 }}>
            <Text style={{ color: c.muted, fontSize: 10, fontVariant: ["tabular-nums"] }}>
              {d.count}
            </Text>
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
      <View style={{ height: 1, backgroundColor: chart.axis, opacity: 0.5 }} />
      <View style={{ flexDirection: "row", gap: SEGMENT_GAP }}>
        {data.map((d) => (
          <Text
            key={d.value}
            style={{
              flex: 1,
              textAlign: "center",
              color: chart.axis,
              fontSize: 10,
              fontVariant: ["tabular-nums"],
            }}
          >
            {d.value}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** Динамика прохождений по дням */
export function Timeline({ data }: { data: { date: string; count: number }[] }) {
  const { ut } = useLang();
  const chart = useChart();
  const c = useColors();
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
      <View style={{ height: 1, backgroundColor: chart.axis, opacity: 0.5 }} />
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: chart.axis, fontSize: 11 }}>{short(first)}</Text>
        <Text style={{ color: c.muted, fontSize: 11 }}>{ut("mv.peakPerDay").replace("{n}", String(max))}</Text>
        <Text style={{ color: chart.axis, fontSize: 11 }}>{short(last)}</Text>
      </View>
    </View>
  );
}

/** Заголовок блока диаграммы */
export function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const c = useColors();
  return (
    <Card>
      <Text style={{ color: c.text, fontSize: 16, fontWeight: "700" }}>{title}</Text>
      {subtitle ? <Text style={{ color: c.muted, fontSize: 13 }}>{subtitle}</Text> : null}
      <View style={{ marginTop: spacing.sm }}>{children}</View>
    </Card>
  );
}
