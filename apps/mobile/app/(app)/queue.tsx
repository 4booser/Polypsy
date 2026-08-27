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
  const { lang } = useLang();
  const [items, setItems] = useState<ReturnType<typeof api.queueItems>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => setItems(api.queueItems()), []);
  useFocusEffect(useCallback(() => reload(), [reload]));

  const waiting = items.filter((i) => !i.rejectedReason);
  const rejected = items.filter((i) => i.rejectedReason);

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      <Title>{lang === "uk" ? "Черга відправки" : "Очередь отправки"}</Title>
      <Body muted>
        {lang === "uk"
          ? "Відповіді зберігаються на пристрої й підуть самі, щойно з'явиться мережа. Нічого не втрачено."
          : "Ответы сохранены на устройстве и уйдут сами, как только появится сеть. Ничего не потеряно."}
      </Body>

      <ErrorText>{error}</ErrorText>

      {items.length === 0 ? (
        <Empty text={lang === "uk" ? "Усе відправлено" : "Всё отправлено"} />
      ) : null}

      {waiting.length ? (
        <Card>
          <Body>
            {lang === "uk" ? "Чекають на зв'язок" : "Ждут связи"}: {waiting.length}
          </Body>
          {waiting.map((i) => (
            <Text key={i.id} style={{ color: c.muted, fontSize: 13 }}>
              • {i.surveyTitle ?? i.surveyId.slice(0, 8)} · {i.queuedAt.slice(0, 16).replace("T", " ")}
              {i.attempts > 0 ? ` · ${lang === "uk" ? "спроб" : "попыток"} ${i.attempts}` : ""}
            </Text>
          ))}
          <Button
            title={lang === "uk" ? "Спробувати зараз" : "Попробовать сейчас"}
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
              {lang === "uk" ? "Сервер не прийняв" : "Сервер не принял"}: {rejected.length}
            </Body>
          </Row>
          <Body muted>
            {lang === "uk"
              ? "Ці відповіді не підуть самі. Покажіть екран фахівцю — видаляти їх самостійно не потрібно."
              : "Эти ответы не уйдут сами. Покажите экран специалисту — удалять их самостоятельно не нужно."}
          </Body>
          {rejected.map((i) => (
            <View key={i.id} style={{ gap: 4, marginTop: spacing.sm }}>
              <Text style={{ color: c.text, fontSize: 14 }}>
                {i.surveyTitle ?? i.surveyId.slice(0, 8)} · {i.queuedAt.slice(0, 16).replace("T", " ")}
              </Text>
              <Text style={{ color: c.muted, fontSize: 12 }}>{i.rejectedReason}</Text>
              <Button
                title={lang === "uk" ? "Спробувати ще раз" : "Попробовать ещё раз"}
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
        title={lang === "uk" ? "Назад" : "Назад"}
        variant="secondary"
        onPress={() => router.back()}
      />
    </ScrollView>
  );
}
