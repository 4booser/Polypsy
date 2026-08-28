import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { api } from "@/api/client";
import { Body, Button, Card, Empty, ErrorText, Row, Title } from "@/components/ui";
import { severityColor, spacing, useColors } from "@/theme";
import { useLang } from "@/lang";

/**
 * Что именно не ушло на сервер.
 *
 * Полоса состояния говорит «ждут связи: 3» — и этого мало. Человек, у
 * которого что-то не отправилось, хочет знать, что именно, и убедиться, что
 * его ответы не пропали. А отвергнутую сервером сдачу надо разбирать
 * поштучно: молча выбрасывать клинические данные нельзя.
 */
export default function QueueScreen() {
  const c = useColors();
  const router = useRouter();
  const { ut } = useLang();
  const [items, setItems] = useState<ReturnType<typeof api.queueItems>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => setItems(api.queueItems()), []);
  useFocusEffect(useCallback(() => reload(), [reload]));

  const waiting = items.filter((i) => !i.rejectedReason);
  const rejected = items.filter((i) => i.rejectedReason);

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      <Title>{ut("mq.title")}</Title>
      <Body muted>
        {ut("mq.hint")}
      </Body>

      <ErrorText>{error}</ErrorText>

      {items.length === 0 ? (
        <Empty text={ut("mq.allSent")} />
      ) : null}

      {waiting.length ? (
        <Card>
          <Body>
            {ut("mq.waiting")}: {waiting.length}
          </Body>
          {waiting.map((i) => (
            <Text key={i.id} style={{ color: c.muted, fontSize: 13 }}>
              • {i.surveyTitle ?? i.surveyId.slice(0, 8)} · {i.queuedAt.slice(0, 16).replace("T", " ")}
              {i.attempts > 0 ? ` · ${ut("mq.attempts")} ${i.attempts}` : ""}
            </Text>
          ))}
          <Button
            title={ut("mq.tryNow")}
            variant="secondary"
            loading={busy}
            onPress={async () => {
              setBusy(true);
              try {
                await api.flushQueue();
              } finally {
                reload();
                setBusy(false);
              }
            }}
          />
        </Card>
      ) : null}

      {rejected.length ? (
        <Card style={{ borderColor: severityColor.severe, borderWidth: 1 }}>
          <Row>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: severityColor.severe }} />
            <Body>
              {ut("mq.rejected")}: {rejected.length}
            </Body>
          </Row>
          <Body muted>
            {ut("mq.rejectedHint")}
          </Body>
          {rejected.map((i) => (
            <View key={i.id} style={{ gap: 4, marginTop: spacing.sm }}>
              <Text style={{ color: c.text, fontSize: 14 }}>
                {i.surveyTitle ?? i.surveyId.slice(0, 8)} · {i.queuedAt.slice(0, 16).replace("T", " ")}
              </Text>
              <Text style={{ color: c.muted, fontSize: 12 }}>{i.rejectedReason}</Text>
              <Button
                title={ut("mq.retry")}
                variant="secondary"
                onPress={async () => {
                  api.retryQueued(i.id);
                  setError(null);
                  await api.flushQueue().catch(() => {});
                  reload();
                }}
              />
            </View>
          ))}
        </Card>
      ) : null}

      <Button
        title={ut("common.back")}
        variant="secondary"
        onPress={() => router.back()}
      />
    </ScrollView>
  );
}
