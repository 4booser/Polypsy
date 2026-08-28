import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api } from "../api/client";
import { spacing, useColors } from "../theme";
import { useLang } from "@/lang";

/**
 * Полоса «нет связи» поверх всех экранов.
 *
 * Раньше состояние очереди было видно только в профиле — то есть человек,
 * сдавший методику в подвале без сети, уходил в уверенности, что ответы
 * отправлены. Молчание в этом месте недопустимо: обследуемый должен знать,
 * что его ответы ещё на устройстве, и не удалять приложение.
 *
 * Формулировка выбрана нетревожная: ничего не потеряно, отправится само.
 * Пугать человека, который только что отвечал про суицидальные мысли,
 * сообщением об ошибке — плохая идея.
 */
export function OfflineBar() {
  const { ut } = useLang();
  const c = useColors();
  const router = useRouter();
  const [left, setLeft] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const update = () => {
      setLeft(api.pendingCount());
      setRejected(api.rejectedCount());
    };
    update();
    // опрос, а не подписка: очередь меняется из разных мест, и один источник
    // истины проще, чем шина событий ради полоски
    const timer = setInterval(update, 3_000);
    return () => clearInterval(timer);
  }, []);

  if (left === 0 && rejected === 0) return null;

  const retry = async () => {
    setBusy(true);
    try {
      await api.flushQueue();
    } finally {
      setLeft(api.pendingCount());
      setRejected(api.rejectedCount());
      setBusy(false);
    }
  };

  /*
   * Отвергнутое сервером само не уйдёт: там нужен разбор, а не повтор.
   * Поэтому на такой полосе нажатие ведёт на экран очереди, где видно, что
   * именно не принято, а не запускает бесполезную попытку.
   */
  const problem = rejected > 0;
  const onPress = problem ? () => router.push("/(app)/queue") : retry;

  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={
        problem
          ? `Не удалось отправить: ${rejected}. Нажмите, чтобы посмотреть`
          : `Ждут отправки: ${left}. Нажмите, чтобы отправить сейчас`
      }
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        backgroundColor: problem ? c.danger : c.cardAlt,
      }}
    >
      <View
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: problem ? "#fff" : c.muted,
        }}
      />
      <Text style={{ flex: 1, fontSize: 13, color: problem ? "#fff" : c.text }}>
        {problem
          ? `Не удалось отправить: ${rejected}`
          : `Ответы сохранены на устройстве и ждут связи: ${left}`}
      </Text>
      <Text style={{ fontSize: 13, fontWeight: "600", color: problem ? "#fff" : c.primary }}>
        {problem ? ut("mob.resolve") : busy ? ut("mob.sending") : ut("common.retry")}
      </Text>
    </Pressable>
  );
}
