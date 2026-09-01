import { useCallback, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { FreeSlot } from "@quizzy/shared";
import { api } from "@/api/client";
import { Body, Button, Card, Field, Loader, Title } from "@/components/ui";
import { useLang } from "@/lang";
import { spacing, type, useColors } from "@/theme";

type Specialist = {
  userId: string;
  fullName: string;
  room: string | null;
  position: string | null;
  isLead: boolean;
};

/**
 * Запись на приём.
 *
 * Записаться можно к любому свободному специалисту — это выбор в пользу
 * доступности. Плата за него, размывание преемственности, гасится здесь одной
 * вещью: свой специалист стоит первым и помечен. Человек выбирает другого
 * осознанно, а не потому, что не разобрался.
 */
export default function BookingScreen() {
  const c = useColors();
  const { ut } = useLang();
  const router = useRouter();

  const [specialists, setSpecialists] = useState<Specialist[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [slots, setSlots] = useState<FreeSlot[] | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void api
        .specialists()
        .then((r) => setSpecialists(r.items))
        .catch(() => setSpecialists([]));
    }, []),
  );

  const pick = async (userId: string) => {
    setPicked(userId);
    setSlots(null);
    const res = await api.freeSlots({ specialistId: userId }).catch(() => ({ items: [] }));
    setSlots(res.items);
  };

  const book = async (slot: FreeSlot) => {
    setBusy(true);
    try {
      const res = await api.book({ slotId: slot.id, reason: reason.trim() || null });
      /*
       * Скрининг предлагается сразу после записи, а не напоминанием назавтра.
       * Человек только что нажал «записаться» и находится ровно в той точке,
       * где готов потратить пять минут; через день он забудет.
       */
      if (res.screeningSurveyId) {
        Alert.alert(ut("bk.booked"), `${ut("bk.screeningOffer")}\n\n${ut("bk.screeningNoScore")}`, [
          { text: ut("bk.screeningLater"), style: "cancel", onPress: () => router.replace("/home") },
          {
            text: ut("bk.screeningStart"),
            onPress: () => router.replace(`/survey/${res.screeningSurveyId}`),
          },
        ]);
      } else {
        Alert.alert(ut("bk.booked"), "", [
          { text: "OK", onPress: () => router.replace("/home") },
        ]);
      }
    } finally {
      setBusy(false);
    }
  };

  if (specialists === null) return <Loader />;

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }}>
      <Title>{ut("bk.pickSpecialist")}</Title>
      {specialists.map((s) => (
        <Card key={s.userId}>
          <Body>{s.fullName}</Body>
          {/*
            Пометка «ваш специалист» — не украшение: без неё человек, у
            которого уже есть ведущий, выбирает по первому попавшемуся имени.
          */}
          {s.isLead ? (
            <Text style={{ ...type.caption, color: c.primary }}>{ut("bk.yours")}</Text>
          ) : null}
          {s.position ? <Body muted>{s.position}</Body> : null}
          <View style={{ marginTop: spacing.md }}>
            <Button
              title={ut("bk.pickTime")}
              variant={picked === s.userId ? "primary" : "secondary"}
              onPress={() => void pick(s.userId)}
            />
          </View>
        </Card>
      ))}

      {picked ? (
        <View style={{ gap: spacing.sm }}>
          <Title>{ut("bk.pickTime")}</Title>
          {slots === null ? (
            <Loader />
          ) : slots.length === 0 ? (
            <Card>
              <Body muted>{ut("bk.noFree")}</Body>
            </Card>
          ) : (
            <>
              {/*
                Причина обращения необязательна намеренно: принуждать
                формулировать проблему до встречи неверно. Но если человек
                написал — специалист прочитает это до приёма, и разговор
                начнётся не с нуля.
              */}
              <Field
                label={ut("bk.reason")}
                placeholder={ut("bk.reasonHint")}
                value={reason}
                onChangeText={setReason}
                multiline
              />
              {slots.slice(0, 40).map((slot) => (
                <Card key={slot.id}>
                  <Body>
                    {new Date(slot.startsAt).toLocaleDateString([], {
                      day: "2-digit",
                      month: "long",
                      weekday: "short",
                    })}
                    {", "}
                    {new Date(slot.startsAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Body>
                  <View style={{ marginTop: spacing.sm }}>
                    <Button title={ut("bk.book")} disabled={busy} onPress={() => void book(slot)} />
                  </View>
                </Card>
              ))}
            </>
          )}
        </View>
      ) : null}
    </ScrollView>
  );
}
