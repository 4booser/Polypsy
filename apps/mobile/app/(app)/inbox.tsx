import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { api } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { Loader } from "@/components/ui";
import { useLang } from "@/lang";
import { useColors } from "@/theme";
import { Count } from "@/ui/Pill";
import { T } from "@/ui/Text";
import { dayKey, dm, hm, shortName } from "@/staff/model";
import { Avatar, Card, Line, Loading, PillRow, SearchField, StaffTop, StateBlock } from "@/staff/ui";

type Thread = { id: string; withName: string; lastMessageAt: string; unread: number; patientId?: string };

/**
 * Листування — скринька специалиста: переписки с пациентами, которых он
 * ведёт, свежие сверху, непрочитанные отмечены.
 *
 * Пациент свою переписку видит на отдельном экране ((app)/messages.tsx) —
 * у него она одна, с его специалистом. Здесь их много, и разговор
 * открывается поверх вкладок (inbox/[patientId].tsx).
 */
export default function InboxTab() {
  const { loading, isAdmin } = useAuth();
  if (loading) return <Loader />;
  // пациенту скринька не нужна — у него один собеседник
  if (!isAdmin) return <Redirect href="/(app)/messages" />;
  return <Inbox />;
}

function Inbox() {
  const { ut } = useLang();
  const c = useColors();
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"all" | "unread">("all");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setThreads((await api.threads()).items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("common.error"));
      setThreads((t) => t ?? []);
    } finally {
      setBusy(false);
    }
  }, [ut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000));
  const when = (iso: string) => {
    const d = dayKey(new Date(iso));
    return d === today ? hm(iso) : d === yesterday ? ut("mst.yesterday") : dm(iso);
  };
  const needle = query.trim().toLowerCase();
  const all = threads ?? [];
  const unread = all.filter((t) => t.unread > 0);
  const shown = (view === "unread" ? unread : all).filter((t) => !needle || t.withName.toLowerCase().includes(needle));

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <StaffTop title={ut("ms.title")} lead={ut("mst.inboxLead")}>
        <SearchField value={query} onChange={setQuery} placeholder={ut("mst.searchInbox")} />
      </StaffTop>
      {threads === null ? (
        <Loading />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void load()} tintColor={c.vink} />}>
          <PillRow
            value={view}
            onChange={setView}
            items={[
              { key: "all", label: ut("mal.all"), count: all.length },
              { key: "unread", label: ut("work.filterMessages"), count: unread.length },
            ]}
          />
          {/* границы переписки — те же, что видит пациент над полем ввода */}
          <Line icon="clock">{ut("mst.inboxBounds")}</Line>
          {error ? <StateBlock icon="circle-alert" title={error} action={{ label: ut("common.retry"), onPress: () => void load() }} /> : null}
          {shown.length ? (
            <Card style={{ marginTop: 12 }}>
              {shown.map((t, i) => (
                <Pressable
                  key={t.id}
                  onPress={() => t.patientId && router.push({ pathname: "/inbox/[patientId]", params: { patientId: t.patientId } })}
                  accessibilityRole="button"
                  accessibilityLabel={`${t.withName}. ${t.unread ? ut("mst.unreadN").replace("{n}", String(t.unread)) : ut("mst.allRead")}`}
                >
                  {({ pressed }) => (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 68, paddingVertical: 12, paddingLeft: 16, paddingRight: 14, borderTopWidth: i ? 1 : 0, borderTopColor: c.divider, backgroundColor: pressed ? c.panel2 : "transparent" }}>
                      {t.unread ? <View style={{ position: "absolute", left: 5, top: 32, width: 7, height: 7, borderRadius: 4, backgroundColor: c.vink }} /> : null}
                      <Avatar name={t.withName} size={44} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                          <T v="headline" numberOfLines={1} style={{ flex: 1 }}>
                            {shortName(t.withName)}
                          </T>
                          <T v="sub" size={13.5} weight={700} color={t.unread ? c.vink : c.muted} num>
                            {when(t.lastMessageAt)}
                          </T>
                        </View>
                        <T v="sub" weight={t.unread ? 700 : 600} color={t.unread ? c.text : c.muted}>
                          {t.unread ? ut("mst.unreadN").replace("{n}", String(t.unread)) : ut("mst.allRead")}
                        </T>
                      </View>
                      {t.unread ? <Count n={t.unread} kind="v" /> : null}
                    </View>
                  )}
                </Pressable>
              ))}
            </Card>
          ) : !error ? (
            <StateBlock icon="message-square-text" title={view === "unread" ? ut("mst.allReadTitle") : ut("mst.noThreads")} text={ut("mst.noThreadsHint")} />
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
