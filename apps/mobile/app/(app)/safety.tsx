import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import type { SafetyPlanContent } from "@quizzy/shared";
import { api } from "@/api/client";
import { Body, Card, Loader, Title } from "@/components/ui";
import { useLang } from "@/lang";
import { radius, spacing, type, useColors } from "@/theme";
import { useEffect, useState } from "react";

/**
 * Мой план безопасности.
 *
 * Экран существует ради одного сценария: человеку плохо, рядом никого,
 * телефон в руке. Поэтому здесь нет ни навигации вглубь, ни загрузки по
 * нажатию — план лежит на устройстве и открывается в самолётном режиме, а
 * телефоны нажимаются и звонят сразу.
 *
 * Порядок разделов повторяет порядок действий в кризисе: сначала то, что
 * человек может сделать один, потом отвлечение, потом люди и лишь затем
 * дежурная служба. Так план работает и тогда, когда сил на звонок ещё нет.
 */
export default function SafetyScreen() {
  const c = useColors();
  const { ut } = useLang();
  const [plan, setPlan] = useState<{ content: SafetyPlanContent } | null | undefined>(undefined);

  useEffect(() => {
    void api
      .mySafetyPlan()
      .then((res) => setPlan(res.plan))
      .catch(() => setPlan(null));
  }, []);

  if (plan === undefined) return <Loader />;

  if (!plan) {
    return (
      <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }}>
        <Title>{ut("sp.title")}</Title>
        <Card>
          <Body muted>{ut("msp.none")}</Body>
        </Card>
      </ScrollView>
    );
  }

  const p = plan.content;

  const list = (label: string, items: string[]) =>
    items.length ? (
      <Card>
        <Text style={[type.caption, { color: c.muted, textTransform: "uppercase", letterSpacing: 0.6 }]}>
          {label}
        </Text>
        {items.map((x, i) => (
          <View key={i} style={{ flexDirection: "row", gap: spacing.sm, marginTop: 6 }}>
            <Text style={[type.body, { color: c.accent }]}>{i + 1}</Text>
            <Text style={[type.body, { color: c.text, flex: 1 }]}>{x}</Text>
          </View>
        ))}
      </Card>
    ) : null;

  const contacts = (label: string, items: { name: string; contact: string }[], urgent?: boolean) =>
    items.length ? (
      <Card>
        <Text style={[type.caption, { color: c.muted, textTransform: "uppercase", letterSpacing: 0.6 }]}>
          {label}
        </Text>
        {items.map((x, i) => (
          <Pressable
            key={i}
            // номер нажимается и звонит: в кризис переписывать его некуда
            onPress={() => x.contact && Linking.openURL(`tel:${x.contact.replace(/[^+\d]/g, "")}`)}
            accessibilityRole="button"
            accessibilityLabel={`${x.name}. ${x.contact}`}
            style={{
              marginTop: 8,
              padding: spacing.md,
              borderRadius: radius.sm,
              borderWidth: 1,
              borderColor: urgent ? c.danger : c.border,
              backgroundColor: urgent ? `${c.danger}14` : c.cardAlt,
            }}
          >
            <Text style={[type.body, { color: c.text, fontWeight: "600" }]}>{x.name}</Text>
            {x.contact ? <Text style={[type.small, { color: c.muted }]}>{x.contact}</Text> : null}
          </Pressable>
        ))}
      </Card>
    ) : null;

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.md }}>
      <Title>{ut("sp.title")}</Title>
      <Body muted>{ut("msp.offlineHint")}</Body>

      {list(ut("sp.warningSigns"), p.warningSigns)}
      {list(ut("sp.coping"), p.copingStrategies)}
      {list(ut("sp.distractions"), p.distractions)}
      {contacts(ut("sp.people"), p.people)}
      {contacts(ut("sp.professionals"), p.professionals, true)}
      {list(ut("sp.reasons"), p.reasonsToLive)}
      {p.meansRestriction ? (
        <Card>
          <Text style={[type.caption, { color: c.muted, textTransform: "uppercase", letterSpacing: 0.6 }]}>
            {ut("sp.means")}
          </Text>
          <Body>{p.meansRestriction}</Body>
        </Card>
      ) : null}
    </ScrollView>
  );
}
