import { useEffect, useState } from "react";
import { Pressable } from "react-native";
import { useRouter } from "expo-router";
import { api } from "../api/client";
import { radius, useColors } from "../theme";
import { Icon } from "../ui/Icon";
import { T } from "../ui/Text";
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
 *
 * Полоса живёт на фиолетовой полосе шапки, под строкой навигации, —
 * карточкой полосы, как в наборе, — и ведёт на экран очереди: там видно,
 * что именно ждёт, что сервер не принял и почему, и там же «Спробувати
 * зараз». Красной она не бывает: несданные ответы — не риск для человека;
 * отказ сервера отмечен янтарным значком.
 */
export function OfflineBar() {
  const { ut } = useLang();
  const c = useColors();
  const router = useRouter();
  const [left, setLeft] = useState(0);
  const [rejected, setRejected] = useState(0);
  // сдачи без владельца (offline/queue.ts, ownerless): сами не уйдут, их надо узнать на экране очереди
  const [unclaimed, setUnclaimed] = useState(0);

  useEffect(() => {
    const update = () => {
      setLeft(api.pendingCount());
      setRejected(api.rejectedCount());
      setUnclaimed(api.ownerlessCount());
    };
    update();
    // опрос, а не подписка: очередь меняется из разных мест, и один источник
    // истины проще, чем шина событий ради полоски
    const timer = setInterval(update, 3_000);
    return () => clearInterval(timer);
  }, []);

  if (left === 0 && rejected === 0 && unclaimed === 0) return null;

  const problem = rejected > 0;
  const parts = [
    left ? ut("mpt.ob.waiting").replace("{n}", String(left)) : null,
    rejected ? ut("mpt.ob.rejected").replace("{n}", String(rejected)) : null,
    unclaimed ? ut("mpt.ob.ownerless").replace("{n}", String(unclaimed)) : null,
  ].filter(Boolean);

  return (
    <Pressable
      onPress={() => router.push("/(app)/queue")}
      accessibilityRole="button"
      accessibilityLabel={
        problem
          ? ut("ob.rejectedHint").replace("{n}", String(rejected))
          : left > 0
            ? ut("ob.waiting").replace("{n}", String(left))
            : ut("ob.ownerless").replace("{n}", String(unclaimed))
      }
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
        marginHorizontal: 16,
        marginBottom: 6,
        paddingLeft: 14,
        paddingRight: 12,
        paddingVertical: 8,
        borderRadius: radius.panel,
        borderWidth: 1,
        borderColor: c.bcardline,
        backgroundColor: pressed ? c.vtint2 : c.bcard,
      })}
    >
      <Icon name={problem ? "circle-alert" : "cloud-off"} size={17} color={problem ? c.warn : c.muted} />
      <T v="body" size={15} weight={700} style={{ flex: 1 }} numberOfLines={1}>
        {parts.join(", ")}
      </T>
      <Icon name="chevron-right" size={17} color={c.muted} />
    </Pressable>
  );
}
