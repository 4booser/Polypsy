import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { isPasswordGate } from "@/auth/passwordGate";
import { Body, Button, ErrorText, Loader, Title } from "@/components/ui";
import { actionsOf, viewOfLoadError, viewOfStatus, type ConsentAction, type ConsentView } from "@/consent/model";
import { useLang } from "@/lang";
import { spacing, useColors } from "@/theme";

/**
 * Экран информированного согласия.
 *
 * Показывается после входа, пока актуальная версия текста не принята.
 * Новая редакция текста показывает экран заново — принятие всегда привязано
 * к конкретной версии, которую человек читал.
 *
 * Состояния и выходы из каждого — в src/consent/model.ts: отказ — своё
 * состояние с объяснением, а не мгновенный выход; без текста принимать
 * нечего.
 */
export default function ConsentScreen() {
  const c = useColors();
  const router = useRouter();
  const { ut } = useLang();
  const { logout } = useAuth();
  const [view, setView] = useState<ConsentView | null>(null);
  /** Текст держится и после отказа: «повернутися до тексту» возвращает его, а не грузит заново */
  const [text, setText] = useState<string | null>(null);
  /** Редакция на экране: принимается именно она — сервер сверит с действующей (участок submit) */
  const [textId, setTextId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setView(null);
    setError(null);
    api
      .consentStatus()
      .then((s) => {
        const next = viewOfStatus(s);
        if (next.kind === "read") {
          setText(next.text);
          setTextId(s.textId ?? null);
        }
        setView(next);
      })
      .catch((e) => {
        /*
         * «Сначала смените пароль» — не «текст не загрузился»: корневая
         * раскладка уже уводит на смену пароля (auth/passwordGate.ts), и
         * показывать тем временем «не вдалося отримати текст» незачем.
         */
        if (isPasswordGate(e)) return;
        setView(viewOfLoadError((e as { status?: number }).status));
      });
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (view?.kind === "pass") router.replace("/(app)/home");
  }, [view, router]);

  if (!view || view.kind === "pass") return <Loader />;

  const run: Record<ConsentAction, () => Promise<void> | void> = {
    accept: async () => {
      setBusy(true);
      setError(null);
      try {
        await api.acceptConsent(textId);
        router.replace("/(app)/home");
      } catch (e) {
        setError(e instanceof Error ? e.message : ut("common.error"));
        // текст обновился, пока человек читал (409): показываем новую редакцию — принимать её
        if ((e as { status?: number }).status === 409) {
          const fresh = await api.consentStatus().catch(() => null);
          if (fresh) {
            const next = viewOfStatus(fresh);
            if (next.kind === "read") {
              setText(next.text);
              setTextId(fresh.textId ?? null);
            }
            setView(next);
          }
        }
      } finally {
        setBusy(false);
      }
    },
    /*
     * Отказ записывается на сервере (с версией текста — routes/consents.ts)
     * и сразу показывает, что из него следует. Ответа сервера экран не
     * ждёт: не дошёл отказ — он всё равно в силе (без принятия экран дальше
     * не пропустит), а решение человека не должно зависеть от связи и
     * тем более висеть на медленной.
     */
    decline: () => {
      setError(null);
      void api.declineConsent().catch(() => {});
      setView({ kind: "declined" });
    },
    retry: load,
    signOut: async () => {
      setBusy(true);
      await logout();
      router.replace("/login");
    },
    reconsider: () => {
      setError(null);
      setView(text ? { kind: "read", text } : { kind: "failed" });
    },
  };

  const BUTTON: Record<ConsentAction, { title: string; variant?: "secondary" }> = {
    accept: { title: ut("consent.accept") },
    decline: { title: ut("consent.decline"), variant: "secondary" },
    retry: { title: ut("common.retry") },
    signOut: { title: ut("consent.signOut"), variant: "secondary" },
    reconsider: { title: ut("consent.reconsider"), variant: "secondary" },
  };

  return (
    <ScrollView
      style={{ backgroundColor: c.bg }}
      contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg, flexGrow: 1, justifyContent: "center" }}
    >
      {view.kind === "read" ? (
        <>
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
            <Text style={{ color: c.text, fontSize: 15, lineHeight: 23 }}>{view.text}</Text>
          </View>
          {/* последствие отказа — до выбора, а не после */}
          <Body muted>{ut("consent.hint")}</Body>
        </>
      ) : null}

      {view.kind === "failed" ? (
        <>
          <Title>{ut("consent.title")}</Title>
          <Body muted>{ut("consent.loadFailed")}</Body>
        </>
      ) : null}

      {view.kind === "declined" ? (
        <>
          <Title>{ut("consent.declinedTitle")}</Title>
          <Body>{ut("consent.declinedWhat")}</Body>
          <Body muted>{ut("consent.declinedNext")}</Body>
        </>
      ) : null}

      <ErrorText>{error}</ErrorText>

      {actionsOf(view).map((action) => (
        <Button
          key={action}
          title={BUTTON[action].title}
          variant={BUTTON[action].variant}
          loading={busy && action === "accept"}
          disabled={busy}
          onPress={() => void run[action]()}
        />
      ))}
    </ScrollView>
  );
}
