import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import type { RespondentDynamics } from "@quizzy/shared";
import { api } from "@/api/client";
import { SeverityTag } from "@/components/charts";
import { LineChart } from "@/components/viz";
import { Body, Button, Card, Divider, ErrorText, Loader, Row, Title } from "@/components/ui";
import { spacing, useColors } from "@/theme";
import { useLang } from "@/lang";

/**
 * Карта пациента в обходе.
 *
 * Открывается из списка обхода и работает по кэшу, если сети нет: в палате её
 * нет чаще, чем есть. Возраст снимка написан прямо в шапке — карта из вчера
 * выглядит так же, как сегодняшняя, и это опаснее пустого экрана.
 *
 * Показывается только то, что нужно у койки: последний балл по каждой шкале,
 * его толкование и направление изменения. Полная динамика с графиками живёт в
 * разделе аналитики — на обходе её листать некогда.
 */
export default function RoundsCardScreen() {
  const { ut } = useLang();
  const c = useColors();
  const router = useRouter();
  const navigation = useNavigation();
  const { userId } = useLocalSearchParams<{ userId: string }>();

  const [data, setData] = useState<RespondentDynamics | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const { card, cachedAt: at } = await api.roundsCard(userId);
      setData(card);
      setCachedAt(at);
      navigation.setOptions({ title: card.fullName });
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("rounds.loadFailed"));
    }
  }, [userId, navigation, ut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (error && !data) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loader />;

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      <View style={{ gap: spacing.xs }}>
        <Title>{data.fullName}</Title>
        {cachedAt ? (
          <Text style={{ color: c.accent, fontSize: 13 }}>
            {ut("rounds.cardOffline")} {cachedAt.slice(0, 16).replace("T", " ")}
          </Text>
        ) : null}
      </View>

      {data.surveys.length === 0 ? <Card><Body muted>{ut("rounds.noData")}</Body></Card> : null}

      {data.surveys.map((sv) => (
        <Card key={sv.surveyId}>
          <Title>{sv.title}</Title>
          <Body muted>
            {sv.responseCount} · {sv.lastAt?.slice(0, 10) ?? ""}
          </Body>
          <Divider />

          {sv.scales.map((sc) => {
            const last = sc.points.at(-1);
            if (!last) return null;
            return (
              <View key={sc.scaleId} style={{ gap: 4, paddingVertical: spacing.xs }}>
                <Row>
                  <Text style={{ color: c.text, flex: 1 }}>{sc.title}</Text>
                  {/*
                    Число моноширинным: на обходе колонку баллов читают
                    сверху вниз, и разная ширина цифр сбивает счёт.
                  */}
                  <Text style={{ color: c.text, fontVariant: ["tabular-nums"], fontWeight: "600" }}>
                    {last.rawScore}
                  </Text>
                </Row>
                <Row gap={spacing.xs}>
                  {last.severity ? (
                    <SeverityTag severity={last.severity} label={last.bandLabel ?? undefined} />
                  ) : null}
                  {sc.reliableChange ? (
                    <Text style={{ color: c.muted, fontSize: 12 }}>
                      {sc.reliableChange.significant
                        ? ut("pt.rciAbove")
                        : ut("pt.rciWithin")}
                    </Text>
                  ) : null}
                </Row>
                {sc.points.length > 1 ? (
                  <LineChart
                    height={48}
                    series={[
                      {
                        label: sc.title,
                        points: sc.points.map((p) => ({
                          x: p.submittedAt.slice(5, 10),
                          y: p.rawScore,
                          tone: p.severity ?? undefined,
                        })),
                      },
                    ]}
                  />
                ) : null}
              </View>
            );
          })}
        </Card>
      ))}

      {/*
        Заполнить методику за пациента — главное действие у койки: человек
        лежит рядом, а не сидит с телефоном. Ведёт в обычный список методик,
        где выбор уже привязан к этому пациенту.
      */}
      <Button
        title={ut("rounds.fill")}
        onPress={() => router.push(`/(app)/surveys?onBehalfOf=${userId}`)}
      />
    </ScrollView>
  );
}
