import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../auth/AuthContext";
import { authenticate, isEnabled } from "../auth/biometrics";
import { useColors } from "../theme";
import { ActionBar, Btn } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { NavBar } from "../ui/NavBar";
import { T } from "../ui/Text";
import { Avatar } from "./patient/Avatar";
import { CrisisStrip } from "./patient/Crisis";
import { useLang } from "@/lang";

/** Через сколько после сворачивания приложение просит подтвердить личность */
const RELOCK_AFTER_MS = 60_000;

/**
 * Замок поверх приложения.
 *
 * Запирается не при каждом сворачивании, а если приложение было в фоне
 * дольше минуты: переключение на калькулятор или входящий звонок посреди
 * методики не должны требовать пальца — человек в этот момент отвечает на
 * вопросы, и лишний барьер стоит брошенного прохождения.
 *
 * Телефон доверия на замке — без разблокировки: позвонить в кризис нельзя
 * заставлять доказывать, что телефон твой. Лист здесь — без людей из плана
 * безопасности и без переходов: имена и номера близких — то, что замок и
 * закрывает, а экраны за замком не открываются.
 */
export function AppLock({ children }: { children: React.ReactNode }) {
  const { ut } = useLang();
  const c = useColors();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const backgroundedAt = useRef<number | null>(null);
  const { user, logout } = useAuth();
  const router = useRouter();

  const unlock = useCallback(async () => {
    if (await authenticate()) setLocked(false);
  }, []);

  useEffect(() => {
    void isEnabled().then((on) => {
      setEnabled(on);
      if (on) {
        setLocked(true);
        void unlock();
      }
    });
  }, [unlock]);

  useEffect(() => {
    if (!enabled) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        backgroundedAt.current = Date.now();
        return;
      }
      if (state !== "active" || backgroundedAt.current === null) return;
      const away = Date.now() - backgroundedAt.current;
      backgroundedAt.current = null;
      if (away > RELOCK_AFTER_MS) {
        setLocked(true);
        void unlock();
      }
    });
    return () => sub.remove();
  }, [enabled, unlock]);

  /*
   * После выхода с замка — на экран входа. Не сразу в обработчике: пока замок
   * закрыт, стека под ним нет, и переходить некуда; переход — когда стек
   * снова отрисован.
   */
  useEffect(() => {
    if (!locked && signedOut) {
      setSignedOut(false);
      router.replace("/login");
    }
  }, [locked, signedOut, router]);

  if (enabled === null) return null;
  if (!locked) return <>{children}</>;

  /*
   * Выход с замка. Раньше на экране была одна кнопка — «разблокировать»:
   * если подтверждение не проходит (сменили отпечатки, сняли код
   * устройства, чужой палец на общем планшете), человек оставался перед
   * замком навсегда, и помогало только удаление приложения. Выход ничего
   * не открывает: учётная запись закрывается, данные остаются под замком
   * пароля, а неотправленные ответы — за владельцем (offline/queue.ts).
   */
  const signOut = async () => {
    await logout();
    setSignedOut(true);
    setLocked(false);
  };
  const face = Platform.OS === "ios" ? "scan-face" : "fingerprint";

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <NavBar flush />
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={{ alignItems: "center", paddingTop: 72, paddingHorizontal: 28, paddingBottom: 8 }}>
          <View style={{ width: 88, height: 88, borderRadius: 28, alignItems: "center", justifyContent: "center", backgroundColor: c.vtint, borderWidth: 1, borderColor: c.vline }}>
            <Icon name={face} size={44} color={c.vink} />
          </View>
          <T v="largeTitle" size={28} center accessibilityRole="header" style={{ marginTop: 22 }}>
            {ut("mlock.locked")}
          </T>
          <T v="lead" center style={{ marginTop: 8 }}>
            {ut("mpt.lock.text")}
          </T>
          {user ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                height: 40,
                marginTop: 16,
                paddingLeft: 6,
                paddingRight: 14,
                borderRadius: 20,
                backgroundColor: c.panel,
                borderWidth: 1,
                borderColor: c.border,
              }}
            >
              <Avatar name={user.fullName} size={28} />
              <T v="body" size={15} weight={700} numberOfLines={1}>
                {user.fullName}
              </T>
            </View>
          ) : null}
        </View>
        <CrisisStrip note={ut("mpt.crisisNoUnlock")} bare />
      </ScrollView>
      <ActionBar>
        <View style={{ flex: 1, gap: 6 }}>
          <Btn title={ut("mlock.unlock")} kind="primary" size="l" icon={face} full onPress={() => void unlock()} />
          {user ? (
            <T v="note" weight={600} tone="text2" center style={{ paddingVertical: 4 }}>
              {`${ut("mpt.lock.cant")} `}
              <T v="note" weight={800} color={c.vink} onPress={() => void signOut()} accessibilityRole="button">
                {ut("mpt.lock.out")}
              </T>
              {` ${ut("mpt.lock.rest")}`}
            </T>
          ) : null}
        </View>
      </ActionBar>
    </View>
  );
}
