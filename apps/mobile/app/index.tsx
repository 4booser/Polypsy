import { Redirect } from "expo-router";
import { useAuth } from "@/auth/AuthContext";
import { Loader } from "@/components/ui";

/** Точка входа: пока читаем токен — спиннер, дальше в приложение или на логин */
export default function Index() {
  const { user, loading } = useAuth();
  if (loading) return <Loader />;
  return <Redirect href={user ? "/(app)/surveys" : "/login"} />;
}
