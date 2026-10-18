import { useMemo } from "react";
import { Pressable, TextInput, View } from "react-native";
import type { Answer, Option, Question, UiKey } from "@quizzy/shared";
import { font } from "../fonts";
import { radius, spacing, useColors, useIsDark } from "../theme";
import { useTextScale } from "../textScale";
import { AnswerTile } from "../ui/AnswerTile";
import { T } from "../ui/Text";
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
  ut: (key: UiKey) => string,
): string {
  if (point === min && question.minLabel) return `${point} — ${question.minLabel}`;
  if (point === max && question.maxLabel) return `${point} — ${question.maxLabel}`;
  return ut("qi.pointOf").replace("{n}", String(point)).replace("{max}", String(max));
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
  const darkTheme = useIsDark();
  // выбор на тёмной теме — светлая ступень: заливка #7443AD под мелкой цифрой не читается
  const pick = darkTheme ? c.vink : c.v;
  const onPick = darkTheme ? c.ground : c.onfill;
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
        <View style={{ gap: 10 }}>
          {choices.map((option) => {
            const on = selected.includes(option.id);
            return (
              <AnswerTile
                key={option.id}
                label={option.text}
                selected={on}
                multi={multi}
                onPress={() =>
                  onChange({
                    optionIds: multi
                      ? on
                        ? selected.filter((id) => id !== option.id)
                        : [...selected, option.id]
                      : [option.id],
                  })
                }
              />
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
              <T v="headline">{row.text}</T>
              <View style={{ flexDirection: "row", gap: 6 }}>
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
                      style={({ pressed }) => ({
                        flex: 1,
                        minHeight: TOUCH_TARGET,
                        paddingVertical: spacing.sm,
                        paddingHorizontal: spacing.xs,
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: radius.control,
                        borderWidth: 1,
                        borderColor: on ? pick : c.border,
                        backgroundColor: on ? pick : pressed ? c.panel2 : c.panel,
                      })}
                    >
                      <T v="sub" size={13} weight={on ? 800 : 600} color={on ? onPick : c.text2} center numberOfLines={3}>
                        {option.text}
                      </T>
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
            <View style={{ gap: 10 }}>
              {order.map((id, index) => {
                const option = choices.find((o) => o.id === id);
                return (
                  <Pressable
                    key={id}
                    onPress={() => onChange({ ranking: order.filter((x) => x !== id) })}
                    accessibilityRole="button"
                    accessibilityLabel={ut("qi.removeHint").replace("{n}", String(index + 1)).replace("{text}", option?.text ?? "")}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 14,
                      minHeight: 64,
                      paddingVertical: 11,
                      paddingLeft: 15,
                      paddingRight: 17,
                      borderRadius: radius.tile,
                      borderWidth: 2,
                      borderColor: pick,
                      backgroundColor: c.vtint,
                    }}
                  >
                    <View
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 13,
                        backgroundColor: pick,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <T v="sub" size={14} weight={800} color={onPick} num scale={false}>
                        {index + 1}
                      </T>
                    </View>
                    <T v="headline" size={17} color={c.vink} style={{ flex: 1 }}>
                      {option?.text}
                    </T>
                    <T v="sub">{ut("qi.remove")}</T>
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
              accessibilityLabel={ut("qi.placeHint").replace("{text}", option.text).replace("{n}", String(order.length + 1))}
              style={({ pressed }) => ({
                justifyContent: "center",
                minHeight: 64,
                paddingVertical: 12,
                paddingHorizontal: 18,
                borderRadius: radius.tile,
                borderWidth: 1,
                borderColor: pressed ? c.ctl : c.border,
                backgroundColor: pressed ? c.panel2 : c.panel,
              })}
            >
              <T v="headline" size={17} weight={700}>
                {option.text}
              </T>
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
                  accessibilityLabel={scalePointLabel(question, point, min, max, ut)}
                  accessibilityState={{ checked: on }}
                  style={({ pressed }) => ({
                    minWidth: TOUCH_TARGET,
                    minHeight: TOUCH_TARGET,
                    justifyContent: "center",
                    flexGrow: points.length > 8 ? 1 : 0,
                    paddingVertical: spacing.md,
                    alignItems: "center",
                    borderRadius: radius.control,
                    borderWidth: 1,
                    borderColor: on ? pick : c.border,
                    backgroundColor: on ? pick : pressed ? c.panel2 : c.panel,
                  })}
                >
                  <T v="headline" size={17} color={on ? onPick : c.text} num>
                    {point}
                  </T>
                </Pressable>
              );
            })}
          </View>
          {question.minLabel || question.maxLabel ? (
            <Row>
              <T v="sub" style={{ flex: 1 }}>
                {question.minLabel}
              </T>
              <T v="sub" style={{ flex: 1, textAlign: "right" }}>
                {question.maxLabel}
              </T>
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
          placeholder={ut("qi.rangeHint").replace("{min}", String(question.minValue ?? 0)).replace("{max}", String(question.maxValue ?? 100))}
          placeholderTextColor={c.muted}
          style={[inputStyle(c, fs(16)), { fontVariant: ["tabular-nums"] }]}
        />
      );

    case "date":
      return (
        <TextInput
          value={value?.date ?? ""}
          onChangeText={(t) => onChange({ date: t })}
          accessibilityLabel={question.title}
          placeholder={ut("qi.datePattern")}
          placeholderTextColor={c.muted}
          style={[inputStyle(c, fs(16)), { fontVariant: ["tabular-nums"] }]}
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
            inputStyle(c, fs(16)),
            question.type === "longtext" ? { minHeight: 120, paddingVertical: 14, textAlignVertical: "top" } : null,
          ]}
        />
      );
  }
}

/** Поле ответа — как поле формы набора: 52, рамка 3:1, текст 16 */
function inputStyle(c: ReturnType<typeof useColors>, size: number) {
  return {
    minHeight: 52,
    borderWidth: 1,
    borderColor: c.field,
    borderRadius: radius.control,
    paddingHorizontal: 14,
    color: c.text,
    fontSize: size,
    backgroundColor: c.panel,
    ...font(500),
  } as const;
}
