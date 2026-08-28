import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { AlertCase } from "@quizzy/shared";
import { api } from "@/api/client";
import { Body, Button, Card, Chip, Empty, ErrorText, Field, Loader, Row, Segmented, Title } from "@/components/ui";
import { severityColor, spacing, useColors } from "@/theme";
import { useLang } from "@/lang";

// ключи, а не подписи: карта вне компонента, язык — при отрисовке
const OUTCOMES = [
  { value: "confirmed", key: "mal.confirmed" },
  { value: "needs_followup", key: "mal.needsFollowup" },
  { value: "not_confirmed", key: "mal.notConfirmed" },
] as const;

/**
 * Разбор случаев риска.
 *
 * Единица работы — человек, а не сработавший пункт: пять отмеченных пунктов
 * одного обследуемого дают один случай и одно клиническое решение. Раньше
 * экран показывал строку на каждый пункт, и на реальном объёме один человек
 * встречался в списке подряд по несколько раз.
 */
export default function AlertsScreen() {
  const { ut } = useLang();
  const c = useColors();
  const _router = useRouter();
  const [cases, setCases] = useState<AlertCase[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [mode, setMode] = useState<"open" | "all">("open");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async (all: boolean, more = false, from: string | null = null) => {
    try {
      setError(null);
      const page = await api.alertCases({
        limit: "20",
        all: all ? "1" : undefined,
        cursor: more ? (from ?? undefined) : undefined,
      });
      setCases((prev) => (more && prev ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      if (!more) setTotal(page.total ?? page.items.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("mal.loadFailed"));
      setCases([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(mode === "all");
    }, [load, mode]),
  );

  async function resolve(item: AlertCase, outcome: string) {
    setSaving(item.id);
    try {
      await api.resolveCase(item.id, outcome, notes[item.id]?.trim() || undefined);
      setNotes((prev) => ({ ...prev, [item.id]: "" }));
      await load(mode === "all");
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("mal.saveFailed"));
    } finally {
      setSaving(null);
    }
  }

  if (!cases) return <Loader />;

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
      <Title>{ut("mal.title")}</Title>
      <Body muted>
        Случай — это человек, а не отдельный пункт. Решение принимается один раз обо всех
        его сигналах.
      </Body>

      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { value: "open", label: `Открытые${total ? ` · ${total}` : ""}` },
          { value: "all", label: "Все" },
        ]}
      />

      <ErrorText>{error}</ErrorText>
      {cases.length === 0 ? <Empty text={ut("mal.none")} /> : null}

      {cases.map((a) => (
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
              {a.severity === "severe" ? ut("mal.urgent") : ut("mal.attention")}
            </Text>
            {a.overdue ? <Chip label="просрочен" color={severityColor.severe} /> : null}
            <View style={{ flex: 1 }} />
            <Text style={{ color: c.muted, fontSize: 12 }}>
              {a.lastAlertAt.slice(0, 16).replace("T", " ")}
            </Text>
          </Row>

          <Body>{a.userName}</Body>
          <Body muted>
            {a.surveyTitle}
            {a.unit ? ` · ${a.unit}` : ""} · сигналов {a.signalCount}
          </Body>

          {/* что именно сработало — коротко, полный разбор в консоли */}
          {a.signals.slice(0, 3).map((s) => (
            <Text key={s.id} style={{ color: c.muted, fontSize: 12 }}>
              • {s.label}
            </Text>
          ))}
          {a.signalCount > 3 ? (
            <Text style={{ color: c.muted, fontSize: 12 }}>…и ещё {a.signalCount - 3}</Text>
          ) : null}

          {a.acknowledgedAt ? (
            <Body muted>
              Разобрано: {a.acknowledgedByName ?? "—"},{" "}
              {a.acknowledgedAt.slice(0, 16).replace("T", " ")}
              {a.note ? ` — ${a.note}` : ""}
            </Body>
          ) : (
            <View style={{ gap: spacing.sm }}>
              {a.assignedToName ? (
                <Body muted>Взял: {a.assignedToName}</Body>
              ) : (
                <Button
                  title={ut("mal.take")}
                  variant="secondary"
                  onPress={async () => {
                    await api.assignCase(a.id).catch(() => {});
                    await load(mode === "all");
                  }}
                />
              )}
              <Field
                label={ut("mal.whatDone")}
                value={notes[a.id] ?? ""}
                onChangeText={(t) => setNotes((prev) => ({ ...prev, [a.id]: t }))}
                placeholder={ut("mal.example")}
              />
              {/* исход обязателен: «просто закрыть» здесь нельзя */}
              {OUTCOMES.map((o) => (
                <Button
                  key={o.value}
                  title={ut(o.key)}
                  variant={o.value === "confirmed" ? "primary" : "secondary"}
                  loading={saving === a.id}
                  onPress={() => resolve(a, o.value)}
                />
              ))}
            </View>
          )}
        </Card>
      ))}

      {cursor ? (
        <Button
          title={ut("mal.loadMore")}
          variant="secondary"
          onPress={() => load(mode === "all", true, cursor)}
        />
      ) : null}
    </ScrollView>
  );
}
