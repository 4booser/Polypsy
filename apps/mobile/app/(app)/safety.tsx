import { useEffect, useLayoutEffect, useState } from "react";
import { Linking, ScrollView, Share, View } from "react-native";
import { useNavigation } from "expo-router";
import type { SafetyPlan } from "@quizzy/shared";
import { api } from "@/api/client";
import { Loader } from "@/components/ui";
import { personName } from "@/components/patient/Avatar";
import { Hero, HeroMeta } from "@/components/patient/Hero";
import { useLang } from "@/lang";
import { useColors, useIsDark } from "@/theme";
import { Btn } from "@/ui/Button";
import type { IconName } from "@/ui/Icon";
import { Panel, type Tone } from "@/ui/Panel";
import { Pill } from "@/ui/Pill";
import { CallRow } from "@/ui/Rows";
import { T } from "@/ui/Text";

/** Звонить можно туда, где в контакте есть хоть одна цифра */
const dialable = (contact: string) => /\d/.test(contact);

/**
 * Мой план безопасности.
 *
 * Экран существует ради одного сценария: человеку плохо, рядом никого,
 * телефон в руке. Поэтому здесь нет ни навигации вглубь, ни загрузки по
 * нажатию — план лежит на устройстве и открывается в самолётном режиме
 * (api.mySafetyPlan кладёт его в кэш владельца), а телефоны нажимаются и
 * звонят сразу. Внизу, всегда на виду, — 7333 и 103: даже без плана.
 *
 * Звонки — первым разделом: в кризис человек открывает план, чтобы
 * позвонить, а не перечитать признаки. Остальные разделы — в порядке
 * действий: признаки, что сделать самому, что отвлекает, ради чего жить.
 */
export default function SafetyScreen() {
  const c = useColors();
  const { ut, locale } = useLang();
  const navigation = useNavigation();
  const [plan, setPlan] = useState<SafetyPlan | null | undefined>(undefined);

  useEffect(() => {
    void api
      .mySafetyPlan()
      .then((res) => setPlan(res.plan))
      .catch(() => setPlan(null));
  }, []);

  /*
   * «Поділитися» — справа в шапке: план отправляют близким, которые в нём
   * названы, текстом, без приложения. Помощь на этом экране не нужна
   * отдельной кнопкой — экран сам и есть помощь, а 7333 и 103 стоят внизу.
   */
  useLayoutEffect(() => {
    const content = plan?.content;
    navigation.setOptions({
      headerRight: content
        ? () => (
            <Btn
              icon="share"
              kind="outline"
              accessibilityLabel={ut("mpt.sp.share")}
              onPress={() =>
                void Share.share({
                  message: [
                    ut("sp.title"),
                    section(ut("sp.warningSigns"), content.warningSigns),
                    section(ut("sp.coping"), content.copingStrategies),
                    section(ut("sp.distractions"), content.distractions),
                    section(ut("sp.people"), content.people.map((p) => `${p.name}: ${p.contact}`)),
                    section(ut("sp.professionals"), content.professionals.map((p) => `${p.name}: ${p.contact}`)),
                    section(ut("sp.reasons"), content.reasonsToLive),
                    content.meansRestriction ? section(ut("sp.means"), [content.meansRestriction]) : "",
                    `${ut("home.hotline")}: ${ut("home.hotlineNumber")}. ${ut("mui.emergency")}: ${ut("mui.emergencyNumber")}`,
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                }).catch(() => {})
              }
            />
          )
        : undefined,
    });
  }, [navigation, plan, ut]);

  if (plan === undefined) return <Loader />;

  const p = plan?.content;
  const contacts = p ? [...p.people, ...p.professionals] : [];

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <Hero
          title={ut("sp.title")}
          lead={
            plan
              ? ut("mpt.sp.lead")
                  .replace("{who}", personName(plan.authorName))
                  .replace("{v}", String(plan.version))
                  .replace("{d}", new Date(plan.reviewedAt ?? plan.createdAt).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" }))
              : ut("msp.none")
          }
        >
          {plan ? (
            <HeroMeta>
              <Pill kind="good" icon="cloud-check" label={ut("mpt.sp.offline")} />
            </HeroMeta>
          ) : null}
        </Hero>

        <Panel title={ut("mpt.sp.calls")} icon="phone" sub={ut("mpt.sp.oneTap")} pad={false} style={{ marginTop: 16, marginHorizontal: 16 }}>
          <View style={{ borderTopWidth: 1, borderTopColor: c.divider }}>
            {contacts.map((x, i) =>
              dialable(x.contact) ? (
                <CallRow key={`${x.name}-${i}`} first={i === 0} name={x.name} number={x.contact} />
              ) : (
                // контакт без номера («через чергового частини») — строкой, без трубки: звонить некуда
                <View key={`${x.name}-${i}`} style={{ paddingVertical: 12, paddingHorizontal: 16, borderTopWidth: i ? 1 : 0, borderTopColor: c.divider }}>
                  <T v="headline">{x.name}</T>
                  {x.contact ? <T v="sub">{x.contact}</T> : null}
                </View>
              ),
            )}
            <CallRow first={contacts.length === 0} name={ut("home.hotline")} sub={ut("mui.hotlineSub")} number={ut("home.hotlineNumber")} />
            <CallRow name={ut("mui.emergency")} sub={ut("mui.emergencySub")} number={ut("mui.emergencyNumber")} tone="risk" />
          </View>
        </Panel>

        {p ? (
          <>
            <PlanList icon="eye" title={ut("sp.warningSigns")} items={p.warningSigns} />
            <PlanList icon="hand-heart" title={ut("sp.coping")} items={p.copingStrategies} />
            <PlanList icon="map-pin" title={ut("sp.distractions")} items={p.distractions} />
            <PlanList icon="heart" title={ut("sp.reasons")} items={p.reasonsToLive} />
            {p.meansRestriction ? (
              <Panel title={ut("sp.means")} icon="shield-check" tone="good" style={{ marginTop: 16, marginHorizontal: 16 }}>
                <T v="body">{p.meansRestriction}</T>
              </Panel>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      {/* 7333 и 103 — всегда внизу, на виду, одним нажатием и без подтверждения */}
      <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: c.panel, borderTopWidth: 1, borderTopColor: c.divider }}>
        <Btn
          title={ut("mpt.sp.callHotline").replace("{n}", ut("home.hotlineNumber"))}
          kind="primary"
          size="l"
          icon="phone"
          flex={2}
          onPress={() => void Linking.openURL(`tel:${ut("home.hotlineNumber")}`)}
        />
        <Btn
          title={ut("mui.emergencyNumber")}
          kind="risk"
          size="l"
          icon="phone"
          flex={1}
          accessibilityLabel={`${ut("mui.emergency")}, ${ut("mui.emergencyNumber")}`}
          onPress={() => void Linking.openURL(`tel:${ut("mui.emergencyNumber")}`)}
        />
      </View>
    </View>
  );
}

function section(title: string, items: string[]): string {
  return items.length ? `${title}\n${items.map((x) => `• ${x}`).join("\n")}` : "";
}

/** Раздел плана — список пунктов своими словами человека, без нумерации-оценки */
function PlanList({ icon, title, items, tone }: { icon: IconName; title: string; items: string[]; tone?: Tone }) {
  const c = useColors();
  const dark = useIsDark();
  if (!items.length) return null;
  return (
    <Panel title={title} icon={icon} tone={tone} pad={false} style={{ marginTop: 16, marginHorizontal: 16 }}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
        {items.map((x, i) => (
          <View key={i} style={{ flexDirection: "row", gap: 12, paddingVertical: 6 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, marginTop: 9, backgroundColor: dark ? c.vink : c.v }} />
            <T v="body" style={{ flex: 1 }}>
              {x}
            </T>
          </View>
        ))}
      </View>
    </Panel>
  );
}
