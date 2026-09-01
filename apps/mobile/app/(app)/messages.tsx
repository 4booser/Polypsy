import { useCallback, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api } from "@/api/client";
import { Body, Button, Card, Field, Loader, Title } from "@/components/ui";
import { useLang } from "@/lang";
import { spacing, type, useColors } from "@/theme";

type Message = { id: string; mine: boolean; text: string; sentAt: string; readAt: string | null };

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
  const { ut } = useLang();
  const [threadId, setThreadId] = useState<string | null | undefined>(undefined);
  const [items, setItems] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const list = await api.threads().catch(() => ({ items: [], lead: null }));
    const first = list.items[0];
    if (!first) {
      setThreadId(null);
      return;
    }
    setThreadId(first.id);
    const t = await api.thread(first.id).catch(() => null);
    setItems(t?.items ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (threadId === undefined) return <Loader />;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.md }}>
        <Title>{ut("ms.title")}</Title>

        {/*
          Границы — над перепиской, а не под ней. Прочитать их человек должен
          до того, как напишет, а не после.
        */}
        <Card>
          <Body muted>{ut("ms.boundaries")}</Body>
        </Card>

        {threadId === null ? (
          <Card>
            <Body muted>{ut("ms.noLead")}</Body>
          </Card>
        ) : (
          <>
            {items.length === 0 ? (
              <Card>
                <Body muted>{ut("ms.empty")}</Body>
              </Card>
            ) : (
              items.map((m) => (
                <View
                  key={m.id}
                  style={{
                    alignSelf: m.mine ? "flex-end" : "flex-start",
                    maxWidth: "88%",
                    backgroundColor: m.mine ? c.card : c.bg,
                    borderColor: c.border,
                    borderWidth: 1,
                    borderRadius: 12,
                    padding: spacing.md,
                  }}
                >
                  <Body>{m.text}</Body>
                  <Text style={{ ...type.caption, color: c.muted, marginTop: 4 }}>
                    {new Date(m.sentAt).toLocaleDateString()}{" "}
                    {new Date(m.sentAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {/*
                      «Прочитано» видно только на своих письмах: по нему
                      человек понимает, что письмо не потерялось, пока ответ
                      готовится.
                    */}
                    {m.mine ? ` · ${m.readAt ? ut("ms.read") : ut("ms.sent")}` : ""}
                  </Text>
                </View>
              ))
            )}

            <Field
              label={ut("ms.write")}
              placeholder={ut("ms.placeholder")}
              value={text}
              onChangeText={setText}
              multiline
            />
            <Button
              title={ut("ms.send")}
              disabled={busy || !text.trim()}
              onPress={async () => {
                setBusy(true);
                try {
                  await api.sendMessage(text.trim());
                  setText("");
                  await load();
                } finally {
                  setBusy(false);
                }
              }}
            />
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
