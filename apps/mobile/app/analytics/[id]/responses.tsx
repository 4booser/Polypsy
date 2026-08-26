import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import type { SurveyResponse } from "@quizzy/shared";
import { api, type ResponseDetail } from "@/api/client";
import { SeverityTag } from "@/components/charts";
import { Body, Card, Divider, Empty, ErrorText, Loader, Row } from "@/components/ui";
import { formatDuration, spacing, useColors } from "@/theme";

export default function ResponsesScreen() {
  const c = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [rows, setRows] = useState<SurveyResponse[] | null>(null);
  const [detail, setDetail] = useState<ResponseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRows(await api.surveyResponses(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить прохождения");
      setRows([]);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!rows) return <Loader />;

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      <ErrorText>{error}</ErrorText>
      {rows.length === 0 ? <Empty text="Прохождений пока нет" /> : null}

      {rows.map((r) => (
        <Pressable
          key={r.id}
          onPress={async () => {
            setDetail(detail?.id === r.id ? null : await api.responseDetail(r.id));
          }}
        >
          <Card>
            <Row>
              <Body>{r.userName ?? "Аноним"}</Body>
              <View style={{ flex: 1 }} />
              <Text style={{ color: c.muted, fontSize: 12 }}>
                {r.submittedAt ? r.submittedAt.slice(0, 16).replace("T", " ") : "не завершено"}
              </Text>
            </Row>
            <Row gap={spacing.md}>
              <Text style={{ color: c.muted, fontSize: 12 }}>{formatDuration(r.durationMs)}</Text>
              <Text style={{ color: c.muted, fontSize: 12 }}>{r.status}</Text>
            </Row>
            {r.scores.map((s) => (
              <Row key={s.scaleId}>
                <Text style={{ color: c.text, fontSize: 13, flex: 1 }}>{s.scaleTitle}</Text>
                <Text style={{ color: c.muted, fontSize: 13, fontVariant: ["tabular-nums"] }}>
                  {s.rawScore}/{s.maxScore}
                </Text>
                {s.band ? (
                  <View style={{ marginLeft: spacing.sm }}>
                    <SeverityTag severity={s.band.severity} label={s.band.label} />
                  </View>
                ) : null}
              </Row>
            ))}

            {detail?.id === r.id ? (
              <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
                <Divider />
                <Body muted>Ответы и время по вопросам</Body>
                {detail.answers.map((a) => (
                  <Row key={a.questionId}>
                    <Text style={{ color: c.text, fontSize: 13, flex: 1 }} numberOfLines={1}>
                      {a.position + 1}. {a.title}
                    </Text>
                    <Text style={{ color: c.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
                      {formatDuration(a.durationMs)}
                      {a.changeCount ? ` · правок ${a.changeCount}` : ""}
                      {a.answered ? "" : " · пропуск"}
                    </Text>
                  </Row>
                ))}
              </View>
            ) : null}
          </Card>
        </Pressable>
      ))}
    </ScrollView>
  );
}
