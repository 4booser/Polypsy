import { useEffect, useState, useSyncExternalStore } from "react";
import { connection, type ConnectionState } from "../connection";
import { timeOfDay } from "../format";
import { useLang } from "../lang";
import { cx } from "./cx";

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

  const column = place === "console" ? "mx-auto w-full max-w-[1248px] px-6 max-[900px]:px-4" : "px-4";

  if (!state.online) {
    return (
      <div role="status" data-connection="lost" className="shrink-0 border-b border-accent bg-accent-soft text-accent">
        <div
          className={cx(
            "flex flex-wrap items-baseline gap-x-[12px] gap-y-[2px] py-[8px] text-[14px] leading-[20px]",
            column,
          )}
        >
          <span className="font-bold">{ut("conn.lost")}</span>
          {state.lostAt ? (
            <span>
              {ut("conn.since")}{" "}
              <span className="font-mono tabular-nums">{timeOfDay(new Date(state.lostAt).toISOString())}</span>
            </span>
          ) : null}
          {/* что с данными — тёмным: это объяснение, а не сигнал */}
          <span className="min-w-0 text-text">{ut("conn.keep")}</span>
          <button
            type="button"
            disabled={checking}
            onClick={() => {
              setChecking(true);
              void connection.check().finally(() => setChecking(false));
            }}
            className={cx(
              "ml-auto cursor-pointer rounded-sm border-0 bg-transparent p-0 font-bold text-accent underline underline-offset-2",
              "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-default disabled:no-underline",
            )}
          >
            {checking ? ut("conn.checking") : ut("conn.checkNow")}
          </button>
        </div>
      </div>
    );
  }

  if (!restoredShown) return null;
  return (
    <div role="status" data-connection="restored" className="shrink-0 border-b border-hairline bg-primary-soft text-primary">
      <div className={cx("py-[8px] text-[14px] leading-[20px]", column)}>
        <span className="font-bold">{ut("conn.restored")}</span>
      </div>
    </div>
  );
}
