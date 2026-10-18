import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import type { SafetyPlanContent } from "@quizzy/shared";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useLang } from "../lang";
import { radius, useColors } from "../theme";
import { Btn } from "./Button";
import { CallRow } from "./Rows";
import { BottomSheet } from "./Sheet";
import { T } from "./Text";

/** Звонить можно туда, где в контакте есть хоть одна цифра */
const dialable = (contact: string) => /\d/.test(contact);

/**
 * Лист «Потрібна допомога зараз» — телефонная форма панели помощи консоли.
 *
 * Сверху телефон доверия, затем люди и специалисты из плана безопасности
 * человека, последним — 103. Красный только у 103: это угроза жизни, а не
 * оформление. План берётся из кэша устройства, если сети нет: лист обязан
 * работать в самолётном режиме так же, как экран плана.
 *
 * Переписка внизу — с оговоркой, что это не экстренная связь: человек в
 * кризис напишет и будет ждать вместо того, чтобы позвонить.
 */
export function HelpSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const c = useColors();
  const { ut } = useLang();
  const router = useRouter();
  const { user } = useAuth();
  const [plan, setPlan] = useState<SafetyPlanContent | null>(null);

  useEffect(() => {
    if (!visible || !user) return;
    let alive = true;
    void api
      .mySafetyPlan()
      .then((res) => {
        if (alive) setPlan(res.plan?.content ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible, user]);

  const contacts = [...(plan?.people ?? []), ...(plan?.professionals ?? [])].filter((x) => dialable(x.contact));
  const go = (href: "/safety" | "/messages") => {
    onClose();
    router.push(href);
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={ut("mui.helpTitle")}
      sub={ut("mui.helpSub")}
      footer={
        user ? (
          <>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn title={ut("home.safetyPlan")} icon="shield-check" size="m" flex={1} onPress={() => go("/safety")} />
              <Btn title={ut("ms.write")} icon="message-square-text" size="m" flex={1} onPress={() => go("/messages")} />
            </View>
            <T v="sub" style={{ marginTop: 4, marginHorizontal: 4 }}>
              {ut("ms.boundaries")}
            </T>
          </>
        ) : null
      }
    >
      <View style={{ marginHorizontal: 16, borderWidth: 1, borderColor: c.border, borderRadius: radius.tile, overflow: "hidden" }}>
        <CallRow first name={ut("home.hotline")} sub={ut("mui.hotlineSub")} number={ut("home.hotlineNumber")} />
        {contacts.map((x, i) => (
          <CallRow key={`${x.name}-${i}`} name={x.name} number={x.contact} />
        ))}
        <CallRow name={ut("mui.emergency")} sub={ut("mui.emergencySub")} number={ut("mui.emergencyNumber")} tone="risk" />
      </View>
    </BottomSheet>
  );
}
