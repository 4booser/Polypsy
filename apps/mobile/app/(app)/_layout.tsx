import { Redirect, Tabs, useSegments } from "expo-router";
import { useAuth } from "@/auth/AuthContext";
import { Loader } from "@/components/ui";
import { useColors } from "@/theme";
import { useLang } from "@/lang";
import { useStaffBadges } from "@/staff/badges";
import { TabBar } from "@/ui/TabBar";
import { TabHeader } from "@/ui/headers";

/**
 * Вкладки: у пациента — день, запись, прохождение, здоровье и профиль; у
 * сотрудника — обход, сигналы, пациенты, аналитика и листування.
 * Конструктор методик и управление доступами живут в веб-консоли — на телефоне
 * такую работу делать неудобно, а экран нужен целиком под прохождение.
 */
export default function AppLayout() {
  const { ut } = useLang();
  const { user, loading, isAdmin } = useAuth();
  const c = useColors();
  const segments = useSegments();
  // счётчики вкладок сотрудника: люди на разбор сигнала и непрочитанные письма (staff/badges.ts)
  const badges = useStaffBadges(isAdmin);

  if (loading) return <Loader />;
  if (!user) return <Redirect href="/login" />;
  // с временным паролем сервер вкладкам ничего не отдаст — сначала смена (auth/passwordGate.ts)
  if (user.mustChangePassword) return <Redirect href="/password" />;
  // вход ведёт на «Головну» пациента; у сотрудника своя первая вкладка — обход
  if (isAdmin && (segments as string[])[1] === "home") return <Redirect href="/(app)/rounds" />;

  /*
   * Вкладки сотрудника — пять из набора: Обхід, Сигнали, Пацієнти,
   * Аналітика, Листування. Вкладки пациента у него скрыты, но остаются
   * экранами: «Заповнити за пацієнта» ведёт в «Опитування», кружок
   * учётной записи в шапке — в профиль, полоса «нет связи» — в очередь.
   * У пациента — наоборот: его пять вкладок как были.
   */
  const patientOnly = isAdmin ? ({ href: null } as const) : null;
  const staffOnly = (href: "/rounds" | "/alerts" | "/patients" | "/insights" | "/inbox") => ({ href: isAdmin ? href : null });

  return (
    <Tabs
      /*
       * «Назад» со скрытого экрана (профиль, «Опитування») у сотрудника —
       * туда, откуда пришёл, а не на первую вкладку: первая у него скрыта.
       */
      backBehavior={isAdmin ? "history" : undefined}
      /*
       * Шапка и панель вкладок «Виразной» (src/ui): крупный заголовок на
       * полосе, «Допомога» справа у пациента — помощь видна с любой вкладки.
       * Полоса очереди («нет связи», «не принято») — в шапке, под заголовком:
       * она видна на любом экране, а не только там, куда человек догадается
       * зайти.
       */
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{
        header: (props) => <TabHeader {...props} help={!isAdmin} />,
        sceneStyle: { backgroundColor: c.ground },
      }}
    >
      {/*
        Порядок вкладок — порядок дня пациента: сначала «что у меня сегодня»,
        потом «записаться», потом «что пройти». «Здоровье» и «Профиль» —
        то, куда заходят в спокойную минуту, и они последние.
      */}
      <Tabs.Screen name="home" options={{ title: ut("tab.home"), ...patientOnly }} />
      <Tabs.Screen name="booking" options={{ title: ut("tab.booking"), ...patientOnly }} />
      <Tabs.Screen name="surveys" options={{ title: ut("tab.surveys"), ...patientOnly }} />
      {/*
        Вкладки специалиста. Шапку каждая рисует сама (staff/ui.tsx, StaffTop):
        под крупным заголовком у них поиск, фильтры и переключатели.
        «Аналітика» — теперь настоящая вкладка: раздел /analytics кладётся
        поверх вкладок только вложенными экранами (методика, пациент), и
        «назад» с них возвращает на ту же вкладку.
      */}
      <Tabs.Screen name="rounds" options={{ title: ut("rounds.title"), headerShown: false, ...staffOnly("/rounds") }} />
      <Tabs.Screen
        name="alerts"
        options={{
          title: ut("mst.tabAlerts"),
          headerShown: false,
          tabBarBadge: badges.alerts || undefined,
          // красный — риск для человека: люди, которые ждут разбора
          tabBarBadgeStyle: { backgroundColor: c.risk },
          ...staffOnly("/alerts"),
        }}
      />
      <Tabs.Screen name="patients" options={{ title: ut("mnav.patients"), headerShown: false, ...staffOnly("/patients") }} />
      <Tabs.Screen name="insights" options={{ title: ut("tab.analytics"), headerShown: false, ...staffOnly("/insights") }} />
      <Tabs.Screen
        name="inbox"
        options={{ title: ut("ms.title"), headerShown: false, tabBarBadge: badges.inbox || undefined, ...staffOnly("/inbox") }}
      />
      <Tabs.Screen name="health" options={{ title: ut("tab.health"), ...patientOnly }} />
      {/*
        Переписка — экран, а не вкладка: шестая вкладка сделала бы нижнюю
        панель нечитаемой на узком телефоне. Ведёт сюда блок «связь и помощь»
        с главной, где человек её и ищет.
      */}
      <Tabs.Screen name="messages" options={{ href: null, title: ut("ms.title") }} />
      {/*
        План безопасности остаётся отдельным экраном, но не вкладкой: в
        кризис его ищут, а не вспоминают, где он, — и ведут туда две кнопки,
        с главной и со «Здоровья». Шестая вкладка ради него сделала бы
        нижнюю панель нечитаемой на узком телефоне.
      */}
      <Tabs.Screen name="safety" options={{ href: null, title: ut("tab.safety") }} />
      {/* в шапке — «Обліковий запис», на вкладке — короткое «Профіль»: пять подписей в ряд на узком телефоне */}
      <Tabs.Screen name="profile" options={{ title: ut("tab.account"), tabBarLabel: ut("mui.profile"), ...patientOnly }} />
      {/* очередь открывается из полосы состояния, отдельной вкладки ей не нужно */}
      <Tabs.Screen name="queue" options={{ href: null, title: ut("tab.queue") }} />
    </Tabs>
  );
}
