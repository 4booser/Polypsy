import { UI } from "@quizzy/shared";
import { currentLang } from "../currentLang";
import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";
import { prefStorage } from "../storage";

const PREF_KEY = "quizzy.biometrics";

/**
 * Замок на вход в приложение по отпечатку или лицу.
 *
 * Что он делает и чего не делает. Токен и так лежит в защищённом хранилище
 * системы; замок не добавляет ему шифрования — он закрывает экран. Смысл в
 * бытовой ситуации: телефон дали посмотреть фотографии, и человек не должен
 * при этом увидеть чужие результаты психодиагностики.
 *
 * Выключен по умолчанию и включается вручную. На общем планшете в кабинете
 * его включать нельзя: биометрия там принадлежит не обследуемому, и замок
 * привяжет учётную запись к тому, чей палец записан в устройстве.
 */
export async function isAvailable(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  const [hasHardware, enrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  return hasHardware && enrolled;
}

export async function isEnabled(): Promise<boolean> {
  return (await prefStorage.get(PREF_KEY)) === "1";
}

export async function setEnabled(on: boolean): Promise<void> {
  await prefStorage.set(PREF_KEY, on ? "1" : "0");
}

/**
 * Просит подтвердить личность. Возвращает false и при отказе, и при ошибке —
 * различать их незачем: в обоих случаях экран остаётся закрытым.
 *
 * disableDeviceFallback НЕ ставим: человек с забинтованными руками должен
 * иметь возможность войти по коду устройства, а не остаться без методики.
 */
export async function authenticate(): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      // системный диалог рисует ОС, языкового контекста здесь нет
      promptMessage: UI["bio.prompt"][currentLang],
      cancelLabel: UI["common.cancel"][currentLang],
    });
    return result.success;
  } catch {
    return false;
  }
}
