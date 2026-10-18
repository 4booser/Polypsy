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
 * Полоса живёт на фиолетовой полосе шапки, под заголовком (TabHeader), —
 * карточкой полосы, как в наборе. Красной она не бывает: несданные ответы —
 * не риск для человека; отказ сервера отмечен янтарным значком.
 */
export function OfflineBar() {
  const { ut } = useLang();
  const c = useColors();
  const router = useRouter();
  const [left, setLeft] = useState(0);
  const [rejected, setRejected] = useState(0);
  // сдачи без владельца (offline/queue.ts, ownerless): сами не уйдут, их надо узнать на экране очереди
  const [unclaimed, setUnclaimed] = useState(0);
  const [busy, setBusy] = useState(false);

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
  /*
   * Безхозные сдачи — не беда и не повод красить полосу: это не отказ, а
   * вопрос «чьё это». Но и повтор им бесполезен — сами они не уйдут, —
   * поэтому полоса ведёт на экран очереди, как и при отказе. Своё
   * ждущее важнее: пока оно есть, полоса говорит о нём.
   */
  const toQueue = problem || (left === 0 && unclaimed > 0);
  const onPress = toQueue ? () => router.push("/(app)/queue") : retry;

  const text = problem
    ? ut("ob.rejected").replace("{n}", String(rejected))
    : left > 0
      ? ut("ob.waiting").replace("{n}", String(left))
      : ut("ob.ownerless").replace("{n}", String(unclaimed));
  const action = toQueue ? ut("mob.resolve") : busy ? ut("mob.sending") : ut("common.retry");

  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={
        problem
          ? ut("ob.rejectedHint").replace("{n}", String(rejected))
          : left > 0
            ? ut("ob.waitingHint").replace("{n}", String(left))
            : ut("ob.ownerless").replace("{n}", String(unclaimed))
      }
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
        marginHorizontal: 16,
        marginBottom: 10,
        paddingLeft: 14,
        paddingRight: 12,
        paddingVertical: 8,
        borderRadius: radius.panel,
        borderWidth: 1,
        borderColor: c.bcardline,
        backgroundColor: pressed ? c.vtint2 : c.bcard,
      })}
    >
      <Icon name={problem ? "circle-alert" : "cloud-off"} size={18} color={problem ? c.warn : c.muted} />
      <T v="body" size={15} weight={700} style={{ flex: 1 }}>
        {text}
      </T>
      <T v="body" size={15} weight={700} color={c.vink}>
        {action}
      </T>
    </Pressable>
  );
}
