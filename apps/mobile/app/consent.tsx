import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api } from "@/api/client";
import { Body, Button, ErrorText, Loader, Title } from "@/components/ui";
import { useLang } from "@/lang";
import { spacing, useColors } from "@/theme";

/**
 * Экран информированного согласия.
 *
 * Показывается после входа, пока актуальная версия текста не принята.
 * Новая редакция текста показывает экран заново — принятие всегда привязано
 * к конкретной версии, которую человек читал.
 */
export default function ConsentScreen() {
  const c = useColors();
  const router = useRouter();
  const { ut } = useLang();
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .consentStatus()
      .then((s) => {
        if (!s.required || s.accepted) {
          router.replace("/(app)/surveys");
          return;
        }
        setText(s.text);
      })
      .catch((e) => {
        // без сети экран не должен запирать уже работавшего человека:
        // согласие проверится при следующем онлайне
        if ((e as { status?: number }).status === 0) {
          router.replace("/(app)/surveys");
          return;
        }
        setError(ut("common.error"));
      })
      .finally(() => setLoading(false));
  }, [router, ut]);

  if (loading) return <Loader />;

  return (
    <ScrollView
      style={{ backgroundColor: c.bg }}
      contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg, flexGrow: 1, justifyContent: "center" }}
    >
      <Title>{ut("consent.title")}</Title>
      <View
        style={{
          backgroundColor: c.card,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: c.border,
          padding: spacing.lg,
        }}
      >
        <Text style={{ color: c.text, fontSize: 15, lineHeight: 23 }}>{text}</Text>
      </View>
      <Body muted>{ut("consent.hint")}</Body>
      <ErrorText>{error}</ErrorText>
      <Button
        title={ut("consent.accept")}
        loading={busy}
        onPress={async () => {
          setBusy(true);
          setError(null);
          try {
            await api.acceptConsent();
            router.replace("/(app)/surveys");
          } catch (e) {
            setError(e instanceof Error ? e.message : ut("common.error"));
          } finally {
            setBusy(false);
          }
        }}
      />
    </ScrollView>
  );
}
