import { View } from "react-native";
import { Redirect, Tabs } from "expo-router";
import { useAuth } from "@/auth/AuthContext";
import { Loader } from "@/components/ui";
import { OfflineBar } from "@/components/OfflineBar";
import { useColors } from "@/theme";

/**
 * Три вкладки: прохождение, аналитика (для сотрудников) и аккаунт.
 * Конструктор методик и управление доступами живут в веб-консоли — на телефоне
 * такую работу делать неудобно, а экран нужен целиком под прохождение.
 */
export default function AppLayout() {
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
      <Tabs.Screen name="surveys" options={{ title: "Опросы" }} />
      <Tabs.Screen
        name="insights"
        options={{ title: "Аналитика", headerShown: false, href: isAdmin ? "/insights" : null }}
      />
      <Tabs.Screen name="profile" options={{ title: "Аккаунт" }} />
      </Tabs>
    </View>
  );
}
