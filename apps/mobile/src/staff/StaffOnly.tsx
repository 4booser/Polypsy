import type { ReactNode } from "react";
import { Redirect } from "expo-router";
import { useAuth } from "../auth/AuthContext";
import { Loader } from "../components/ui";

/**
 * Экран сотрудника — только сотруднику.
 *
 * Вкладки обхода, сигналов и пациентов пациенту не показываются, но адреса у
 * них есть: ссылка `quizzy://alerts` или открытая страница веб-сборки
 * рисовали пациенту экран специалиста, и тот слал запросы очереди случаев,
 * обхода и карт (сервер отвечал 403, экран — ошибкой). Пациент уходит на
 * свою «Головну», не вошедший — оттуда же на вход ((app)/_layout.tsx), и ни
 * одного запроса сотрудника с его телефона не уходит.
 */
export function StaffOnly({ children }: { children: ReactNode }) {
  const { loading, isAdmin } = useAuth();
  if (loading) return <Loader />;
  if (!isAdmin) return <Redirect href="/(app)/home" />;
  return <>{children}</>;
}
