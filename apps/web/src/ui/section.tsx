import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * Раздел свитка (.fsec набора): волосяная линия сверху, заголовок 15.5/800 и
 * действия справа в одной строке, под ним — необязательное пояснение.
 *
 * Линия — --divider в пиксель, а не цветная полоса: в наборе разделы держатся
 * на ритме и заголовке, цветом окрашены только смысл и действие. Первый
 * раздел в стопке линии не рисует — над ним уже шапка панели или экрана.
 */
export function RuleSection({
  title,
  hint,
  actions,
  children,
  className,
  id,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      data-rule-section
      className={cx("border-t border-divider pb-5 pt-[18px] first:border-t-0 first:pt-0", className)}
    >
      <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <h2 className="m-0 text-section font-extrabold text-text">{title}</h2>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {hint ? <p className="m-0 mb-4 max-w-[760px] text-small text-text-2">{hint}</p> : null}
      {children}
    </section>
  );
}
