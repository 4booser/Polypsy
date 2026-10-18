import { useCallback, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { api } from "@/api/client";
import { Loader } from "@/components/ui";
import { Avatar, personName } from "@/components/patient/Avatar";
import { font } from "@/fonts";
import { useLang } from "@/lang";
import { useColors, useIsDark } from "@/theme";
import { useTextScale } from "@/textScale";
import { Btn } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { Callout } from "@/ui/Panel";
import { T } from "@/ui/Text";
import { useToast } from "@/ui/Toast";

type Message = { id: string; mine: boolean; text: string; sentAt: string; readAt: string | null };

/** «Прочитано» — отдельным запросом и только по показанным письмам собеседника */
function markShown(threadId: string, shown: Message[]) {
  const ids = shown.filter((m) => !m.mine && !m.readAt).map((m) => m.id);
  if (ids.length) void api.markRead(threadId, ids).catch(() => {});
}

const dayKey = (iso: string) => new Date(iso).toDateString();

/**
 * Переписка со своим специалистом.
 *
 * Границы названы прямо здесь, над полем ввода, а не в правилах, которые
 * никто не читает: ответ в рабочее время, это не экстренная связь, в кризис —
 * план безопасности и телефон. Обещание круглосуточного ответа в
 * психологическом отделе опаснее отсутствия переписки вовсе: человек напишет
 * и будет ждать вместо того, чтобы позвонить.
 */
export default function MessagesScreen() {
  const c = useColors();
  const dark = useIsDark();
  const { ut, locale } = useLang();
  const { fs } = useTextScale();
  const router = useRouter();
  const toast = useToast();
  const scroll = useRef<ScrollView>(null);
  /** После загрузки и отправки — к последнему письму; после «показати ще» — нет: человек читает старое */
  const stickToEnd = useRef(true);
  const [threadId, setThreadId] = useState<string | null | undefined>(undefined);
  const [withName, setWithName] = useState<string | null>(null);
  const [items, setItems] = useState<Message[]>([]);
  /* курсор к более ранним письмам: сервер отдаёт последние, а не первые пятьсот */
  const [before, setBefore] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState(false);

  const load = useCallback(async () => {
    const list = await api.threads().catch(() => ({ items: [], lead: null }));
    const first = list.items[0];
    if (!first) {
      // специалист есть, а писем ещё нет — писать можно; нет специалиста — некому
      setThreadId(list.lead ? "" : null);
      return;
    }
    setThreadId(first.id);
    setWithName(first.withName);
    const t = await api.thread(first.id).catch(() => null);
    stickToEnd.current = true;
    setItems(t?.items ?? []);
    setBefore(t?.hasMore ? t.nextBefore : null);
    markShown(first.id, t?.items ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (threadId === undefined) return <Loader />;

  const time = (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const dayLabel = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    const label = d.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
    if (dayKey(iso) === today.toDateString()) return `${ut("mpt.hm.today")}, ${d.toLocaleDateString(locale, { day: "numeric", month: "long" })}`;
    if (dayKey(iso) === yesterday.toDateString()) return `${ut("mpt.ms.yesterday")}, ${d.toLocaleDateString(locale, { day: "numeric", month: "long" })}`;
    return label[0]!.toUpperCase() + label.slice(1);
  };

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      await api.sendMessage(body);
      setText("");
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : ut("common.error"), { icon: "circle-alert" });
    } finally {
      setBusy(false);
    }
  };

  const name = withName ? personName(withName) : null;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.ground }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
      {name ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingTop: 2,
            paddingBottom: 12,
            paddingLeft: 20,
            paddingRight: 16,
            backgroundColor: c.band,
            borderBottomWidth: 1,
            borderBottomColor: c.bcardline,
          }}
        >
          <Avatar name={withName ?? ""} size={44} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T v="section" accessibilityRole="header" numberOfLines={1}>
              {name}
            </T>
            <T v="sub" tone="text2">
              {ut("home.myLead")}
            </T>
          </View>
          <Btn icon="calendar-plus" kind="outline" accessibilityLabel={ut("mpt.bk.title")} onPress={() => router.push("/booking")} />
        </View>
      ) : (
        <View style={{ height: 1, backgroundColor: c.bcardline }} />
      )}

      {threadId === null ? (
        <View style={{ padding: 16, gap: 12 }}>
          <Callout kind="n" icon="message-square-text" text={ut("ms.noLead")} />
          <Btn title={ut("home.bookNow")} kind="primary" icon="calendar-plus" onPress={() => router.push("/booking")} />
        </View>
      ) : (
        <ScrollView
          ref={scroll}
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1, justifyContent: "flex-end", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 10 }}
          onContentSizeChange={() => {
            if (stickToEnd.current) scroll.current?.scrollToEnd({ animated: false });
          }}
        >
          {before ? (
            <View style={{ alignItems: "center" }}>
              <Btn
                title={ut("ui.loadMore")}
                kind="ghost"
                icon="history"
                disabled={busy}
                onPress={async () => {
                  if (!threadId) return;
                  const page = await api.thread(threadId, before).catch(() => null);
                  if (!page) return;
                  stickToEnd.current = false;
                  setItems((prev) => [...page.items, ...prev]);
                  setBefore(page.hasMore ? page.nextBefore : null);
                  markShown(threadId, page.items);
                }}
              />
            </View>
          ) : null}
          {items.length === 0 ? (
            <T v="note" center style={{ paddingVertical: 24 }}>
              {ut("ms.empty")}
            </T>
          ) : (
            items.map((m, i) => (
              <View key={m.id} style={{ gap: 10 }}>
                {i === 0 || dayKey(items[i - 1]!.sentAt) !== dayKey(m.sentAt) ? (
                  <View style={{ alignItems: "center", paddingTop: 6, paddingBottom: 2 }}>
                    <View style={{ height: 28, justifyContent: "center", paddingHorizontal: 12, borderRadius: 14, backgroundColor: c.sunk }}>
                      <T v="caption" size={13} weight={700} tone="text2" scale={false}>
                        {dayLabel(m.sentAt)}
                      </T>
                    </View>
                  </View>
                ) : null}
                <View
                  style={{
                    alignSelf: m.mine ? "flex-end" : "flex-start",
                    maxWidth: "82%",
                    paddingTop: 11,
                    paddingHorizontal: 14,
                    paddingBottom: 9,
                    borderRadius: 18,
                    borderBottomLeftRadius: m.mine ? 18 : 6,
                    borderBottomRightRadius: m.mine ? 6 : 18,
                    backgroundColor: m.mine ? c.vtint : c.panel,
                    borderWidth: m.mine ? 0 : 1,
                    borderColor: c.border,
                  }}
                >
                  <T v="body" style={{ lineHeight: fs(23) }}>
                    {m.text}
                  </T>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: m.mine ? "flex-end" : "flex-start", gap: 8, marginTop: 4 }}>
                    <T v="caption" size={13} weight={600} tone="muted" num>
                      {m.mine ? time(m.sentAt) : `${name ? name.split(" ")[0] : ""}${name ? ", " : ""}${time(m.sentAt)}`}
                    </T>
                    {/*
                      «Прочитано» видно только на своих письмах: по нему
                      человек понимает, что письмо не потерялось, пока ответ
                      готовится.
                    */}
                    {m.mine ? (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                        <Icon name={m.readAt ? "check-check" : "check"} size={15} color={c.vink} />
                        <T v="caption" size={13} weight={600} color={c.vink}>
                          {m.readAt ? ut("ms.read") : ut("ms.sent")}
                        </T>
                      </View>
                    ) : null}
                  </View>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      )}

      {threadId !== null ? (
        <View style={{ paddingTop: 10, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: c.panel, borderTopWidth: 1, borderTopColor: c.divider, gap: 10 }}>
          {/*
            Границы — над полем ввода, а не под перепиской. Прочитать их
            человек должен до того, как напишет, а не после.
          */}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ marginTop: 2 }}>
              <Icon name="clock-3" size={17} color={c.muted} />
            </View>
            <T v="sub" tone="text2" style={{ flex: 1 }}>
              {`${ut("mpt.ms.bounds")} `}
              <T v="sub" weight={800} color={c.vink} onPress={() => router.push("/safety")} accessibilityRole="link">
                {ut("mpt.ms.plan")}
              </T>
              {` ${ut("mpt.ms.or")} `}
              <T
                v="sub"
                weight={800}
                color={c.vink}
                onPress={() => void Linking.openURL(`tel:${ut("home.hotlineNumber")}`)}
                accessibilityRole="link"
              >
                {ut("home.hotlineNumber")}
              </T>
              .
            </T>
          </View>
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
            <View
              style={{
                flex: 1,
                minHeight: 44,
                justifyContent: "center",
                paddingHorizontal: 16,
                borderRadius: 22,
                backgroundColor: focus ? c.panel : c.sunk,
                borderWidth: focus ? 2 : 1,
                borderColor: focus ? (dark ? c.vink : c.v) : c.border,
              }}
            >
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder={ut("ms.placeholder")}
                placeholderTextColor={c.muted}
                accessibilityLabel={ut("ms.placeholder")}
                multiline
                numberOfLines={1}
                onFocus={() => setFocus(true)}
                onBlur={() => setFocus(false)}
                style={{ maxHeight: 120, paddingVertical: 10, color: c.text, fontSize: fs(16), lineHeight: fs(22), ...font(500) }}
              />
            </View>
            <Pressable
              onPress={() => void send()}
              disabled={busy || !text.trim()}
              accessibilityRole="button"
              accessibilityLabel={ut("ms.send")}
              accessibilityState={{ disabled: busy || !text.trim() }}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 22,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? c.vhov : c.v,
                opacity: busy || !text.trim() ? 0.48 : 1,
              })}
            >
              <Icon name="arrow-up" size={20} color={c.onfill} />
            </Pressable>
          </View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
