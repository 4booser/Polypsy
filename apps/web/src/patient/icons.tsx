/**
 * Значки кабинета пациента.
 *
 * Крупнее консольных: нижняя полоса вкладок читается пальцем и мельком, а
 * не наведением мыши. Обводка та же, что в консоли, — приложение одно, и
 * разный штрих выдавал бы, что экраны собирали разные люди.
 */
const s = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const IconHome = () => (
  <svg {...s}>
    <path d="M3 11 12 3l9 8" />
    <path d="M5 10v10h14V10" />
  </svg>
);

export const IconTest = () => (
  <svg {...s}>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M9 8h6M9 12h6M9 16h3" />
  </svg>
);

export const IconCalendar = () => (
  <svg {...s}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </svg>
);

export const IconPerson = () => (
  <svg {...s}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
  </svg>
);

export const IconClock = () => (
  <svg {...s}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const IconPin = () => (
  <svg {...s}>
    <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z" />
    <circle cx="12" cy="10" r="2.5" />
  </svg>
);

export const IconVideo = () => (
  <svg {...s}>
    <rect x="3" y="6" width="12" height="12" rx="2" />
    <path d="m15 10 6-3v10l-6-3" />
  </svg>
);

export const IconCheck = () => (
  <svg {...s}>
    <path d="m4 12 5 5L20 6" />
  </svg>
);
