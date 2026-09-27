import { useRef, useState } from "react";
import { Alert, Linking } from "react-native";
import { api } from "../api/client";
import { useLang } from "../lang";

/**
 * Открыть печатный лист прохождения в браузере телефона (волна 14).
 *
 * Одна кнопка на двух экранах (после сдачи и в динамике пациента) — и одна
 * реализация: ссылку выдаёт сервер по запросу с токеном и языком
 * (api.reportLink, src/report/model.ts), браузер получает только её.
 *
 * Пока ссылка выдаётся, кнопка занята: второе нажатие выдало бы вторую
 * ссылку и открыло второй лист. Замок — ref, а не состояние: двойное
 * нажатие приходит раньше, чем экран перерисуется с «занято».
 *
 * Отказ — окном с текстом сервера: он уже на языке приложения
 * (Accept-Language запроса), и «результаты обсуждает специалист»
 * (err.resultsWithSpecialist) человек читает здесь, а не страницей отказа
 * в браузере.
 */
export function useOpenReport(): { open: (responseId: string) => void; opening: boolean } {
  const { ut } = useLang();
  const busy = useRef(false);
  const [opening, setOpening] = useState(false);

  const open = (responseId: string) => {
    if (busy.current) return;
    busy.current = true;
    setOpening(true);
    void (async () => {
      try {
        await Linking.openURL(await api.reportLink(responseId));
      } catch (e) {
        Alert.alert(ut("mrep.openFailed"), e instanceof Error ? e.message : ut("common.error"));
      } finally {
        busy.current = false;
        setOpening(false);
      }
    })();
  };

  return { open, opening };
}
