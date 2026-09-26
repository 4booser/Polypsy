import { Redirect } from "expo-router";
import { useAuth } from "@/auth/AuthContext";
import { Loader } from "@/components/ui";

/**
 * Прямой адрес /insights — переадресация в полноэкранный раздел.
 *
 * Нажатие на вкладку сюда не ведёт: оно перехвачено в (app)/_layout.tsx и
 * кладёт раздел поверх вкладок, чтобы «назад» возвращал на место. Здесь —
 * только открытие по адресу: переадресация заменяет вкладки разделом, и
 * позади ничего не остаётся; выход к вкладкам тогда даёт «‹ Меню» и кнопка
 * «назад» на Android (src/nav/exits.ts).
 */
export default function InsightsTab() {
  const { loading, isAdmin } = useAuth();
  if (loading) return <Loader />;
  if (!isAdmin) return <Redirect href="/(app)/surveys" />;
  return <Redirect href="/analytics" />;
}
