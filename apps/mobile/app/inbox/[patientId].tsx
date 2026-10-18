import { useCallback, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { api } from "@/api/client";
import { font } from "@/fonts";
import { useLang } from "@/lang";
import { useTextScale } from "@/textScale";
import { radius, useColors } from "@/theme";
import { Btn } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { T } from "@/ui/Text";
import { refreshStaffBadges } from "@/staff/badges";
import { byDay, hm, shortName } from "@/staff/model";
import { BandIcon, Line, LinkButton, Loading, StaffNav, StateBlock } from "@/staff/ui";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type Message = { id: string; mine: boolean; text: string; sentAt: string; readAt: string | null };

/**
 * Разговор специалиста с пациентом.
 *
 * Письма по дням, свои — справа, с отметкой «прочитано». Прочитанными
 * письма пациента становятся только показанные (markRead), а не все
 * сразу. Переписки ещё нет (пишут из карты) — первый лист её заведёт.
 */
export default function ThreadScreen() {
  const { ut, locale } = useLang();
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { fs } = useTextScale();
  const { patientId } = useLocalSearchParams<{ patientId: string }>();

  const [threadId, setThreadId] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState<string | null>(null);
  const [items, setItems] = useState<Message[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.threads();
      const t = list.items.find((x) => x.patientId === patientId);
      setName(t?.withName ?? null);
      setThreadId(t?.id ?? null);
      if (!t) return;
      const page = await api.thread(t.id);
      setItems(page.items);
      setBefore(page.hasMore ? page.nextBefore : null);
      const ids = page.items.filter((m) => !m.mine && !m.readAt).map((m) => m.id);
      if (ids.length) {
        void api
          .markRead(t.id, ids)
          .then(refreshStaffBadges)
          .catch(() => {});
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("common.error"));
      setThreadId((id) => (id === undefined ? null : id));
    }
  }, [patientId, ut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const earlier = async () => {
    if (!threadId || !before) return;
    const page = await api.thread(threadId, before).catch(() => null);
    if (!page) return;
    setItems((prev) => [...page.items, ...prev]);
    setBefore(page.hasMore ? page.nextBefore : null);
  };

  const send = async () => {
    const body = text.trim();
    if (!body || !patientId) return;
    setBusy(true);
    setError(null);
    try {
      await api.sendMessage(body, patientId);
      setText("");
      await load();
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("common.error"));
    } finally {
      setBusy(false);
    }
  };

  const days = byDay(items, (m) => m.sentAt, new Date());
  const dayLabel = (day: string, ago: number) =>
    ago === 0 ? ut("mst.today") : ago === 1 ? ut("mst.yesterday") : new Date(`${day}T12:00:00`).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.ground }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <StaffNav
        back={ut("ms.title")}
        title={name ? shortName(name) : ut("mst.newMessage")}
        right={patientId ? <BandIcon icon="user-round" label={ut("mst.openCard")} onPress={() => router.push({ pathname: "/analytics/patients/[userId]", params: { userId: patientId } })} /> : undefined}
      />
      {threadId === undefined ? (
        <Loading />
      ) : (
        <ScrollView ref={scroll} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, gap: 10 }} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
          <Line icon="clock">{ut("mst.inboxBounds")}</Line>
          {before ? (
            <View style={{ alignItems: "center" }}>
              <LinkButton label={ut("mst.earlier")} onPress={() => void earlier()} />
            </View>
          ) : null}
          {threadId === null && !error ? <StateBlock icon="message-square-text" title={ut("mst.noThreadYet")} text={ut("mst.noThreadYetHint")} /> : null}
          {[...days].reverse().map((d) => (
            <View key={d.day} style={{ gap: 10 }}>
              <View style={{ alignSelf: "center", paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, backgroundColor: c.sunk }}>
                <T v="sub" size={13} tone="text2">
                  {dayLabel(d.day, d.ago)}
                </T>
              </View>
              {d.rows.map((m) => (
                <View
                  key={m.id}
                  style={{
                    alignSelf: m.mine ? "flex-end" : "flex-start",
                    maxWidth: "86%",
                    paddingVertical: 10,
                    paddingHorizontal: 14,
                    borderRadius: 16,
                    borderBottomRightRadius: m.mine ? 6 : 16,
                    borderBottomLeftRadius: m.mine ? 16 : 6,
                    backgroundColor: m.mine ? c.vtint : c.panel,
                    borderWidth: m.mine ? 0 : 1,
                    borderColor: c.border,
                  }}
                >
                  <T v="note" tone="text">
                    {m.text}
                  </T>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: m.mine ? "flex-end" : "flex-start", marginTop: 4 }}>
                    {m.mine ? <Icon name={m.readAt ? "check-check" : "check"} size={13} color={m.readAt ? c.good : c.muted} /> : null}
                    <T v="sub" size={12.5} num>
                      {m.mine ? `${hm(m.sentAt)}, ${m.readAt ? ut("mst.read") : ut("mst.sent")}` : hm(m.sentAt)}
                    </T>
                  </View>
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      )}
      <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: Math.max(12, insets.bottom), backgroundColor: c.panel, borderTopWidth: 1, borderTopColor: c.divider, gap: 6 }}>
        {error ? (
          <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }} accessibilityLiveRegion="polite">
            <Icon name="circle-alert" size={16} color={c.riskink} />
            <T v="sub" weight={700} color={c.riskink} style={{ flex: 1 }}>
              {error}
            </T>
          </View>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={ut("mst.replyPh")}
            placeholderTextColor={c.muted}
            accessibilityLabel={ut("mst.replyPh")}
            style={{
              flex: 1,
              minHeight: 48,
              maxHeight: 140,
              paddingHorizontal: 12,
              paddingTop: 12,
              paddingBottom: 12,
              borderRadius: radius.control,
              borderWidth: 1,
              borderColor: c.field,
              backgroundColor: c.panel,
              color: c.text,
              fontSize: fs(15),
              textAlignVertical: "top",
              ...font(500),
            }}
          />
          <Btn title="" icon="arrow-right" kind="primary" accessibilityLabel={ut("mst.send")} loading={busy} disabled={!text.trim()} onPress={() => void send()} style={{ width: 48, height: 48, borderRadius: 24 }} />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
