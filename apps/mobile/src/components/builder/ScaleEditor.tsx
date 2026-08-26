import { Pressable, Text, View } from "react-native";
import type { ScaleAggregation, Severity } from "@quizzy/shared";
import { severityColor, severityLabel, spacing, useColors } from "../../theme";
import { Body, Button, Card, Chip, Field, Row } from "../ui";
import { emptyBand, type DraftScale } from "./types";

const AGGREGATION_LABEL: Record<ScaleAggregation, string> = {
  sum: "Сумма",
  average: "Среднее",
  count: "Число признаков",
};

export function ScaleEditor({
  scale,
  onChange,
  onRemove,
}: {
  scale: DraftScale;
  onChange: (patch: Partial<DraftScale>) => void;
  onRemove: () => void;
}) {
  const c = useColors();

  return (
    <Card>
      <Row>
        <Body muted>Субшкала</Body>
        <View style={{ flex: 1 }} />
        <Pressable onPress={onRemove} hitSlop={8}>
          <Text style={{ color: c.danger, fontSize: 13 }}>удалить</Text>
        </Pressable>
      </Row>

      <Row gap={spacing.md}>
        <View style={{ flex: 1 }}>
          <Field
            label="Код"
            value={scale.code}
            onChangeText={(t) => onChange({ code: t.replace(/[^a-zA-Z0-9_-]/g, "") })}
            autoCapitalize="none"
            placeholder="anxiety"
          />
        </View>
        <View style={{ flex: 2 }}>
          <Field
            label="Название"
            value={scale.title}
            onChangeText={(t) => onChange({ title: t })}
            placeholder="Тревога"
          />
        </View>
      </Row>

      <View style={{ gap: spacing.xs }}>
        <Text style={{ color: c.muted, fontSize: 13 }}>Как считать итог</Text>
        <Row gap={spacing.xs}>
          {(Object.keys(AGGREGATION_LABEL) as ScaleAggregation[]).map((a) => (
            <Chip
              key={a}
              label={AGGREGATION_LABEL[a]}
              selected={scale.aggregation === a}
              onPress={() => onChange({ aggregation: a })}
            />
          ))}
        </Row>
      </View>

      <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
        <Text style={{ color: c.muted, fontSize: 13 }}>
          Интерпретационные нормы — диапазон баллов превращается в вывод
        </Text>
        {scale.bands.map((band, i) => (
          <View key={band.key} style={{ gap: spacing.sm }}>
            <Row gap={spacing.sm}>
              <View style={{ flex: 1 }}>
                <Field
                  label="От"
                  value={band.minScore}
                  onChangeText={(t) =>
                    onChange({
                      bands: scale.bands.map((b) => (b.key === band.key ? { ...b, minScore: t } : b)),
                    })
                  }
                  keyboardType="numbers-and-punctuation"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label="До"
                  value={band.maxScore}
                  onChangeText={(t) =>
                    onChange({
                      bands: scale.bands.map((b) => (b.key === band.key ? { ...b, maxScore: t } : b)),
                    })
                  }
                  keyboardType="numbers-and-punctuation"
                />
              </View>
              <View style={{ flex: 3 }}>
                <Field
                  label={`Вывод ${i + 1}`}
                  value={band.label}
                  onChangeText={(t) =>
                    onChange({
                      bands: scale.bands.map((b) => (b.key === band.key ? { ...b, label: t } : b)),
                    })
                  }
                  placeholder="Умеренная тревога"
                />
              </View>
            </Row>
            <Row gap={spacing.xs}>
              {(["none", "mild", "moderate", "severe"] as Severity[]).map((s) => (
                <Chip
                  key={s}
                  label={severityLabel[s]}
                  color={severityColor[s]}
                  selected={band.severity === s}
                  onPress={() =>
                    onChange({
                      bands: scale.bands.map((b) => (b.key === band.key ? { ...b, severity: s } : b)),
                    })
                  }
                />
              ))}
              <View style={{ flex: 1 }} />
              <Pressable
                onPress={() => onChange({ bands: scale.bands.filter((b) => b.key !== band.key) })}
                hitSlop={8}
              >
                <Text style={{ color: c.danger, fontSize: 13 }}>✕</Text>
              </Pressable>
            </Row>
          </View>
        ))}
        <Button
          title="Добавить норму"
          variant="secondary"
          onPress={() => onChange({ bands: [...scale.bands, emptyBand()] })}
        />
      </View>
    </Card>
  );
}
