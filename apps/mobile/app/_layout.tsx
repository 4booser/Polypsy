import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import Constants from "expo-constants";
import { SplashScreen, Stack, usePathname, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "@/auth/AuthContext";
import { LangProvider, useLang } from "@/lang";
import { ThemeProvider, useColors, useIsDark } from "@/theme";
import { TextScaleProvider } from "@/textScale";
import { api } from "@/api/client";
import { AppLock } from "@/components/AppLock";
import { FONT_FILES } from "@/fontFiles";
import { setFontsLoaded } from "@/fonts";
import { StackHeader } from "@/ui/headers";
import { ToastProvider } from "@/ui/Toast";
import { useScreenTelemetry } from "@/telemetry/screens";
import { API_URL } from "@/config";
import { tokenStorage } from "@/storage";
import { createMobileTelemetry, type ErrorUtilsLike } from "@/telemetry";
import { dropLegacyCache } from "@/offline/cache";
import { ExitHeaderButton, useHardwareBackFallback } from "@/nav/useExit";

/*
 * Ошибки приложения — в «Помилки клієнта» техпанели (src/telemetry.ts).
 *
 * Заводится при загрузке модуля, а не в эффекте: падение при самой первой
 * отрисовке — тоже падение, и эффект до него не доживёт. Экран — адресом
 * expo-router, приведённым к шаблону; его RootLayout обновляет при каждом
 * переходе.
 */
let currentRoute = "/";
const telemetry = createMobileTelemetry({
  apiUrl: API_URL,
  release: Constants.expoConfig?.version,
  os: Platform.OS === "ios" ? "iOS" : Platform.OS === "android" ? "Android" : undefined,
  getToken: () => tokenStorage.get(),
  currentRoute: () => currentRoute,
});
telemetry.install((globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils);

/*
 * Заставка держится, пока грузится Manrope: иначе первый кадр рисовался бы
 * системным шрифтом и через мгновение «прыгал» в наш — у человека, который
 * открыл методику, текст под пальцем сдвигался бы. В вебе заставки нет —
 * там до загрузки пустая земля.
 */
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  /*
   * Шрифт не загрузился (файл повреждён, нет места) — приложение не встаёт
   * на пустом экране, а рисует системным шрифтом: прочесть методику важнее,
   * чем прочесть её нашим шрифтом (fonts.ts).
   */
  const [fontsReady, fontError] = useFonts(FONT_FILES);
  const fontsSettled = fontsReady || !!fontError;
  setFontsLoaded(fontsReady);
  useEffect(() => {
    if (fontsSettled) void SplashScreen.hideAsync();
  }, [fontsSettled]);

  const pathname = usePathname();
  useEffect(() => {
    currentRoute = pathname;
  }, [pathname]);

  /*
   * Синхронизация: при старте, по возвращению приложения на передний план и
   * раз в 45 секунд, пока очередь непуста. Отдельного NetInfo нет — неудачная
   * попытка дешёвая (первый же сетевой отказ останавливает прогон).
   */
  useEffect(() => {
    /*
     * Кэш под общими ключами от версии без владельца — чей он, не узнать, и
     * показывать его нельзя никому (offline/cache.ts, dropLegacyCache).
     * Стирается до первого прогона; очередь сдач он не трогает.
     */
    try {
      dropLegacyCache();
    } catch {
      /* не стёрлось — не прочитается всё равно: новые ключи под владельцем */
    }

    /*
     * Отметка устройства идёт вместе с прогоном очереди: оба нужны ровно
     * тогда, когда появилась сеть. Если сервер просит стереть локальные
     * данные — приложение стирает их и выходит из учётной записи.
     */
    const sync = () => {
      void api.deviceCheckin(null).catch(() => {});
      void api.flushQueue().catch(() => {});
      // отзыв сессий, из которых вышли без сети (auth/session.ts)
      void api.flushRevocations();
    };

    sync();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") sync();
    });
    const timer = setInterval(() => {
      if (api.pendingCount() > 0) void api.flushQueue().catch(() => {});
    }, 45_000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, []);

  if (!fontsSettled) return null;

  return (
    <SafeAreaProvider>
      <ThemeProvider>
      <LangProvider>
      <TextScaleProvider>
      <AuthProvider>
      <ToastProvider>
        <ThemedStatusBar />
        {/* замок оборачивает всё приложение: он про экран, а не про отдельный маршрут */}
        <AppLock>
          <RootStack />
        </AppLock>
      </ToastProvider>
      </AuthProvider>
      </TextScaleProvider>
      </LangProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

/**
 * Строка состояния — по теме приложения, а не системы: выбрана тёмная при
 * светлом телефоне — часы и батарея светлые на тёмной полосе, а не тёмные.
 */
function ThemedStatusBar() {
  return <StatusBar style={useIsDark() ? "light" : "dark"} />;
}

/**
 * «Сначала смените пароль» из любого запроса — на экран смены.
 *
 * Пароль могли сбросить в техпанели, пока приложение открыто: тогда первый же
 * запрос получает 403 password_change_required, и человек должен увидеть
 * смену пароля, а не череду отказов. Уже на экране смены — не уводим повторно:
 * фоновые запросы (очередь, отметка устройства) получают тот же отказ, и
 * каждый переход заново стирал бы набранное.
 */
function usePasswordGate(): void {
  const router = useRouter();
  const segments = useSegments();
  const current = useRef<readonly string[]>(segments);
  current.current = segments;
  useEffect(
    () =>
      api.onPasswordChangeRequired(() => {
        if (current.current[0] === "password") return;
        router.replace("/password");
      }),
    [router],
  );
}

/**
 * Очередь встала на новой редакции согласия — на экран согласия (#201).
 *
 * Сдача из очереди получила 403 «нужно согласие»: опубликовали новую
 * редакцию, пока ответы ждали сети. Запись цела (offline/queue.ts), и
 * уйдёт она после принятия — экран согласия сам досылает очередь. Уже на
 * согласии или на смене пароля — не уводим; посреди прохождения — тоже:
 * ответы человека на экране важнее, а прогон по таймеру повторит отказ, как
 * только он оттуда уйдёт.
 */
function useConsentGate(): void {
  const router = useRouter();
  const segments = useSegments();
  const current = useRef<readonly string[]>(segments);
  current.current = segments;
  useEffect(
    () =>
      api.onConsentRequired(() => {
        const here = current.current[0];
        if (here === "consent" || here === "password" || here === "survey") return;
        router.replace("/consent");
      }),
    [router],
  );
}

/**
 * Устройство стёрто по команде — на вход (#125).
 *
 * Пользователя снимает AuthContext, но прохождение и карта обхода лежат вне
 * вкладок, и сами на вход не уводят: открытое прохождение так и оставалось
 * на экране, с ответами и автосохранением.
 */
function useWipeSignOut(): void {
  const router = useRouter();
  useEffect(() => api.onWiped(() => router.replace("/login")), [router]);
}

function RootStack() {
  const { ut } = useLang();
  const c = useColors();
  // какие экраны открывают — шаблоном маршрута, без людей и адресов (src/telemetry)
  useScreenTelemetry();
  // кнопка «назад» на Android там, где стеку возвращаться некуда (src/nav/exits.ts)
  useHardwareBackFallback();
  usePasswordGate();
  useConsentGate();
  useWipeSignOut();
  /*
   * Экран, открытый первым (по ссылке, после замены), остаётся без
   * системной стрелки — слева тогда встаёт «Закрити» на запасное место. Есть
   * куда вернуться — кнопки нет, работает обычная стрелка.
   */
  const closeIfAlone = ({ canGoBack }: { canGoBack?: boolean }) => (
    <ExitHeaderButton canGoBack={!!canGoBack} label={ut("common.close")} />
  );
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // шапка — полоса «Виразной»: подпись, «назад» и действие справа из опций экрана (ui/headers.tsx)
        header: (props) => <StackHeader {...props} />,
        contentStyle: { backgroundColor: c.ground },
        /*
         * Подпись стрелки на iOS — имя предыдущего экрана, а у группы
         * вкладок его нет: стрелка читалась «‹ (app)».
         */
        headerBackTitle: ut("common.back"),
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="login" />
      <Stack.Screen name="register" />
      <Stack.Screen name="consent" />
      {/* смена временного пароля: до согласия и до всего остального (auth/passwordGate.ts) */}
      <Stack.Screen name="password" />
      <Stack.Screen name="(app)" />
      {/*
        «Допомога» в шапке прохождения: методика может спросить о том, после
        чего помощь нужна сразу, и искать её на другой вкладке некогда.
      */}
      <Stack.Screen
        name="survey/[id]"
        options={{
          headerShown: true,
          title: ut("mnav.instrument"),
          headerLeft: closeIfAlone,
          header: (props) => <StackHeader {...props} help />,
        }}
      />
      {/*
        Карта пациента в обходе не была объявлена здесь и наследовала
        headerShown: false — без шапки и без стрелки. На Android выручала
        системная кнопка, на iPhone оставался только жест от края, о котором
        никто не знает. Заголовок экран ставит сам (имя пациента).
      */}
      <Stack.Screen
        name="rounds/[userId]"
        options={{ headerShown: true, title: ut("rounds.title"), headerLeft: closeIfAlone }}
      />
      <Stack.Screen name="analytics" />
    </Stack>
  );
}
