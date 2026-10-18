import { useCallback, useState } from "react";
import { ScrollView, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api } from "@/api/client";
import { codeOf } from "@/catalog/surveysTab";
import { ErrorText } from "@/components/ui";
import { Hero } from "@/components/patient/Hero";
import { useLang } from "@/lang";
import { radius, useColors, useShadows } from "@/theme";
import { Btn } from "@/ui/Button";
import { List, ListRow, Panel, SectionHead, Squircle } from "@/ui/Panel";
import { Count, Pill } from "@/ui/Pill";
import { BottomSheet } from "@/ui/Sheet";
import { T } from "@/ui/Text";
import { useToast } from "@/ui/Toast";

type Item = ReturnType<typeof api.queueItems>[number];
type Ownerless = ReturnType<typeof api.ownerlessItems>[number];

/**
 * Что именно не ушло на сервер.
 *
 * Полоса состояния говорит «ждут связи: 3» — и этого мало. Человек, у
 * которого что-то не отправилось, хочет знать, что именно, и убедиться, что
 * его ответы не пропали. А отвергнутую сервером сдачу надо разбирать
 * поштучно: молча выбрасывать клинические данные нельзя.
 */
export default function QueueScreen() {
  const c = useColors();
  const sh = useShadows();
  const { ut, locale } = useLang();
  const toast = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [ownerlessItems, setOwnerless] = useState<Ownerless[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<Ownerless | null>(null);

  const reload = useCallback(() => {
    setItems(api.queueItems());
    setOwnerless(api.ownerlessItems());
  }, []);
  useFocusEffect(useCallback(() => reload(), [reload]));

  const waiting = items.filter((i) => !i.rejectedReason);
  const rejected = items.filter((i) => i.rejectedReason);
  const when = (iso: string) =>
    `${new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" })}, ${new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`;
  const title = (i: { surveyTitle?: string | null; surveyId: string }) => (i.surveyTitle ? codeOf(i.surveyTitle).name : i.surveyId.slice(0, 8));
  const code = (i: { surveyTitle?: string | null }) => (i.surveyTitle ? codeOf(i.surveyTitle).code : null);
  const nothing = items.length === 0 && ownerlessItems.length === 0;

  const flush = async () => {
    setBusy(true);
    try {
      await api.flushQueue();
    } catch {
      /* сети нет — записи целы, полоса и экран скажут, сколько ждёт */
    } finally {
      reload();
      setBusy(false);
    }
    const left = api.pendingCount();
    toast.show(left ? ut("mpt.q.stillWaiting").replace("{n}", String(left)) : ut("mq.allSent"), left ? { icon: "cloud-off" } : undefined);
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <Hero title={ut("mq.title")} lead={ut("mq.hint")} />

        {error ? (
          <View style={{ marginTop: 16, marginHorizontal: 16 }}>
            <ErrorText>{error}</ErrorText>
          </View>
        ) : null}

        {nothing ? (
          <View style={{ alignItems: "center", gap: 12, paddingTop: 40, paddingHorizontal: 32 }}>
            <Squircle icon="cloud-check" tone="good" size={56} />
            <T v="headline">{ut("mq.allSent")}</T>
          </View>
        ) : null}

        {waiting.length ? (
          <>
            <Panel style={{ marginTop: 16, marginHorizontal: 16 }}>
              <View style={{ flexDirection: "row", gap: 12 }}>
                <Squircle icon="wifi-off" tone="n" />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T v="headline">{ut("mpt.q.netTitle")}</T>
                  <T v="note" tone="text2" style={{ marginTop: 2 }}>
                    {ut("mpt.q.netText")}
                  </T>
                </View>
              </View>
              <Btn title={ut("mq.tryNow")} icon="refresh-cw" full loading={busy} onPress={() => void flush()} style={{ marginTop: 4 }} />
            </Panel>
            <SectionHead title={ut("mq.waiting")} right={<Count n={waiting.length} />} />
            <List>
              {waiting.map((i, n) => (
                <ListRow
                  key={i.id}
                  first={n === 0}
                  title={title(i)}
                  sub={[code(i), ut("mpt.q.savedAt").replace("{at}", when(i.queuedAt)), i.attempts > 0 ? `${ut("mq.attempts")} ${i.attempts}` : null]
                    .filter(Boolean)
                    .join(", ")}
                  lead={<Squircle icon="clipboard-check" tone="n" />}
                />
              ))}
            </List>
          </>
        ) : null}

        {rejected.length ? (
          <>
            <SectionHead title={ut("mq.rejected")} right={<Pill kind="warn" icon="circle-alert" label={String(rejected.length)} />} />
            <View style={{ marginHorizontal: 16, borderRadius: radius.panel, borderWidth: 1, borderColor: c.warnline, backgroundColor: c.panel, boxShadow: sh.panel, overflow: "hidden" }}>
              {rejected.map((i, n) => (
                <View key={i.id} style={{ borderTopWidth: n ? 1 : 0, borderTopColor: c.divider }}>
                  <ListRow
                    first
                    title={title(i)}
                    sub={[code(i), when(i.queuedAt)].filter(Boolean).join(", ")}
                    lead={<Squircle icon="file-warning" tone="warn" />}
                    end={undefined}
                  />
                  <View style={{ paddingHorizontal: 16, paddingBottom: 14, gap: 10, marginTop: -6 }}>
                    <T v="note" weight={700} color={c.warn}>
                      {i.rejectedReason}
                    </T>
                    <T v="note" tone="text2">
                      {ut("mq.rejectedHint")}
                    </T>
                    <Btn
                      title={ut("mq.retry")}
                      icon="rotate-ccw"
                      full
                      onPress={async () => {
                        try {
                          api.retryQueued(i.id);
                        } catch {
                          // пометку снять не удалось (устройство не пишет) — запись цела, просто остаётся отвергнутой
                          setError(ut("common.error"));
                          return;
                        }
                        setError(null);
                        await api.flushQueue().catch(() => {});
                        reload();
                      }}
                    />
                  </View>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {/*
          Сдачи без владельца — положенные до того, как у очереди появился
          владелец (offline/queue.ts, ownerless). Сами они не уйдут никогда:
          отправить их от имени того, кто сейчас вошёл, — ровно та ошибка,
          из-за которой владелец и появился. Решает человек: узнал своё —
          «це мої», и сдача уходит от его имени. Содержимого ответов здесь нет
          намеренно: методики и времени хватает, чтобы узнать своё, и не
          хватает, чтобы прочитать чужое.
        */}
        {ownerlessItems.length ? (
          <>
            <SectionHead title={ut("mq.ownerless")} right={<Count n={ownerlessItems.length} />} />
            <View style={{ marginHorizontal: 16 }}>
              <T v="note" tone="text2" style={{ marginBottom: 10, marginHorizontal: 4 }}>
                {ut("mq.ownerlessHint")}
              </T>
            </View>
            <List>
              {ownerlessItems.map((i, n) => (
                <View key={i.id} style={{ borderTopWidth: n ? 1 : 0, borderTopColor: c.divider }}>
                  <ListRow first title={title(i)} sub={[code(i), when(i.queuedAt)].filter(Boolean).join(", ")} lead={<Squircle icon="user-round-x" tone="n" />} />
                  <View style={{ paddingHorizontal: 16, paddingBottom: 14, marginTop: -4 }}>
                    <Btn title={ut("mq.claim")} icon="user-round-check" full onPress={() => setClaiming(i)} />
                  </View>
                </View>
              ))}
            </List>
          </>
        ) : null}
      </ScrollView>

      <BottomSheet
        visible={!!claiming}
        onClose={() => setClaiming(null)}
        title={ut("mpt.q.claimTitle")}
        sub={claiming ? `${title(claiming)}, ${when(claiming.queuedAt)}` : undefined}
        footer={
          <>
            <Btn
              title={ut("mpt.q.claimYes")}
              kind="primary"
              size="l"
              icon="user-round-check"
              full
              onPress={async () => {
                const item = claiming;
                setClaiming(null);
                if (!item) return;
                try {
                  api.claimQueued(item.id);
                } catch {
                  setError(ut("common.error"));
                  return;
                }
                setError(null);
                await api.flushQueue().catch(() => {});
                reload();
              }}
            />
            <Btn title={ut("mpt.q.claimNo")} size="l" full onPress={() => setClaiming(null)} />
          </>
        }
      >
        <View style={{ paddingHorizontal: 20 }}>
          <T v="body">{ut("mpt.q.claimText")}</T>
        </View>
      </BottomSheet>
    </View>
  );
}
