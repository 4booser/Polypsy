import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { dateTime, timeOfDay } from "../format";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
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
 * `place` меняет только поля: в консоли колонка та же, что у полосы и
 * экрана (1248 с полями 24), в кабинете и на входе — узкая колонка
 * телефона.
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
    <div
      role="status"
      data-banner={banner.tone}
      className={cx(
        "border-b border-accent bg-accent-soft text-accent",
        place === "console" && "shrink-0",
        place === "public" && "mt-[24px] max-w-[640px] rounded-[5px] border",
      )}
    >
      <div
        className={cx(
          "flex flex-wrap items-baseline gap-x-[12px] gap-y-[2px] py-[8px] text-[14px] leading-[20px]",
          place === "console" ? "mx-auto w-full max-w-[1248px] px-6 max-[900px]:px-4" : "px-4",
        )}
      >
        <span className="font-bold">
          {banner.tone === "maintenance" ? ut("svc.banner.maintenance") : ut("svc.banner.degraded")}
        </span>
        {banner.tone === "maintenance" ? <span>{ut("svc.banner.maintenanceHint")}</span> : null}
        {/* текст объявления — словами того, кто объявил; тёмным, чтобы читался, а не мерцал янтарём */}
        {banner.message ? <span className="min-w-0 text-text [overflow-wrap:anywhere]">{banner.message}</span> : null}
        {until ? (
          <span>
            {ut("svc.until")} <span className="font-mono tabular-nums">{until}</span>
            {left !== null ? (
              <span className="font-mono tabular-nums">
                {" · ≈ "}
                {ut("common.minutes").replace("{n}", String(left))}
              </span>
            ) : null}
          </span>
        ) : null}
        <Link
          to="/status"
          className={cx(
            "ml-auto rounded-sm font-bold text-accent underline underline-offset-2",
            "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
          )}
        >
          {ut("svc.details")}
        </Link>
      </div>
    </div>
  );
}
