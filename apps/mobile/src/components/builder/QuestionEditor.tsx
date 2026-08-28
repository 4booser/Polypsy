import { Pressable, Switch, Text, View } from "react-native";
import type { QuestionType } from "@quizzy/shared";
import { radius, spacing, useColors } from "../../theme";
import { Body, Button, Card, Chip, Field, Row } from "../ui";
import { useLang } from "@/lang";
import {
  NEEDS_OPTIONS,
  NEEDS_RANGE,
  SCORABLE,
  TYPE_LABEL,
  emptyOption,
  newKey,
  type DraftQuestion,
  type DraftScale,
  type DraftSection,
} from "./types";

interface Props {
  question: DraftQuestion;
  index: number;
  total: number;
  scales: DraftScale[];
  sections: DraftSection[];
  previous: DraftQuestion[];
  scoringEnabled: boolean;
  onChange: (patch: Partial<DraftQuestion>) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}

export function QuestionEditor({
  question,
  index,
  total,
  scales,
  sections,
  previous,
  scoringEnabled,
  onChange,
  onRemove,
  onMove,
}: Props) {
  const { ut } = useLang();
  const c = useColors();
  const choices = question.options.filter((o) => o.kind === "option");
  const rows = question.options.filter((o) => o.kind === "row");

  function patchOption(key: string, patch: Partial<(typeof question.options)[number]>) {
    onChange({ options: question.options.map((o) => (o.key === key ? { ...o, ...patch } : o)) });
  }

  return (
    <Card>
      <Row>
        <Body muted>Вопрос {index + 1}</Body>
        <View style={{ flex: 1 }} />
        {index > 0 ? (
          <Pressable onPress={() => onMove(-1)} hitSlop={8}>
            <Text style={{ color: c.primary, fontSize: 18 }}>↑</Text>
          </Pressable>
        ) : null}
        {index < total - 1 ? (
          <Pressable onPress={() => onMove(1)} hitSlop={8}>
            <Text style={{ color: c.primary, fontSize: 18 }}>↓</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onRemove} hitSlop={8}>
          <Text style={{ color: c.danger, fontSize: 13 }}>удалить</Text>
        </Pressable>
      </Row>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
        {(Object.keys(TYPE_LABEL) as QuestionType[]).map((type) => (
          <Chip
            key={type}
            label={TYPE_LABEL[type]}
            selected={question.type === type}
            onPress={() => onChange({ type })}
          />
        ))}
      </View>

      <Field
        label={ut("mb.questionText")}
        value={question.title}
        onChangeText={(t) => onChange({ title: t })}
        multiline
      />
      <Field
        label={ut("mb.help")}
        value={question.help}
        onChangeText={(t) => onChange({ help: t })}
      />

      {question.type !== "info" ? (
        <Row>
          <Switch value={question.required} onValueChange={(v) => onChange({ required: v })} />
          <Body muted>{ut("mb.required")}</Body>
        </Row>
      ) : null}

      {sections.length > 0 ? (
        <View style={{ gap: spacing.xs }}>
          <Text style={{ color: c.muted, fontSize: 13 }}>{ut("mb.section")}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
            <Chip
              label={ut("mb.noSection")}
              selected={!question.sectionKey}
              onPress={() => onChange({ sectionKey: null })}
            />
            {sections.map((s) => (
              <Chip
                key={s.key}
                label={s.title || ut("mb.untitled")}
                selected={question.sectionKey === s.key}
                onPress={() => onChange({ sectionKey: s.key })}
              />
            ))}
          </View>
        </View>
      ) : null}

      {scoringEnabled && scales.length > 0 && SCORABLE.includes(question.type) ? (
        <View style={{ gap: spacing.xs }}>
          <Text style={{ color: c.muted, fontSize: 13 }}>{ut("mb.subscale")}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
            <Chip
              label={ut("mb.dontScore")}
              selected={!question.scaleCode}
              onPress={() => onChange({ scaleCode: null, reverseScored: false })}
            />
            {scales.map((s) => (
              <Chip
                key={s.key}
                label={s.code || "без кода"}
                selected={question.scaleCode === s.code}
                onPress={() => onChange({ scaleCode: s.code })}
              />
            ))}
          </View>
          {question.scaleCode ? (
            <Row>
              <Switch
                value={question.reverseScored}
                onValueChange={(v) => onChange({ reverseScored: v })}
              />
              <View style={{ flex: 1 }}>
                <Body muted>
                  Обратный ключ — балл инвертируется внутри диапазона вопроса
                </Body>
              </View>
            </Row>
          ) : null}
        </View>
      ) : null}

      {NEEDS_RANGE.includes(question.type) ? (
        <>
          <Row gap={spacing.md}>
            <View style={{ flex: 1 }}>
              <Field
                label={ut("mb.min")}
                value={question.minValue}
                onChangeText={(t) => onChange({ minValue: t })}
                keyboardType="numbers-and-punctuation"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                label={ut("mb.max")}
                value={question.maxValue}
                onChangeText={(t) => onChange({ maxValue: t })}
                keyboardType="numbers-and-punctuation"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                label="Шаг"
                value={question.step}
                onChangeText={(t) => onChange({ step: t })}
                keyboardType="numbers-and-punctuation"
              />
            </View>
          </Row>
          <Row gap={spacing.md}>
            <View style={{ flex: 1 }}>
              <Field
                label={ut("mb.alarmThreshold")}
                value={question.riskThreshold}
                onChangeText={(t) => onChange({ riskThreshold: t })}
                keyboardType="numbers-and-punctuation"
              />
            </View>
            <View style={{ flex: 2 }}>
              <Field
                label={ut("mb.alarmText")}
                value={question.riskLabel}
                onChangeText={(t) => onChange({ riskLabel: t })}
              />
            </View>
          </Row>
          <Row gap={spacing.md}>
            <View style={{ flex: 1 }}>
              <Field
                label={ut("mb.labelLeft")}
                value={question.minLabel}
                onChangeText={(t) => onChange({ minLabel: t })}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                label={ut("mb.labelRight")}
                value={question.maxLabel}
                onChangeText={(t) => onChange({ maxLabel: t })}
              />
            </View>
          </Row>
        </>
      ) : null}

      {NEEDS_OPTIONS.includes(question.type) ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={{ color: c.muted, fontSize: 13 }}>
            {question.type === "matrix" ? ut("mb.optionsColumns") : ut("mb.options")}
          </Text>
          {choices.map((option, i) => (
            <Row key={option.key} gap={spacing.sm}>
              <View style={{ flex: 3 }}>
                <Field
                  label={`Вариант ${i + 1}`}
                  value={option.text}
                  onChangeText={(t) => patchOption(option.key, { text: t })}
                />
              </View>
              {scoringEnabled && question.scaleCode ? (
                <View style={{ flex: 1 }}>
                  <Field
                    label="Балл"
                    value={option.score}
                    onChangeText={(t) => patchOption(option.key, { score: t })}
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
              ) : null}
              {choices.length > 2 ? (
                <Pressable
                  onPress={() =>
                    onChange({ options: question.options.filter((o) => o.key !== option.key) })
                  }
                  hitSlop={8}
                  style={{ paddingTop: spacing.lg }}
                >
                  <Text style={{ color: c.danger }}>✕</Text>
                </Pressable>
              ) : null}
            </Row>
          ))}
          <Button
            title={ut("mb.addOption")}
            variant="secondary"
            onPress={() => onChange({ options: [...question.options, emptyOption("option")] })}
          />

          {question.type === "matrix" ? (
            <>
              <Text style={{ color: c.muted, fontSize: 13, marginTop: spacing.sm }}>
                Строки матрицы — каждая оценивается по столбцам выше
              </Text>
              {rows.map((row, i) => (
                <Row key={row.key} gap={spacing.sm}>
                  <View style={{ flex: 1 }}>
                    <Field
                      label={`Строка ${i + 1}`}
                      value={row.text}
                      onChangeText={(t) => patchOption(row.key, { text: t })}
                    />
                  </View>
                  {rows.length > 1 ? (
                    <Pressable
                      onPress={() =>
                        onChange({ options: question.options.filter((o) => o.key !== row.key) })
                      }
                      hitSlop={8}
                      style={{ paddingTop: spacing.lg }}
                    >
                      <Text style={{ color: c.danger }}>✕</Text>
                    </Pressable>
                  ) : null}
                </Row>
              ))}
              <Button
                title={ut("mb.addRow")}
                variant="secondary"
                onPress={() => onChange({ options: [...question.options, emptyOption("row")] })}
              />
            </>
          ) : null}

          <Row>
            <Switch
              value={question.randomizeOptions}
              onValueChange={(v) => onChange({ randomizeOptions: v })}
            />
            <Body muted>{ut("mb.shuffle")}</Body>
          </Row>

          {/* критические варианты: выбор поднимает тревогу до конца прохождения */}
          <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
            <Text style={{ color: c.muted, fontSize: 13 }}>{ut("mb.criticalOptions")}</Text>
            {choices.map((option) => (
              <View key={`risk-${option.key}`} style={{ gap: spacing.xs }}>
                <Row>
                  <Switch
                    value={option.riskFlag}
                    onValueChange={(v) => patchOption(option.key, { riskFlag: v })}
                  />
                  <View style={{ flex: 1 }}>
                    <Body muted>{option.text || "вариант без текста"}</Body>
                  </View>
                </Row>
                {option.riskFlag ? (
                  <View style={{ gap: spacing.xs, paddingLeft: spacing.xl }}>
                    <Field
                      label={ut("mb.alarmText")}
                      value={option.riskLabel}
                      onChangeText={(t) => patchOption(option.key, { riskLabel: t })}
                      placeholder={ut("mb.staffSees")}
                    />
                    <Row gap={spacing.xs}>
                      <Chip
                        label={ut("mb.attention")}
                        selected={option.riskSeverity === "moderate"}
                        onPress={() => patchOption(option.key, { riskSeverity: "moderate" })}
                      />
                      <Chip
                        label={ut("mb.urgent")}
                        selected={option.riskSeverity === "severe"}
                        onPress={() => patchOption(option.key, { riskSeverity: "severe" })}
                      />
                    </Row>
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {previous.length > 0 ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={{ color: c.muted, fontSize: 13 }}>{ut("mb.conditional")}</Text>
          {question.logic.map((rule) => (
            <View
              key={rule.key}
              style={{
                gap: spacing.sm,
                padding: spacing.md,
                borderRadius: radius.sm,
                borderWidth: 1,
                borderColor: c.border,
              }}
            >
              <Body muted>{ut("mb.showIf")}</Body>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
                {previous.map((p, i) => (
                  <Chip
                    key={p.key}
                    label={`${i + 1}. ${p.title.slice(0, 18) || "без текста"}`}
                    selected={rule.sourceIndex === i}
                    onPress={() =>
                      onChange({
                        logic: question.logic.map((r) =>
                          r.key === rule.key ? { ...r, sourceIndex: i } : r,
                        ),
                      })
                    }
                  />
                ))}
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
                {(["answered", "not_answered", "eq", "contains", "gt", "lt"] as const).map((op) => (
                  <Chip
                    key={op}
                    label={OPERATOR_LABEL[op]}
                    selected={rule.operator === op}
                    onPress={() =>
                      onChange({
                        logic: question.logic.map((r) =>
                          r.key === rule.key ? { ...r, operator: op } : r,
                        ),
                      })
                    }
                  />
                ))}
              </View>
              {rule.operator !== "answered" && rule.operator !== "not_answered" ? (
                <Field
                  label={ut("mb.value")}
                  value={rule.value}
                  onChangeText={(t) =>
                    onChange({
                      logic: question.logic.map((r) =>
                        r.key === rule.key ? { ...r, value: t } : r,
                      ),
                    })
                  }
                />
              ) : null}
              <Pressable
                onPress={() =>
                  onChange({ logic: question.logic.filter((r) => r.key !== rule.key) })
                }
              >
                <Text style={{ color: c.danger, fontSize: 13 }}>убрать условие</Text>
              </Pressable>
            </View>
          ))}
          <Button
            title={ut("mb.addCondition")}
            variant="secondary"
            onPress={() =>
              onChange({
                logic: [
                  ...question.logic,
                  { key: newKey(), sourceIndex: 0, operator: "answered", value: "", action: "show" },
                ],
              })
            }
          />
        </View>
      ) : null}
    </Card>
  );
}

const OPERATOR_LABEL: Record<string, string> = {
  answered: "отвечен",
  not_answered: "не отвечен",
  eq: "равен",
  contains: "содержит",
  gt: "больше",
  lt: "меньше",
};
