import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { connection, type ConnectionState } from "../connection";
import { timeOfDay } from "../format";
import { useLang } from "../lang";
import { Strip, stripAction } from "../shell/Strip";
import { Ic } from "./icons";
import { Button } from "./primitives";

/** Сколько держится строка «зв’язок відновлено» */
const RESTORED_MS = 4_000;

/** Как часто строка обрыва пересчитывает «N хв»: минута на экране, отстающая на полминуты, незаметна */
const TICK_MS = 30_000;

const read = () => connection.get();

function useConnection(): ConnectionState {
  return useSyncExternalStore(connection.subscribe, read, read);
}

/** Полных минут без связи; меньше минуты — 0 (числа ещё нет) */
export function minutesOffline(lostAt: number, now: number): number {
  return Math.max(0, Math.floor((now - lostAt) / 60_000));
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
 * говорит три вещи: связи нет с такого-то времени и сколько уже минут; на
 * экране — последние загруженные данные; как только связь вернётся, они
 * обновятся сами. Справа — «Перевірити зараз» (не ждать очередной паузы
 * проверки) и «Стан системи»: страница статуса открыта без входа и
 * объясняет, работы это или сбой (Polypsy 2.0, кадр access-offline).
 *
 * Чего с кадра нет: «наступна спроба через 12 с». Паузы проверок знает
 * connection.ts, но момента следующей наружу не отдаёт, а счёт секунд на
 * экране означал бы перерисовку строки каждую секунду ради подсказки.
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
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // строка о давнем восстановлении не всплывает на экране, открытом позже
    const left = state.restoredAt ? RESTORED_MS - (Date.now() - state.restoredAt) : 0;
    if (left <= 0) return;
    setRestoredShown(true);
    const timer = setTimeout(() => setRestoredShown(false), left);
    return () => clearTimeout(timer);
  }, [state.restoredAt]);

  /* «N хв» растёт, пока связи нет; с связью часы не идут */
  useEffect(() => {
    if (state.online) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [state.online]);

  if (!state.online) {
    const minutes = state.lostAt ? minutesOffline(state.lostAt, now) : 0;
    return (
      <Strip
        tone="warn"
        icon="wifi-off"
        place={place}
        tile={place === "console"}
        data-connection="lost"
        title={ut("conn.lost")}
        action={
          <>
            <Button
              variant="panel"
              size="xs"
              icon={<Ic.refresh />}
              disabled={checking}
              onClick={() => {
                setChecking(true);
                void connection.check().finally(() => setChecking(false));
              }}
            >
              {checking ? ut("conn.checking") : ut("conn.checkNow")}
            </Button>
            <Link to="/status" className={stripAction}>
              {ut("svc.title")}
            </Link>
          </>
        }
      >
        {state.lostAt ? (
          <span>
            {ut("conn.since")}{" "}
            <span className="font-bold text-text tabular-nums">{timeOfDay(new Date(state.lostAt).toISOString())}</span>
            {minutes > 0 ? `, ${ut("common.minutes").replace("{n}", String(minutes))}` : null}
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
