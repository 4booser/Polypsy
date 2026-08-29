import { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { WorkItem } from "@quizzy/shared";
import { api } from "@/api/client";
import { Body, Card, Empty, ErrorText, Loader, Row, Title } from "@/components/ui";
import { radius, spacing, useColors } from "@/theme";
import { useLang } from "@/lang";

/**
 * Обход.
 *
 * Планшет в палате вместо ноутбука. Отличие от очереди работы в консоли не в
 * данных, а в порядке: обход идут по палатам, а не по видам работы, поэтому
 * список сгруппирован по подразделениям — иначе на каждого второго пациента
 * приходилось бы возвращаться в тот же коридор.
 *
 * Список и открытые карты кладутся в кэш: сети в отделении нет чаще, чем есть.
 * Возраст кэша показывается прямо в шапке — молча показанная вчерашняя очередь
 * хуже пустого экрана, потому что по ней ходят как по сегодняшней.
 */
export default function RoundsScreen() {
  const { ut } = useLang();
  const c = useColors();
  const router = useRouter();

  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const { list, cachedAt: at } = await api.rounds();
      setItems(list.items);
      setCachedAt(at);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("rounds.loadFailed"));
    } finally {
      setBusy(false);
    }
  }, [ut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /*
   * Группировка по подразделению. Внутри — сначала просроченное: в палате
   * решают, к кому подойти первым, а не что за вид работы висит.
   */
  const wards = useMemo(() => {
    const map = new Map<string, WorkItem[]>();
    for (const item of items ?? []) {
      const key = item.unit ?? ut("rounds.noUnit");
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (b.days ?? 0) - (a.days ?? 0));
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [items, ut]);

  if (error && !items) return <ErrorText>{error}</ErrorText>;
  if (!items) return <Loader />;

  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void load()} tintColor={c.primary} />}
    >
      <View style={{ gap: spacing.xs }}>
        <Title>{ut("rounds.title")}</Title>
        {cachedAt ? (
          /*
           * Сети нет — работаем по снимку. Отметка обязательна: обход по
           * вчерашнему списку выглядит точно так же, как по сегодняшнему.
           */
          <Text style={{ color: c.accent, fontSize: 13 }}>
            {ut("rounds.offline")} {cachedAt.slice(0, 16).replace("T", " ")}
          </Text>
        ) : (
          <Body muted>{ut("rounds.sub")}</Body>
        )}
      </View>

      {items.length === 0 ? (
        <Empty text={`${ut("rounds.empty")}. ${ut("rounds.emptyHint")}`} />
      ) : null}

      {wards.map(([unit, list]) => (
        <View key={unit} style={{ gap: spacing.sm }}>
          <Row>
            <Text style={{ color: c.muted, fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5 }}>
              {unit}
            </Text>
            <Text style={{ color: c.muted, fontSize: 13 }}> · {list.length}</Text>
          </Row>

          {list.map((item) => (
            <Pressable
              key={`${item.kind}:${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${item.userName}. ${item.title}`}
              onPress={() => router.push(`/rounds/${item.userId}`)}
              style={{
                padding: spacing.md,
                borderRadius: radius.sm,
                borderWidth: 1,
                // просрочка отмечается полосой слева, а не заливкой: в палате
                // экран смотрят под углом, и заливка на солнце теряется
                borderColor: item.overdue ? c.danger : c.border,
                borderLeftWidth: item.overdue ? 3 : 1,
                backgroundColor: c.card,
                gap: 2,
              }}
            >
              <Text style={{ color: c.text, fontWeight: "600", fontSize: 16 }}>{item.userName}</Text>
              <Text style={{ color: c.muted, fontSize: 13 }}>{item.title}</Text>
              {item.overdue ? (
                <Text style={{ color: c.danger, fontSize: 12 }}>
                  {ut("rounds.overdue")} {item.days ?? 0}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ))}

      {items.length ? (
        <Card>
          <Body muted>{ut("rounds.hint")}</Body>
        </Card>
      ) : null}
    </ScrollView>
  );
}
