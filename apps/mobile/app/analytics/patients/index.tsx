import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { api } from "@/api/client";
import { Body, Card, Empty, ErrorText, Loader, Row, Title } from "@/components/ui";
import { spacing, useColors } from "@/theme";

export default function PatientsScreen() {
  const c = useColors();
  const router = useRouter();
  const [people, setPeople] = useState<
    { userId: string; fullName: string; email: string; count: number; last: string | null }[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPeople((await api.respondents()).items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить список");
      setPeople([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!people) return <Loader />;

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      <Title>Пациенты</Title>
      <Body muted>Только те, кто проходил методики ваших групп</Body>
      <ErrorText>{error}</ErrorText>
      {people.length === 0 ? <Empty text="Прохождений пока нет" /> : null}

      {people.map((p) => (
        <Pressable
          key={p.userId}
          onPress={() => router.push(`/analytics/patients/${p.userId}`)}
          accessibilityRole="button"
          accessibilityLabel={p.fullName}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <Card>
            <Row>
              <View style={{ flex: 1 }}>
                <Body>{p.fullName}</Body>
                <Body muted>{p.email}</Body>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={{ color: c.text, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
                  {p.count}
                </Text>
                <Text style={{ color: c.muted, fontSize: 11 }}>
                  {p.last ? p.last.slice(0, 10) : "—"}
                </Text>
              </View>
            </Row>
          </Card>
        </Pressable>
      ))}
    </ScrollView>
  );
}
