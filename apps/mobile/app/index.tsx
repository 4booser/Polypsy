import { Redirect } from "expo-router";
import { useAuth } from "@/auth/AuthContext";
import { Loader } from "@/components/ui";
import { routeAfterSignIn } from "@/auth/passwordGate";

/**
 * Точка входа: пока читаем токен — спиннер; с живой сессией — через смену
 * временного пароля, если он временный, и экран согласия (он сам пропускает
 * принявших); без сессии — на логин.
 */
export default function Index() {
  const { user, loading } = useAuth();
  if (loading) return <Loader />;
  // временный пароль — сначала смена, потом согласие (auth/passwordGate.ts)
  return <Redirect href={routeAfterSignIn(user)} />;
}
