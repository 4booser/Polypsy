import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../auth/AuthContext";
import { authenticate, isEnabled } from "../auth/biometrics";
import { Body, Button, Title } from "./ui";
import { spacing, useColors } from "../theme";
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

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.bg,
        alignItems: "center",
        justifyContent: "center",
        padding: spacing.xl,
        gap: spacing.lg,
      }}
    >
      <Text style={{ fontSize: 44 }}>🔒</Text>
      <Title>{ut("mlock.locked")}</Title>
      <Body muted>{ut("mlock.confirm")}</Body>
      <Button title={ut("mlock.unlock")} onPress={() => void unlock()} />
      {/*
        Выход с замка. Раньше на экране была одна кнопка — «разблокировать»:
        если подтверждение не проходит (сменили отпечатки, сняли код
        устройства, чужой палец на общем планшете), человек оставался перед
        замком навсегда, и помогало только удаление приложения. Выход ничего
        не открывает: учётная запись закрывается, данные остаются под замком
        пароля, а неотправленные ответы — за владельцем (offline/queue.ts).
      */}
      {user ? (
        <>
          <Body muted>{ut("mlock.signOutHint")}</Body>
          <Button
            title={ut("auth.logout")}
            variant="secondary"
            onPress={async () => {
              await logout();
              setSignedOut(true);
              setLocked(false);
            }}
          />
        </>
      ) : null}
    </View>
  );
}
