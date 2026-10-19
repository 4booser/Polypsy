import type { ReactNode } from "react";

/*
 * Значки линией набора — рельса и действия. Отдельным модулем, а не в
 * ui/index.tsx: рельсе (начальный кусок) нужны только они, а точка входа
 * набора тянула бы за собой таблицу, фильтры и окна (волна 27, perf-bundle).
 */

const icon = (path: ReactNode) =>
  function Icon() {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        {path}
      </svg>
    );
  };

export const IconDashboard = icon(<><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>);
export const IconSurvey = icon(<><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 12h6M9 16h4" /></>);
export const IconGroup = icon(<><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>);
export const IconPatients = icon(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></>);
export const IconAlert = icon(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>);
export const IconUsers = icon(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /></>);
/* стопка листов: пакет заключений — это подшивка, а не отдельный документ */
export const IconStack = icon(<><rect x="4" y="3" width="12" height="15" rx="1" /><path d="M8 21h10a2 2 0 0 0 2-2V8" /><path d="M8 8h4M8 12h4" /></>);
/* Администрирование: человек с шестерёнкой — настройка того, кто что может */
export const IconUserGear = icon(<><circle cx="9" cy="7" r="4" /><path d="M2 21v-2a4 4 0 0 1 4-4h5" /><circle cx="18" cy="17" r="2.5" /><path d="M18 13v1.2M18 19.8V21M21.5 15l-1 .6M15.5 18.4l-1 .6M21.5 19l-1-.6M15.5 15.6l-1-.6" /></>);
export const IconBattery = icon(<><rect x="2" y="7" width="16" height="10" rx="2" /><path d="M22 11v2" /><path d="M6 11v2M10 11v2" /></>);
export const IconClock = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IconPulse = icon(<><path d="M2 12h4l2-7 4 14 3-9 2 2h5" /></>);
export const IconReferral = icon(<><path d="M4 12h11" /><path d="M12 6l6 6-6 6" /><path d="M20 4v16" /></>);
/*
 * Значки действий и состояний.
 *
 * Заводятся здесь, а не в отдельном наборе и не картинками: обводка у всех
 * одна (24×24, штрих 1.8, скруглённые концы), и покупной растровый набор
 * выбивался бы из строя на первом же экране, где стоит рядом со своими.
 * Заодно значок наследует цвет текста и меняется вместе с темой — картинке
 * пришлось бы держать две версии.
 */
export const IconSearchGlass = icon(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const IconPrint = icon(<><path d="M7 8V3h10v5" /><rect x="4" y="8" width="16" height="8" rx="2" /><path d="M7 14h10v7H7z" /></>);
export const IconWarn = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></>);
export const IconOk = icon(<><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>);
export const IconLock = icon(<><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>);
export const IconMessage = icon(<><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></>);
