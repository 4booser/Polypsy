import type { ReactNode } from "react";
import type { UiKey } from "@quizzy/shared";
import { cx } from "../../ui/cx";

/*
 * Общее для экранов раздела «Адміністрування» (Polypsy 2.0, участок
 * v2-admin): значки, которых нет в наборе, сохранение файла и короткие даты
 * «сьогодні, 09:12» / «06.10, 16:05», как их пишет макет.
 *
 * Значки — те же контуры lucide, что в наборе (ui/icons.tsx), той же
 * толщиной и тем же currentColor: экран не отличит их от набора. Живут здесь,
 * а не в наборе, — набор правит участок v2-kit, а этим экранам нужны свои
 * два десятка рисунков (ключ, щит, монитор, терминал…). Когда набор заведёт
 * их у себя, файл сведётся к реэкспорту.
 */

interface IconProps {
  size?: number;
  className?: string;
}

function make(paths: ReactNode) {
  return function Icon({ size = 16, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        focusable="false"
        className={cx("shrink-0", className)}
      >
        {paths}
      </svg>
    );
  };
}

const person = (
  <>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
  </>
);
const shield = (
  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
);

export const AIc = {
  key: make(
    <>
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </>,
  ),
  userPlus: make(
    <>
      {person}
      <path d="M19 8v6M22 11h-6" />
    </>,
  ),
  userX: make(
    <>
      {person}
      <path d="m17 8 5 5M22 8l-5 5" />
    </>,
  ),
  userCheck: make(
    <>
      {person}
      <path d="m16 11 2 2 4-4" />
    </>,
  ),
  userCog: make(
    <>
      <circle cx="9" cy="7" r="4" />
      <path d="M2 21v-2a4 4 0 0 1 4-4h5" />
      <circle cx="18" cy="17" r="2.5" />
      <path d="M18 13v1.2M18 19.8V21M21.5 15l-1 .6M15.5 18.4l-1 .6M21.5 19l-1-.6M15.5 15.6l-1-.6" />
    </>,
  ),
  stethoscope: make(
    <>
      <path d="M11 2v2M5 2v2" />
      <path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1" />
      <path d="M8 15a6 6 0 0 0 12 0v-3" />
      <circle cx="20" cy="10" r="2" />
    </>,
  ),
  logOut: make(
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </>,
  ),
  transfer: make(<path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" />),
  rotate: make(
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>,
  ),
  shield: make(shield),
  shieldHalf: make(
    <>
      {shield}
      <path d="M12 22V2" />
    </>,
  ),
  shieldAlert: make(
    <>
      {shield}
      <path d="M12 8v4M12 16h.01" />
    </>,
  ),
  building: make(
    <>
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
      <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2M10 6h4M10 10h4M10 14h4M10 18h4" />
    </>,
  ),
  network: make(
    <>
      <rect x="16" y="16" width="6" height="6" rx="1" />
      <rect x="2" y="16" width="6" height="6" rx="1" />
      <rect x="9" y="2" width="6" height="6" rx="1" />
      <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8" />
    </>,
  ),
  briefcase: make(
    <>
      <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
      <rect width="20" height="14" x="2" y="6" rx="2" />
    </>,
  ),
  door: make(
    <>
      <path d="M13 4h3a2 2 0 0 1 2 2v14M2 20h3M13 20h9M10 12v.01" />
      <path d="M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561Z" />
    </>,
  ),
  monitor: make(
    <>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>,
  ),
  smartphone: make(
    <>
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
      <path d="M12 18h.01" />
    </>,
  ),
  mail: make(
    <>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </>,
  ),
  at: make(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
    </>,
  ),
  send: make(
    <>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </>,
  ),
  copy: make(
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>,
  ),
  printer: make(
    <>
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" />
      <rect x="6" y="14" width="12" height="8" rx="1" />
    </>,
  ),
  terminal: make(
    <>
      <path d="m7 11 2-2-2-2M11 13h4" />
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    </>,
  ),
  braces: make(
    <>
      <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" />
      <path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
    </>,
  ),
  globe: make(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20" />
    </>,
  ),
  link: make(
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>,
  ),
  eraser: make(<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7M5 11l9 9" />),
  book: make(
    <path d="M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />,
  ),
  signature: make(
    <>
      <path d="M20 19.5v.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8.5L18 5.5M8 18h1" />
      <path d="M18.42 9.61a2.1 2.1 0 1 1 2.97 2.97L16.95 17 13 18l.99-3.95 4.43-4.44Z" />
    </>,
  ),
  trash: make(<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />),
  dot: make(
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="1" />
    </>,
  ),
  moon: make(<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />),
  pin: make(
    <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />,
  ),
  eyeOff: make(
    <>
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143M2 2l20 20" />
    </>,
  ),
  panel: make(
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </>,
  ),
  palette: make(
    <>
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </>,
  ),
  gitBranch: make(
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 9v12M18 15V9a3 3 0 0 0-3-3H9" />
    </>,
  ),
  activity: make(<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />),
} as const;

/* ─────────── файл на диск ─────────── */

/**
 * Отдать текст файлом: CSV реестра, коды восстановления, описание API.
 * Файл собирается в браузере — второго запроса к серверу (и второй записи
 * в журнал) выгрузка уже показанного не делает.
 */
export function saveFile(text: string, name: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/* ─────────── даты, как их пишет макет ─────────── */

const pad = (n: number) => String(n).padStart(2, "0");

/** «06.10» — день и месяц числами; год — только не текущий */
export function dm(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const base = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}.${d.getFullYear()}`;
}

/** «09:12» */
export function hm(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** «03.02.2025» — полная дата числами */
export function dmy(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Сколько полных суток между моментом и «сейчас» — по местному календарю */
export function daysAgo(iso: string, now = new Date()): number {
  const d = new Date(iso);
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((midnight(now) - midnight(d)) / 86_400_000);
}

/**
 * «сьогодні, 09:12» / «учора, 18:40» / «06.10, 16:05» — момент в строке
 * реестра. Слова «сьогодні» и «учора» — из словаря: ключи передаёт экран.
 */
export function whenShort(iso: string, t: (k: UiKey) => string, now = new Date()): string {
  const ago = daysAgo(iso, now);
  const day = ago === 0 ? t("adm2.today") : ago === 1 ? t("adm2.yesterday") : dm(iso, now);
  return `${day}, ${hm(iso)}`;
}

/** Число со словом в нужной форме: «1 лікар», «3 лікарі», «18 лікарів» — правило набора (ui/plural.ts) */
export { withCount as plural } from "../../ui/plural";

/** Подстановка {name} в строку словаря */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

/** Короткое имя «Коваль М. Я.» из полного «Коваль Марта Ярославівна» */
export function shortName(full: string): string {
  const [last, first, middle] = full.trim().split(/\s+/);
  if (!last) return full;
  return [last, first ? `${first[0]}.` : "", middle ? `${middle[0]}.` : ""].filter(Boolean).join(" ");
}
