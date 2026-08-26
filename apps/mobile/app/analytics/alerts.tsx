import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import type { RiskAlert } from "@quizzy/shared";
import { api } from "@/api/client";
import { Body, Button, Card, Empty, ErrorText, Field, Loader, Row, Segmented, Title } from "@/components/ui";
import { severityColor, spacing, useColors } from "@/theme";

/** Тревоги по критическим пунктам: разбираются вручную и фиксируются с автором */
export default function AlertsScreen() {
  const c = useColors();
  const [alerts, setAlerts] = useState<RiskAlert[] | null>(null);
  const [mode, setMode] = useState<"open" | "all">("open");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async (all: boolean) => {
    try {
      setError(null);
      setAlerts(await api.alerts(all));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить тревоги");
      setAlerts([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(mode === "all");
    }, [load, mode]),
  );

  /**
   * Разбор тревоги с комментарием.
   * Ввод делаем прямо в карточке, а не через Alert.prompt: тот существует
   * только на iOS и на Android с вебом молча ничего не делает.
   */
  async function acknowledge(alert: RiskAlert) {
    setSaving(alert.id);
    try {
      await api.acknowledgeAlert(alert.id, notes[alert.id]?.trim() || undefined);
      setNotes((prev) => ({ ...prev, [alert.id]: "" }));
      await load(mode === "all");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(null);
    }
  }

  if (!alerts) return <Loader />;

  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load(mode === "all");
            setRefreshing(false);
          }}
          tintColor={c.muted}
        />
      }
    >
      <Title>Тревоги</Title>
      <Body muted>
        Поднимаются сразу при сохранении ответа, в том числе на незавершённом
        прохождении — чтобы не ждать, пока пациент дойдёт до конца.
      </Body>

      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { value: "open", label: "Неразобранные" },
          { value: "all", label: "Все" },
        ]}
      />

      <ErrorText>{error}</ErrorText>
      {alerts.length === 0 ? <Empty text="Тревог нет" /> : null}

      {alerts.map((a) => (
        <Card key={a.id}>
          <Row>
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                backgroundColor: a.severity === "severe" ? severityColor.severe : severityColor.moderate,
              }}
            />
            <Text style={{ color: c.text, fontSize: 13, fontWeight: "700" }}>
              {a.severity === "severe" ? "Срочно" : "Внимание"}
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={{ color: c.muted, fontSize: 12 }}>
              {a.at.slice(0, 16).replace("T", " ")}
            </Text>
          </Row>

          <Body>{a.label}</Body>
          <Body muted>
            {a.respondent ?? "Аноним"} · {a.surveyTitle}
          </Body>
          <Text style={{ color: c.muted, fontSize: 12 }}>{a.questionTitle}</Text>

          {a.acknowledgedAt ? (
            <Body muted>
              Разобрано: {a.acknowledgedByName ?? "—"}, {a.acknowledgedAt.slice(0, 16).replace("T", " ")}
              {a.note ? ` — ${a.note}` : ""}
            </Body>
          ) : (
            <View style={{ gap: spacing.sm }}>
              <Field
                label="Что предпринято"
                value={notes[a.id] ?? ""}
                onChangeText={(t) => setNotes((prev) => ({ ...prev, [a.id]: t }))}
                placeholder="Например: осмотр назначен на сегодня"
              />
              <Button
                title="Отметить разобранной"
                variant="secondary"
                loading={saving === a.id}
                onPress={() => acknowledge(a)}
              />
            </View>
          )}
        </Card>
      ))}
    </ScrollView>
  );
}
