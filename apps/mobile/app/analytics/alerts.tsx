import { Redirect } from "expo-router";

/**
 * Прежний адрес очереди случаев. Сигналы ризику — вкладка сотрудника
 * ((app)/alerts.tsx): разбор там же, в листе снизу, и панель вкладок на месте.
 */
export default function AlertsRedirect() {
  return <Redirect href="/(app)/alerts" />;
}
