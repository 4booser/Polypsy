import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { dateTime, timeOfDay } from "../format";
import { useLang } from "../lang";
import { Strip, stripAction } from "../shell/Strip";
import { useFlag } from "./flags";
import { bannerFor, minutesLeft, sameLocalDay } from "./model";
import { useServiceStatus } from "./status";

/**
 * Баннер «идут работы / сбои» — всем, кто открыл систему.
 *
 * Решение заказчика 2026-09-26 (техпанель, пункт 10): «баннер всем, запись
 * закрыта, чтение открыто». Стоит в консоли под верхней полосой во всю
 * ширину, в кабинете пациента, в прохождении методики и на экране входа.
 *
 * Янтарём, потому что янтарь в системе значит «требует внимания» — и ничего
 * больше; здесь ровно этот случай. Цвет не работает один: состояние
 * названо словами первым же словом баннера.
 *
 * role="status", а не alert: баннер появляется не в ответ на действие
 * человека, и перебивать диктора посреди чтения карты незачем — он скажет
 * о нём, когда дочитает.
 *
 * Вид — выноской набора во всю ширину (shell/Strip.tsx): значок и
 * заголовок янтарём, пояснение обычным текстом, «Докладніше» справа.
 * `place` меняет только раму: в консоли — полоса под полосой приложения,
 * в кабинете и на входе — выноска в колонке экрана.
 */
export function MaintenanceBanner({ place }: { place: "console" | "patient" | "public" }) {
  const { ut } = useLang();
  const { status } = useServiceStatus();
  const banner = bannerFor(status);
  /*
   * Отсчёт «≈ 25 хв» — за флагом функции (packages/shared/src/featureFlags.ts):
   * настоящий флаг, на котором механизм и проверяется. Гостю на экране входа
   * он выключен всегда: флаги — про человека, а человека ещё нет.
   */
  const countdown = useFlag("maint.bannerCountdown");
  const [now, setNow] = useState(() => Date.now());
  const ticking = countdown && !!banner?.expectedEnd;
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [ticking]);

  if (!banner) return null;

  const left = countdown ? minutesLeft(banner.expectedEnd, now) : null;
  const until = banner.expectedEnd
    ? sameLocalDay(banner.expectedEnd, now)
      ? timeOfDay(banner.expectedEnd)
      : dateTime(banner.expectedEnd)
    : null;

  return (
    <Strip
      tone="warn"
      icon={banner.tone === "maintenance" ? "wrench" : "circle-alert"}
      place={place}
      data-banner={banner.tone}
      title={banner.tone === "maintenance" ? ut("svc.banner.maintenance") : ut("svc.banner.degraded")}
      action={
        <Link to="/status" className={stripAction}>
          {ut("svc.details")}
        </Link>
      }
    >
      {banner.tone === "maintenance" ? <span>{ut("svc.banner.maintenanceHint")}</span> : null}
      {/* текст объявления — словами того, кто объявил; основным цветом, чтобы читался, а не мерцал янтарём */}
      {banner.message ? <span className="min-w-0 text-text [overflow-wrap:anywhere]">{banner.message}</span> : null}
      {until ? (
        <span>
          {ut("svc.until")} <span className="font-bold text-text tabular-nums">{until}</span>
          {left !== null ? (
            <span className="tabular-nums">
              {" (≈ "}
              {ut("common.minutes").replace("{n}", String(left))}
              {")"}
            </span>
          ) : null}
        </span>
      ) : null}
    </Strip>
  );
}
