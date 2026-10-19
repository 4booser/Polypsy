import { useLang } from "../lang";
import { CallRows } from "../patient/callRows";

/**
 * Номера помощи на листе падения кабинета пациента (App.tsx, граница ошибок
 * кабинета): линия доверия и 103 — звонком, без подтверждения.
 *
 * Экран упал у человека, который, возможно, проходил опросник потому, что
 * ему плохо, — и лист «щось пішло не так» без номера был бы тупиком. Строки —
 * те же, что в ящике «Допомога» кабинета (CallRows), статичным импортом, а не
 * догрузкой: лист падения нужен и тогда, когда догрузить уже нечего.
 */
export function CrashHelp() {
  const { ut } = useLang();
  return (
    <section aria-label={ut("pt.helpTitle")}>
      <p className="m-0 mb-[10px] text-[15.5px] font-extrabold leading-[21px] text-text">{ut("pt.helpTitle")}</p>
      <CallRows />
    </section>
  );
}
