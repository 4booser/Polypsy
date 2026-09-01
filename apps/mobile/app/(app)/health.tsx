import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { MyDynamics } from "@quizzy/shared";
import { api } from "@/api/client";
import { Body, Button, Card, Loader, Title } from "@/components/ui";
import { useLang } from "@/lang";
import { spacing, type, useColors } from "@/theme";

/**
 * Здоровье: как меняется и что делать в кризис.
 *
 * Динамика живёт здесь, а не на главной, и это решение, а не раскладка.
 * Главный экран открывают по дороге на приём; свою кривую тревоги человек
 * смотрит в спокойную минуту. Каждый день видеть её первым делом — само по
 * себе вмешательство, и не то, ради которого он сюда пришёл.
 */
export default function HealthScreen() {
  const c = useColors();
  const { ut } = useLang();
  const router = useRouter();
  const [data, setData] = useState<MyDynamics | null | undefined>(undefined);

  useFocusEffect(
    useCallback(() => {
      void api
        .myDynamics()
        .then(setData)
        .catch(() => setData(null));
    }, []),
  );

  if (data === undefined) return <Loader />;

  /*
   * Показываются только методики, где отделение разрешило показывать
   * результат человеку: сервер отдаёт лишь их. Список того, что скрыто, тоже
   * не показываем — иначе человек считал бы, сколько от него скрыли.
   */
  const withHistory = (data?.surveys ?? []).filter((s) =>
    s.scales.some((sc) => sc.points.length >= 2),
  );

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }}>
      <Title>{ut("hl.dynamics")}</Title>

      {withHistory.length === 0 ? (
        <Card>
          {/*
            «Сравнивать пока не с чем» — честнее, чем пустой график.
            Пустой график читается как «всё плохо и данных нет», а правда в
            том, что второго замера ещё не было.
          */}
          <Body muted>{ut("hl.noDynamics")}</Body>
        </Card>
      ) : (
        withHistory.map((s) => (
          <Card key={s.surveyId}>
            <Body>{s.title}</Body>
            {s.scales
              .filter((sc) => sc.points.length >= 2)
              .map((sc) => {
                const points = [...sc.points].sort((a, b) =>
                  a.submittedAt < b.submittedAt ? 1 : -1,
                );
                const latest = points[0]!;
                const before = points[1]!;
                return (
                  <View key={sc.code} style={{ marginTop: spacing.md }}>
                    <Text style={{ ...type.caption, color: c.muted }}>{sc.title}</Text>
                    {/*
                      Два числа и подписи, а не график.
                      График на телефоне по трём точкам показывает шум, а
                      читается как тенденция. Два последних замера с датами
                      говорят ровно то, что известно.
                    */}
                    <Body>
                      {ut("hl.latest")}: {Math.round(latest.value * 10) / 10}
                      {latest.bandLabel ? ` — ${latest.bandLabel}` : ""} ·{" "}
                      {new Date(latest.submittedAt).toLocaleDateString()}
                    </Body>
                    <Body muted>
                      {ut("hl.before")}: {Math.round(before.value * 10) / 10}
                      {before.bandLabel ? ` — ${before.bandLabel}` : ""} ·{" "}
                      {new Date(before.submittedAt).toLocaleDateString()}
                    </Body>
                  </View>
                );
              })}
          </Card>
        ))
      )}

      <Card>
        <Body muted>{ut("home.safetyPlan")}</Body>
        <View style={{ marginTop: spacing.md }}>
          <Button
            title={ut("home.safetyPlan")}
            variant="secondary"
            onPress={() => router.push("/safety")}
          />
        </View>
      </Card>
    </ScrollView>
  );
}
