import type { ReactNode } from "react";
import { cx } from "../ui/cx";
import { ShellIcon, type IconName } from "./icons";

/*
 * Полоса-сообщение оболочки — выноска набора (.callout) во всю ширину:
 * значок и заголовок цветом смысла, пояснение обычным текстом, действие
 * справа. Так написаны три сообщения, которые стоят над любым экраном:
 * технические работы (MaintenanceBanner), нет связи (ConnectionLine) и
 * просмотр от имени другого человека (ImpersonationBanner).
 *
 * Янтарь — «требует внимания» и ничего больше: работы, обрыв связи, чужие
 * глаза. Фиолетовый — спокойное «всё вернулось». Красного здесь нет вовсе:
 * ни одно из трёх сообщений не про риск для человека.
 *
 * `place` меняет только раму: в консоли — полоса во всю ширину под полосой
 * приложения, в кабинете и на гостевых страницах — выноска со скруглением
 * в колонке экрана.
 */
export function Strip({
  tone,
  icon,
  title,
  place = "console",
  tile,
  action,
  children,
  className,
  ...data
}: {
  tone: "warn" | "violet";
  icon: IconName;
  title: ReactNode;
  place?: "console" | "patient" | "public";
  /**
   * Значок в квадрате 36 на листе (.conn .aic набора) вместо значка в строке:
   * у строки «немає зв’язку», которая стоит над экраном дольше остальных.
   */
  tile?: boolean;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
} & { [k: `data-${string}`]: string }) {
  const ink = tone === "warn" ? "text-warn" : "text-violet-ink";
  return (
    <div
      role="status"
      {...data}
      className={cx(
        "shrink-0 print:hidden",
        tone === "warn" ? "bg-warn-tint" : "bg-violet-tint",
        place === "console"
          ? cx("border-b", tone === "warn" ? "border-warn-line" : "border-violet-line")
          : place === "patient"
            ? "mx-auto mt-3 w-[calc(100%-32px)] max-w-[1120px] rounded-panel"
            : "mt-6 max-w-[640px] rounded-panel",
        className,
      )}
    >
      <div
        className={cx(
          "flex flex-wrap items-center gap-x-3 gap-y-1 py-[9px] text-[13px] leading-5 text-text-2",
          place === "console" ? "px-5 max-[900px]:px-4" : "px-[14px] py-3",
          tile && place === "console" && "min-h-14 py-2",
        )}
      >
        {tile ? (
          <span
            aria-hidden
            className={cx(
              "grid size-9 shrink-0 place-items-center rounded-[11px] bg-panel",
              ink,
              tone === "warn" ? "shadow-[inset_0_0_0_1px_var(--warnline)]" : "shadow-[inset_0_0_0_1px_var(--vline)]",
            )}
          >
            <ShellIcon name={icon} size={17} />
          </span>
        ) : (
          <ShellIcon name={icon} size={16} className={ink} />
        )}
        <b className={cx("font-extrabold", ink)}>{title}</b>
        {children}
        {action ? <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">{action}</span> : null}
      </div>
    </div>
  );
}

/** Действие полосы — словом-ссылкой, как в выноске набора: жирный фиолетовый, без рамки */
export const stripAction = cx(
  "min-h-0 cursor-pointer rounded-[6px] border-0 bg-transparent p-0 font-bold text-violet-ink underline-offset-2",
  "hover:underline disabled:cursor-default disabled:no-underline disabled:opacity-60",
);
