import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * Раздел свитка: линия 2px сверху, заголовок 20/700 и действия справа в одной
 * строке, под ним — необязательное пояснение.
 *
 * Та же геометрия, что у разделов карточки пациента (patientCard/PatientCard,
 * кадр f13: 32 от линии до заголовка, 14 до содержимого), вынесенная в общий
 * компонент, когда вторым и третьим экраном с разделами стали графики
 * прохождения, аналитика методики и сводка. Карточка пациента держит свою
 * копию с замерами кадра в комментарии — переводить её сюда стоит тогда,
 * когда разойдутся числа, а не раньше: сейчас они совпадают.
 *
 * Линия — --primary-rule (#b299cc кадра), не --primary-dim: приглушённая
 * ступень осветлена до порога контраста текста, а линии порог текста не
 * писан (см. tokens.css у --polsy-violet-soft).
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
    <section id={id} className={cx("border-t-2 border-primary-rule pb-[20px] pt-[32px]", className)}>
      <div className="mb-[14px] flex min-h-[27px] flex-wrap items-center justify-between gap-x-[24px] gap-y-[8px]">
        <h2 className="m-0 text-[20px] font-bold leading-[24px] text-primary">{title}</h2>
        {actions ? <div className="flex flex-wrap items-center gap-[12px]">{actions}</div> : null}
      </div>
      {hint ? <p className="m-0 mb-[18px] max-w-[760px] text-[13px] leading-[18px] text-muted">{hint}</p> : null}
      {children}
    </section>
  );
}
