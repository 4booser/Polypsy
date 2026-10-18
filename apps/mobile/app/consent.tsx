import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { api } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { isPasswordGate } from "@/auth/passwordGate";
import { ErrorText, Loader } from "@/components/ui";
import { CrisisStrip } from "@/components/patient/Crisis";
import { Hero, HeroMeta } from "@/components/patient/Hero";
import { actionsOf, viewOfLoadError, viewOfStatus, type ConsentAction, type ConsentView } from "@/consent/model";
import { useLang } from "@/lang";
import { radius, useColors, useShadows } from "@/theme";
import { ActionBar, Btn } from "@/ui/Button";
import { Icon, type IconName } from "@/ui/Icon";
import { HelpPill, NavBar } from "@/ui/NavBar";
import { Callout, Panel } from "@/ui/Panel";
import { Pill } from "@/ui/Pill";
import { T } from "@/ui/Text";

/** Длинный текст согласия сначала свёрнут: до кнопок человек добирается, но целиком прочесть может */
const FOLD = 900;

/**
 * Экран информированного согласия.
 *
 * Показывается после входа, пока актуальная версия текста не принята.
 * Новая редакция текста показывает экран заново — принятие всегда привязано
 * к конкретной версии, которую человек читал.
 *
 * Состояния и выходы из каждого — в src/consent/model.ts: отказ — своё
 * состояние с объяснением, а не мгновенный выход; без текста принимать
 * нечего. Текст пишет учреждение — экран показывает его как есть, без
 * своего пересказа: краткое изложение рядом с юридическим текстом однажды
 * разошлось бы с ним.
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
  const [version, setVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

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
          setVersion(s.version);
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
        // сдачи, вставшие на новой редакции (#201), уходят сразу — те же записи, тот же clientRequestId
        void api.flushQueue().catch(() => {});
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
              setVersion(fresh.version);
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

  const BUTTON: Record<ConsentAction, { title: string; kind: "primary" | "secondary" | "ghost"; icon?: IconName }> = {
    // без значка: «Не погоджуюся» и «Погоджуюся» на 17 в ряд на 390 иначе не помещаются целиком
    accept: { title: ut("consent.accept"), kind: "primary" },
    decline: { title: ut("consent.decline"), kind: "secondary" },
    retry: { title: ut("common.retry"), kind: "primary", icon: "refresh-cw" },
    signOut: { title: ut("consent.signOut"), kind: view.kind === "declined" ? "ghost" : "secondary", icon: "log-out" },
    reconsider: { title: ut("consent.reconsider"), kind: "primary", icon: "file-text" },
  };
  const actions = actionsOf(view);
  const button = (action: ConsentAction, inRow?: boolean) => (
    <Btn
      key={action}
      title={BUTTON[action].title}
      kind={BUTTON[action].kind}
      icon={BUTTON[action].icon}
      size="l"
      full={!inRow}
      // в ряду «Не погоджуюся» длиннее «Погоджуюся» — ей и места чуть больше
      flex={inRow ? (BUTTON[action].kind === "primary" ? 1 : 1.2) : undefined}
      loading={busy && action === "accept"}
      disabled={busy}
      onPress={() => void run[action]()}
    />
  );

  if (view.kind === "declined") {
    // «Повернутися до тексту» — главным, выход — тихим: передумать легче, чем уйти
    const order: ConsentAction[] = ["reconsider", "signOut"];
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <NavBar flush right={<HelpPill />} />
        <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
          <View style={{ alignItems: "center", paddingTop: 28, paddingHorizontal: 28, paddingBottom: 4 }}>
            <View style={{ width: 88, height: 88, borderRadius: 28, alignItems: "center", justifyContent: "center", backgroundColor: c.sunk, borderWidth: 1, borderColor: c.border }}>
              <Icon name="file-x-2" size={40} color={c.text2} />
            </View>
            <T v="largeTitle" size={28} center accessibilityRole="header" style={{ marginTop: 22 }}>
              {ut("consent.declinedTitle")}
            </T>
            <T v="lead" center style={{ marginTop: 8 }}>
              {ut("mpt.cs.declinedLead")}
            </T>
          </View>
          <Panel title={ut("mpt.cs.locked")} icon="lock" tone="n" pad={false} style={{ marginTop: 16, marginHorizontal: 16 }}>
            <View style={{ paddingHorizontal: 16, paddingBottom: 6 }}>
              {(
                [
                  ["clipboard-check", ut("mpt.cs.noSurveys")],
                  ["heart-pulse", ut("mpt.cs.noResults")],
                  ["calendar-plus", ut("mpt.cs.noBooking")],
                  ["message-square-text", ut("mpt.cs.noMessages")],
                ] as [IconName, string][]
              ).map(([icon, label], i) => (
                <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, borderTopWidth: i ? 1 : 0, borderTopColor: c.divider }}>
                  <Icon name={icon} size={20} color={c.muted} />
                  <T v="body" weight={600} tone="text2" style={{ flex: 1 }}>
                    {label}
                  </T>
                  <Icon name="lock" size={16} color={c.muted} />
                </View>
              ))}
            </View>
          </Panel>
          <T v="note" weight={600} tone="text2" style={{ marginTop: 14, marginHorizontal: 20 }}>
            {ut("consent.declinedNext")}
          </T>
          <CrisisStrip note={ut("mpt.crisisNoConsent")} />
        </ScrollView>
        <ActionBar>
          <View style={{ flex: 1, gap: 8 }}>{order.filter((a) => actions.includes(a)).map((a) => button(a))}</View>
        </ActionBar>
      </View>
    );
  }

  const long = (view.kind === "read" ? view.text : "").length > FOLD;
  const shown = view.kind === "read" ? (long && !expanded ? `${view.text.slice(0, FOLD).replace(/\s+\S*$/, "")}…` : view.text) : "";

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <NavBar flush right={<HelpPill />} />
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <Hero title={ut("consent.title")} lead={ut("mpt.cs.lead")}>
          {version !== null && view.kind === "read" ? (
            <HeroMeta>
              <Pill kind="n" icon="file-text" label={ut("mpt.cs.version").replace("{v}", String(version))} />
            </HeroMeta>
          ) : null}
        </Hero>

        {view.kind === "read" ? (
          <ConsentText text={shown} long={long} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
        ) : (
          <View style={{ marginTop: 16, marginHorizontal: 16 }}>
            <Callout kind="warn" icon="circle-alert" text={ut("consent.loadFailed")} />
          </View>
        )}

        {error ? (
          <View style={{ marginTop: 16, marginHorizontal: 16 }}>
            <ErrorText>{error}</ErrorText>
          </View>
        ) : null}
      </ScrollView>
      <ActionBar>
        <View style={{ flex: 1, gap: 10 }}>
          {/* последствие отказа — до выбора, а не после */}
          {view.kind === "read" ? (
            <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 2 }}>
              <View style={{ marginTop: 2 }}>
                <Icon name="info" size={17} color={c.muted} />
              </View>
              <T v="sub" tone="text2" style={{ flex: 1 }}>
                {ut("consent.hint")}
              </T>
            </View>
          ) : null}
          {/* главное действие — справа, под большим пальцем */}
          <View style={{ flexDirection: "row", gap: 10 }}>
            {[...actions]
              .sort((a, b) => Number(BUTTON[a].kind === "primary") - Number(BUTTON[b].kind === "primary"))
              .map((a) => button(a, true))}
          </View>
        </View>
      </ActionBar>
    </View>
  );
}

/** Полный текст согласия в панели; длинный — с «Читати далі» */
function ConsentText({ text, long, expanded, onToggle }: { text: string; long: boolean; expanded: boolean; onToggle: () => void }) {
  const c = useColors();
  const sh = useShadows();
  const { ut } = useLang();
  return (
    <View style={{ marginTop: 16, marginHorizontal: 16, borderRadius: radius.panel, borderWidth: 1, borderColor: c.border, backgroundColor: c.panel, boxShadow: sh.panel, overflow: "hidden" }}>
      <Panel title={ut("mpt.cs.fullText")} icon="file-text" style={{ borderWidth: 0, boxShadow: undefined }}>
        <T v="body" style={{ lineHeight: 24 }}>
          {text}
        </T>
      </Panel>
      {long ? (
        <Pressable
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            height: 48,
            borderTopWidth: 1,
            borderTopColor: c.divider,
            backgroundColor: pressed ? c.panel2 : c.panel,
          })}
        >
          <T v="body" weight={700} color={c.vink}>
            {expanded ? ut("mpt.cs.less") : ut("mpt.cs.more")}
          </T>
          <Icon name={expanded ? "chevron-up" : "chevron-down"} size={18} color={c.vink} />
        </Pressable>
      ) : null}
    </View>
  );
}
