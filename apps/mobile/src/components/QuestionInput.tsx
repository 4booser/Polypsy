import { useMemo } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { Answer, Option, Question } from "@quizzy/shared";
import { radius, spacing, useColors } from "../theme";
import { useTextScale } from "../textScale";
import { Body, Row, TOUCH_TARGET } from "./ui";
import { useLang } from "@/lang";

/**
 * Подпись деления шкалы для диктора: голое «7» бессмысленно, а у краёв
 * методики обычно есть словесные якоря — их и озвучиваем.
 */
function scalePointLabel(
  question: Question,
  point: number,
  min: number,
  max: number,
): string {
  if (point === min && question.minLabel) return `${point} — ${question.minLabel}`;
  if (point === max && question.maxLabel) return `${point} — ${question.maxLabel}`;
  return `${point} из ${max}`;
}

interface Props {
  question: Question;
  value: Answer | undefined;
  onChange: (patch: Partial<Answer>) => void;
}

/** Детерминированная перестановка вариантов — порядок стабилен в пределах прохождения */
function useOptions(question: Question, kind: "option" | "row"): Option[] {
  return useMemo(() => {
    const list = question.options.filter((o) => o.kind === kind);
    if (!question.randomizeOptions || kind === "row") return list;
    return [...list].sort(() => Math.random() - 0.5);
  }, [question, kind]);
}

export function QuestionInput({ question, value, onChange }: Props) {
  const { ut } = useLang();
  const c = useColors();
  const { fs } = useTextScale();
  const choices = useOptions(question, "option");
  const rows = useOptions(question, "row");

  switch (question.type) {
    case "info":
      return null;

    case "single":
    case "yesno":
    case "multiple": {
      const selected = value?.optionIds ?? [];
      const multi = question.type === "multiple";
      return (
        <View style={{ gap: spacing.sm }}>
          {choices.map((option) => {
            const on = selected.includes(option.id);
            return (
              <Pressable
                key={option.id}
                onPress={() =>
                  onChange({
                    optionIds: multi
                      ? on
                        ? selected.filter((id) => id !== option.id)
                        : [...selected, option.id]
                      : [option.id],
                  })
                }
                /*
                 * Роль и состояние обязательны: без них диктор читает просто
                 * «Иногда», не сообщая ни что это выбор, ни что он уже сделан.
                 * Для обследуемого со слабым зрением это разница между
                 * заполненной методикой и случайным набором ответов.
                 */
                accessibilityRole={multi ? "checkbox" : "radio"}
                accessibilityLabel={option.text}
                accessibilityState={{ checked: on }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: spacing.md,
                  padding: spacing.lg,
                  borderRadius: radius.sm,
                  borderWidth: 1,
                  borderColor: on ? c.primary : c.border,
                  backgroundColor: on ? `${c.primary}1a` : c.card,
                }}
              >
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: multi ? 5 : 11,
                    borderWidth: 2,
                    borderColor: on ? c.primary : c.border,
                    backgroundColor: on ? c.primary : "transparent",
                  }}
                />
                <Text style={{ color: c.text, fontSize: fs(16), flex: 1 }}>{option.text}</Text>
              </Pressable>
            );
          })}
        </View>
      );
    }

    case "matrix": {
      const picked = value?.matrix ?? {};
      return (
        <View style={{ gap: spacing.lg }}>
          {rows.map((row) => (
            <View key={row.id} style={{ gap: spacing.sm }}>
              <Text style={{ color: c.text, fontSize: fs(15), fontWeight: "600" }}>{row.text}</Text>
              <View style={{ flexDirection: "row", gap: spacing.xs }}>
                {choices.map((option) => {
                  const on = picked[row.id] === option.id;
                  return (
                    <Pressable
                      key={option.id}
                      onPress={() => onChange({ matrix: { ...picked, [row.id]: option.id } })}
                      // в подписи и строка, и вариант: вне таблицы «Часто»
                      // само по себе ничего не значит
                      accessibilityRole="radio"
                      accessibilityLabel={`${row.text}: ${option.text}`}
                      accessibilityState={{ checked: on }}
                      style={{
                        flex: 1,
                        paddingVertical: spacing.md,
                        paddingHorizontal: spacing.xs,
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: radius.sm,
                        borderWidth: 1,
                        borderColor: on ? c.primary : c.border,
                        backgroundColor: on ? c.primary : c.card,
                      }}
                    >
                      <Text
                        style={{
                          color: on ? c.primaryText : c.muted,
                          fontSize: 11,
                          textAlign: "center",
                          fontWeight: on ? "700" : "400",
                        }}
                        numberOfLines={3}
                      >
                        {option.text}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}
        </View>
      );
    }

    case "ranking": {
      const order = value?.ranking ?? [];
      const rest = choices.filter((o) => !order.includes(o.id));
      return (
        <View style={{ gap: spacing.md }}>
          <Body muted>{ut("mqi.rankHint")}</Body>
          {order.length > 0 ? (
            <View style={{ gap: spacing.sm }}>
              {order.map((id, index) => {
                const option = choices.find((o) => o.id === id);
                return (
                  <Pressable
                    key={id}
                    onPress={() => onChange({ ranking: order.filter((x) => x !== id) })}
                    accessibilityRole="button"
                    accessibilityLabel={`${index + 1}: ${option?.text ?? ""}. Нажмите, чтобы убрать`}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: spacing.md,
                      padding: spacing.md,
                      borderRadius: radius.sm,
                      borderWidth: 1,
                      borderColor: c.primary,
                      backgroundColor: `${c.primary}1a`,
                    }}
                  >
                    <View
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 12,
                        backgroundColor: c.primary,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Text style={{ color: c.primaryText, fontWeight: "700", fontSize: 13 }}>
                        {index + 1}
                      </Text>
                    </View>
                    <Text style={{ color: c.text, fontSize: fs(15), flex: 1 }}>{option?.text}</Text>
                    <Text style={{ color: c.muted, fontSize: 12 }}>убрать</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {rest.map((option) => (
            <Pressable
              key={option.id}
              onPress={() => onChange({ ranking: [...order, option.id] })}
              accessibilityRole="button"
              accessibilityLabel={`${option.text}. Нажмите, чтобы поставить на место ${order.length + 1}`}
              style={{
                padding: spacing.lg,
                borderRadius: radius.sm,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: c.card,
              }}
            >
              <Text style={{ color: c.text, fontSize: fs(15) }}>{option.text}</Text>
            </Pressable>
          ))}
        </View>
      );
    }

    case "scale":
    case "slider": {
      const min = question.minValue ?? 0;
      const max = question.maxValue ?? 10;
      const step = question.step ?? 1;
      const points: number[] = [];
      for (let v = min; v <= max; v += step) points.push(Math.round(v * 100) / 100);

      return (
        <View style={{ gap: spacing.md }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {points.map((point) => {
              const on = value?.number === point;
              return (
                <Pressable
                  key={point}
                  onPress={() => onChange({ number: point })}
                  accessibilityRole="radio"
                  accessibilityLabel={scalePointLabel(question, point, min, max)}
                  accessibilityState={{ checked: on }}
                  style={{
                    minWidth: TOUCH_TARGET,
                    minHeight: TOUCH_TARGET,
                    justifyContent: "center",
                    flexGrow: points.length > 8 ? 1 : 0,
                    paddingVertical: spacing.md,
                    alignItems: "center",
                    borderRadius: radius.sm,
                    borderWidth: 1,
                    borderColor: on ? c.primary : c.border,
                    backgroundColor: on ? c.primary : c.card,
                  }}
                >
                  <Text
                    style={{ color: on ? c.primaryText : c.text, fontWeight: "600", fontSize: 15 }}
                  >
                    {point}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {question.minLabel || question.maxLabel ? (
            <Row>
              <Text style={{ color: c.muted, fontSize: 12, flex: 1 }}>{question.minLabel}</Text>
              <Text style={{ color: c.muted, fontSize: 12, textAlign: "right", flex: 1 }}>
                {question.maxLabel}
              </Text>
            </Row>
          ) : null}
        </View>
      );
    }

    case "number":
      return (
        <TextInput
          value={value?.number !== undefined ? String(value.number) : ""}
          onChangeText={(t) => {
            const parsed = Number(t.replace(",", "."));
            onChange({ number: t === "" || Number.isNaN(parsed) ? undefined : parsed });
          }}
          keyboardType="numeric"
          accessibilityLabel={question.title}
          placeholder={`от ${question.minValue ?? 0} до ${question.maxValue ?? 100}`}
          placeholderTextColor={c.muted}
          style={inputStyle(c)}
        />
      );

    case "date":
      return (
        <TextInput
          value={value?.date ?? ""}
          onChangeText={(t) => onChange({ date: t })}
          accessibilityLabel={question.title}
          placeholder="ГГГГ-ММ-ДД"
          placeholderTextColor={c.muted}
          style={inputStyle(c)}
        />
      );

    case "text":
    case "longtext":
      return (
        <TextInput
          value={value?.text ?? ""}
          onChangeText={(t) => onChange({ text: t })}
          accessibilityLabel={question.title}
          placeholder={ut("mqi.yourAnswer")}
          placeholderTextColor={c.muted}
          multiline={question.type === "longtext"}
          style={[
            inputStyle(c),
            question.type === "longtext" ? { minHeight: 120, textAlignVertical: "top" } : null,
          ]}
        />
      );
  }
}

function inputStyle(c: ReturnType<typeof useColors>) {
  return {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    padding: spacing.lg,
    color: c.text,
    fontSize: 16,
    backgroundColor: c.card,
  } as const;
}
