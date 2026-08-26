import { Redirect } from "expo-router";
import { useAuth } from "@/auth/AuthContext";
import { Loader } from "@/components/ui";

/** Вкладка аналитики просто переадресует в полноэкранный раздел */
export default function InsightsTab() {
  const { loading, isAdmin } = useAuth();
  if (loading) return <Loader />;
  if (!isAdmin) return <Redirect href="/(app)/surveys" />;
  return <Redirect href="/analytics" />;
}
