import { Redirect } from "expo-router";

/**
 * Прежний адрес списка пациентов. Пацієнти — вкладка сотрудника
 * ((app)/patients.tsx); карта пациента по-прежнему здесь, в разделе
 * (analytics/patients/[userId].tsx), поверх вкладок.
 */
export default function PatientsRedirect() {
  return <Redirect href="/(app)/patients" />;
}
