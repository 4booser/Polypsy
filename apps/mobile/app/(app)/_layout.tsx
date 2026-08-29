import { View } from "react-native";
import { Redirect, Tabs } from "expo-router";
import { useAuth } from "@/auth/AuthContext";
import { Loader } from "@/components/ui";
import { OfflineBar } from "@/components/OfflineBar";
import { useColors } from "@/theme";
import { useLang } from "@/lang";

/**
 * Вкладки: прохождение, обход и аналитика (для сотрудников), план безопасности
 * и аккаунт.
 * Конструктор методик и управление доступами живут в веб-консоли — на телефоне
 * такую работу делать неудобно, а экран нужен целиком под прохождение.
 */
export default function AppLayout() {
  const { ut } = useLang();
  const { user, loading, isAdmin } = useAuth();
  const c = useColors();

  if (loading) return <Loader />;
  if (!user) return <Redirect href="/login" />;

  return (
    // полоса очереди над вкладками: она должна быть видна на любом экране,
    // а не только там, куда человек догадается зайти
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <OfflineBar />
      <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: c.card },
        headerTitleStyle: { color: c.text },
        tabBarStyle: { backgroundColor: c.card, borderTopColor: c.border },
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.muted,
        sceneStyle: { backgroundColor: c.bg },
      }}
    >
      <Tabs.Screen name="surveys" options={{ title: ut("tab.surveys") }} />
      {/*
        Обход — вкладка специалиста: планшет в палате вместо ноутбука.
        Пациенту она не нужна и не показывается.
      */}
      <Tabs.Screen
        name="rounds"
        options={{ title: ut("rounds.title"), href: isAdmin ? "/rounds" : null }}
      />
      <Tabs.Screen
        name="insights"
        options={{ title: ut("tab.analytics"), headerShown: false, href: isAdmin ? "/insights" : null }}
      />
      {/* план безопасности — отдельной вкладкой: в кризис его ищут, а не вспоминают, где он */}
      <Tabs.Screen name="safety" options={{ title: ut("tab.safety") }} />
      <Tabs.Screen name="profile" options={{ title: ut("tab.account") }} />
      {/* очередь открывается из полосы состояния, отдельной вкладки ей не нужно */}
      <Tabs.Screen name="queue" options={{ href: null, title: ut("tab.queue") }} />
      </Tabs>
    </View>
  );
}
