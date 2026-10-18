import { useEffect, useState, useSyncExternalStore } from "react";
import { connection, type ConnectionState } from "../connection";
import { timeOfDay } from "../format";
import { useLang } from "../lang";
import { Strip, stripAction } from "../shell/Strip";

/** Сколько держится строка «зв’язок відновлено» */
export const RESTORED_MS = 4_000;

const read = () => connection.get();

export function useConnection(): ConnectionState {
  return useSyncExternalStore(connection.subscribe, read, read);
}

/**
 * Строка «немає зв’язку» — одна на оболочку, а не своя на каждом экране.
 *
 * Внешний разбор (волна 13): «в веб-консоли отсутствовало понятное
 * восстановление после потери связи». Полоса «нет связи» была, но своя у
 * нескольких экранов и с кнопкой «повторить»: остальные экраны молчали, а
 * вернувшаяся связь не будила никого — человек жал кнопку или перезагружал
 * страницу. Теперь строка стоит в оболочке, под верхней полосой (там же,
 * где баннер работ), знает о связи всё, что знает вкладка (connection.ts), и
 * говорит три вещи: связи нет с такого-то времени; на экране — последние
 * загруженные данные; как только связь вернётся, они обновятся сами.
 *
 * Янтарём, пока связи нет: это ровно «требует внимания» — цифры на экране
 * могут устареть, а сохранить сейчас ничего не выйдет. Вернулась —
 * несколько секунд спокойная строка цветом состояния (primary), без янтаря:
 * внимания это уже не требует, но человек, видевший обрыв, должен увидеть
 * и его конец.
 *
 * role="status": строка появляется не в ответ на действие человека, и
 * перебивать диктора незачем — он скажет о ней, когда дочитает.
 *
 * `place` меняет только поля — как у баннера работ (service/MaintenanceBanner).
 */
export function ConnectionLine({ place }: { place: "console" | "patient" }) {
  const { ut } = useLang();
  const state = useConnection();
  const [checking, setChecking] = useState(false);
  const [restoredShown, setRestoredShown] = useState(false);

  useEffect(() => {
    // строка о давнем восстановлении не всплывает на экране, открытом позже
    const left = state.restoredAt ? RESTORED_MS - (Date.now() - state.restoredAt) : 0;
    if (left <= 0) return;
    setRestoredShown(true);
    const timer = setTimeout(() => setRestoredShown(false), left);
    return () => clearTimeout(timer);
  }, [state.restoredAt]);

  if (!state.online) {
    return (
      <Strip
        tone="warn"
        icon="wifi-off"
        place={place}
        data-connection="lost"
        title={ut("conn.lost")}
        action={
          <button
            type="button"
            disabled={checking}
            onClick={() => {
              setChecking(true);
              void connection.check().finally(() => setChecking(false));
            }}
            className={stripAction}
          >
            {checking ? ut("conn.checking") : ut("conn.checkNow")}
          </button>
        }
      >
        {state.lostAt ? (
          <span>
            {ut("conn.since")}{" "}
            <span className="font-bold text-text tabular-nums">{timeOfDay(new Date(state.lostAt).toISOString())}</span>
          </span>
        ) : null}
        {/* что с данными — основным цветом: это объяснение, а не сигнал */}
        <span className="min-w-0 text-text">{ut("conn.keep")}</span>
      </Strip>
    );
  }

  if (!restoredShown) return null;
  return <Strip tone="violet" icon="circle-check" place={place} data-connection="restored" title={ut("conn.restored")} />;
}
