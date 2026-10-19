import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SEVERITY_STEPS_SCREEN_BG_LIGHT,
  SEVERITY_STEPS_SCREEN_LIGHT,
  serverText,
  type Lang,
  type Severity,
} from "@quizzy/shared";
import { env } from "../env";

/**
 * Печатный лист «Виразной» (UI 3, .superdesign/ui3/screens/print.py): общая
 * оснастка четырёх документов сервера — листа прохождения с заключением,
 * справки о посещении, выписки по обращению и амбулаторной карты — и
 * страницы одноразовой ссылки (routes/reports.ts).
 *
 * Лист один и тот же на экране и на бумаге: на экране — белый лист A4 на
 * сером столе (телефон — во всю ширину), на печати — только лист. Бумага у
 * отделения монохромная, поэтому:
 *  - выраженность — слово в обводке (ступень набора s0…s4 цветом обводки и
 *    надписи), а не заливка: серый принтер оставляет слово и рамку;
 *  - тонкие линии и приглушённый текст на печати темнее, чем на экране: линия
 *    #E6E1F0 на лазерном принтере пропадает вовсе;
 *  - состояние приёма — знак и слово, а не цвет.
 *
 * Шрифт — Manrope из подмножеств консоли, вшитый в лист (data:). Лист
 * открывается двумя путями, и ни один не видит /fonts консоли: консоль
 * открывает его из памяти (blob:, apps/web/src/api.ts, openInTab), где
 * относительный адрес не разрешается вовсе, а одноразовая ссылка — с адреса
 * API. Внешних адресов у листа нет: CSP консоли закрыт, CDN не бывает. Копия
 * файлов — в apps/api/assets/fonts (образ API не несёт apps/web), совпадение
 * с консолью держит test/printSheet.test.ts.
 *
 * Номер страницы — полями страницы @page (Chrome с версии 131): «Сторінка
 * N з M» внизу каждого листа. Движок без полей страницы (Firefox, Safari)
 * печатает лист без номера, но с подвалом в конце документа — штамп «кто и
 * когда распечатал» есть всегда.
 */

const FONT_DIR = join(import.meta.dir, "../../assets/fonts");

/** Диапазоны — те же, что у консоли (apps/web/src/styles/fonts.css) */
const FONT_FACES: [file: string, range: string][] = [
  ["Manrope-cyrillic.woff2", "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116"],
  [
    "Manrope-latin.woff2",
    "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2190-2193, U+2212, U+2215, U+2248, U+2260, U+2264-2265, U+FEFF, U+FFFD",
  ],
];

let fontCss: string | null = null;

/** @font-face листа: файлы читаются один раз на процесс */
export function sheetFonts(): string {
  if (fontCss !== null) return fontCss;
  fontCss = FONT_FACES.map(([file, range]) => {
    const data = readFileSync(join(FONT_DIR, file)).toString("base64");
    return `@font-face{font-family:"Manrope";src:url(data:font/woff2;base64,${data}) format("woff2");font-weight:400 800;font-style:normal;font-display:block;unicode-range:${range}}`;
  }).join("\n");
  return fontCss;
}

export function esc(v: string): string {
  return v.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

/** Строка для `content:` в CSS: кавычки, обратная косая, перевод строки и «<» (лист внутри <style>) */
export function cssString(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\A ").replace(/</g, "\\3C ")}"`;
}

/* ─────────── ступени выраженности ─────────── */

/**
 * Ступень набора (0…4) для выраженности полосы.
 *
 * Выраженность четырёхступенчатая, а ступеней набора пять: «тяжка» — s4, как
 * у консоли (palette.ts, fourOfFive). Пятая ступень, s3, нужна шкалам вроде
 * PHQ-9, где две полосы подряд — тяжёлые («помірно тяжка» и «тяжка»):
 * менее крайняя из них получает s3, иначе на листе две разные полосы
 * выглядели бы одной (stepsOfBands ниже).
 */
const STEP: Record<Severity, number> = { none: 0, mild: 1, moderate: 2, severe: 4 };

export function stepOf(severity: string | null | undefined): number | null {
  return severity && severity in STEP ? STEP[severity as Severity] : null;
}

/**
 * Ступени полос одной шкалы, по порядку полос.
 *
 * Полосы приходят в порядке баллов. Если тяжёлых несколько, крайней (s4)
 * остаётся та, что дальше всех от лёгких, — у прямой шкалы верхняя, у
 * обратной (WHO-5: меньше — хуже) нижняя; остальные тяжёлые — s3.
 */
export function stepsOfBands(bands: { severity: string | null }[]): (number | null)[] {
  const steps = bands.map((b) => stepOf(b.severity));
  const severe = steps.flatMap((s, i) => (s === 4 ? [i] : []));
  if (severe.length < 2) return steps;
  const calm = steps.flatMap((s, i) => (s === 0 || s === 1 ? [i] : []));
  const calmAt = calm.length ? calm.reduce((a, b) => a + b, 0) / calm.length : -1;
  const extreme = severe.reduce((far, i) => (Math.abs(i - calmAt) > Math.abs(far - calmAt) ? i : far), severe[0]!);
  return steps.map((s, i) => (s === 4 && i !== extreme ? 3 : s));
}

/** Слово выраженности в обводке; без ступени — нейтральной */
export function sevPill(word: string, step: number | null, big = false): string {
  const level = step === null ? "n" : String(step);
  return `<span class="ps-sev l${level}${big ? " big" : ""}">${esc(word)}</span>`;
}

/* ─────────── значки ─────────── */

/*
 * Значки — контуры Lucide (ISC), сетка 24, штрих 2: те же, что у набора.
 * Встроены, а не шрифтом: лист самодостаточен.
 */
const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  badge:
    '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  scissors:
    '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
  calendarX:
    '<path d="M8 2v4"/><path d="M16 2v4"/><path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8"/><path d="M3 10h18"/><path d="m17 22 5-5"/><path d="m17 17 5 5"/>',
  calendarClock:
    '<path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h5"/><path d="M17.5 17.5 16 16.3V14"/><circle cx="16" cy="16" r="6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  userCheck:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>',
  dot: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  fileDown:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>',
  printer:
    '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
  link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/>',
  linkOff: '<path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><path d="M8 12h4"/><path d="m2 2 20 20"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  heart:
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  phone:
    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  trendDown: '<path d="M22 17 13.5 8.5l-5 5L2 7"/><path d="M16 17h6v-6"/>',
  trendUp: '<path d="M22 7 13.5 15.5l-5-5L2 17"/><path d="M16 7h6v6"/>',
  smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  clipboard:
    '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  checkCheck: '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
  timer: '<path d="M10 2h4"/><path d="m12 14 3-3"/><circle cx="12" cy="14" r="8"/>',
  userX:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 8 5 5"/><path d="m22 8-5 5"/>',
  fileCheck:
    '<path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m3 15 2 2 4-4"/>',
  chevrons: '<path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/>',
  repeat: '<path d="m2 9 3-3 3 3"/><path d="M13 18H7a2 2 0 0 1-2-2V6"/><path d="m22 15-3 3-3-3"/><path d="M11 6h6a2 2 0 0 1 2 2v10"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 14): string {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

/**
 * Знак Polypsy — тот же, что у полосы консоли (apps/web/src/shell/Topbar.tsx,
 * Logo): кольцо и буквы P O L S Y. Цвет — currentColor.
 */
export function logo(size = 22): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 70 70" aria-hidden="true"><circle cx="35" cy="35" r="34" fill="none" stroke="currentColor" stroke-width="1.7"/><g fill="currentColor" font-family="Manrope, sans-serif" font-weight="700" text-anchor="middle"><g font-size="30"><text x="15.2" y="46">P</text><text x="54" y="46">Y</text></g><g font-size="17.9"><text x="29.6" y="34">O</text><text x="41.7" y="34">L</text><text x="34.5" y="50">S</text></g></g></svg>`;
}

/* ─────────── части листа ─────────── */

/**
 * Шапка: знак, учреждение и подразделение слева, дата документа справа.
 *
 * Учреждение — из INSTITUTION_NAME / INSTITUTION_UNIT, как и раньше; без
 * них — одно имя системы, но шапка остаётся: лист без шапки — распечатка, а
 * не документ.
 */
export function sheetHead(right: { primary: string; secondary?: string }, opts: { unit?: boolean } = {}): string {
  const name = env.institutionName || "Polypsy";
  const sub = [opts.unit === false ? null : env.institutionUnit, env.institutionName ? "Polypsy" : null]
    .filter(Boolean)
    .join(", ");
  return `<header class="ps-h"><span class="logo">${logo()}</span><span class="org"><b>${esc(name)}</b>${esc(sub)}</span><span class="no"><b>${esc(right.primary)}</b>${right.secondary ? esc(right.secondary) : ""}</span></header>`;
}

/**
 * Сетка фактов под заголовком: подпись над значением, тонкие линии между
 * клетками. Пустые значения не печатаются. Последняя клетка тянется до конца
 * строки — иначе в неполной строке осталась бы пустая серая клетка.
 */
export function facts(pairs: [label: string, value: string | null | undefined][], cols = 3): string {
  const shown = pairs.filter((p): p is [string, string] => !!p[1]);
  if (!shown.length) return "";
  const rest = shown.length % cols;
  const cells = shown.map(([label, value], i) => {
    const span = i === shown.length - 1 && rest ? cols - rest + 1 : 1;
    return `<div${span > 1 ? ` style="grid-column:span ${span}"` : ""}><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
  });
  return `<dl class="ps-facts c${cols}">${cells.join("")}</dl>`;
}

/** Раздел листа: заголовок с подписью справа и тело */
export function section(title: string, body: string, right = "", cls = ""): string {
  const r = right ? `<span class="r">${right}</span>` : "";
  return `<section class="ps-sec${cls ? ` ${cls}` : ""}"><h3>${esc(title)}${r}</h3>${body}</section>`;
}

/**
 * Строка подписей: линия, над которой расписываются рукой, имя и подпись
 * роли под ней. Бумажный экземпляр подписывают рукой даже тогда, когда
 * заключение подписано в системе, — место под подпись не дописывается
 * поверх текста. Печать — пунктирный круг «М. П.».
 */
export function signs(items: { name?: string; caption: string }[], seal: string | null): string {
  const cells = items.map(
    (s) => `<div class="s"><i></i>${s.name !== undefined ? `<b>${s.name ? esc(s.name) : "&nbsp;"}</b>` : ""}${esc(s.caption)}</div>`,
  );
  if (seal) cells.push(`<div class="ps-stamp">${esc(seal)}</div>`);
  const cols = `${items.map(() => "minmax(0,1fr)").join(" ")}${seal ? " 56px" : ""}`;
  return `<div class="ps-signs" style="grid-template-columns:${cols}">${cells.join("")}</div>`;
}

/** Подвал листа: кто и когда распечатал, пометка документа; справа — его короткое имя */
export function sheetFoot(lines: string[], right: string): string {
  return `<footer class="ps-foot"><span>${lines.map(esc).join("<br>")}</span><span class="r"><b>${esc(right)}</b></span></footer>`;
}

/* ─────────── шкала с историей ─────────── */

export interface ScaleBandView {
  min: number;
  max: number;
  step: number | null;
}

/**
 * Шкала выраженности для листа: полосы шкалы (текущая — насыщенной ступенью,
 * остальные — подложкой), текущий балл — тёмная метка с числом над ней,
 * прежние замеры — полые кольца с числами под осью.
 *
 * Полоса тянется от своего начала до начала следующей: у целых баллов
 * «0–4» и «5–9» стыкуются без щели. Значения за пределами 0…max прижимаются
 * к краю — шкала не рисует метку за листом.
 */
export function scaleSvg(max: number, bands: ScaleBandView[], now: number, before: number[], label: string, W = 300, H = 52): string {
  if (!(max > 0)) return "";
  const L = 8;
  const R = W - 8;
  const clamp = (v: number) => Math.min(max, Math.max(0, v));
  const X = (v: number) => L + ((R - L) * clamp(v)) / max;
  const n = (v: number) => (Math.round(v * 10) / 10).toString();
  const ty = 24;
  const sorted = [...bands].sort((a, b) => a.min - b.min);
  const out: string[] = [
    `<svg class="ps-scale" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`,
  ];
  sorted.forEach((b, i) => {
    const from = X(b.min);
    const to = X(i < sorted.length - 1 ? sorted[i + 1]!.min : max);
    const on = now >= b.min && now <= b.max;
    const step = b.step ?? 0;
    const fill = on ? `var(--s${step})` : `var(--s${step}b)`;
    out.push(
      `<rect x="${n(from + 1)}" y="${ty - 4}" width="${n(Math.max(1, to - from - 2))}" height="8" rx="2" style="fill:${fill}${on ? "" : ";stroke:var(--sline);stroke-width:.6"}"/>`,
    );
  });
  if (!sorted.length) out.push(`<rect x="${L}" y="${ty - 4}" width="${R - L}" height="8" rx="2" style="fill:var(--track)"/>`);
  /* края оси подписаны, пока рядом не стоит число прежнего замера — иначе цифры налезают */
  const near = (x: number) => before.some((v) => Math.abs(X(v) - x) < 14);
  if (!near(L)) out.push(`<text x="${L - 2}" y="${ty + 22}" text-anchor="start" class="t-mute">0</text>`);
  if (!near(R)) out.push(`<text x="${R + 2}" y="${ty + 22}" text-anchor="end" class="t-mute">${n(max)}</text>`);
  for (const v of before) {
    out.push(`<circle cx="${n(X(v))}" cy="${ty}" r="4.2" class="ring"/>`);
    out.push(`<text x="${n(X(v))}" y="${ty + 22}" text-anchor="middle" class="t-prev">${n(v)}</text>`);
  }
  const x1 = X(now);
  out.push(`<rect x="${n(x1 - 1.5)}" y="${ty - 9}" width="3" height="18" rx="1.5" class="pin"/>`);
  const tagW = Math.max(24, String(n(now)).length * 7 + 10);
  const tagX = Math.min(W - tagW, Math.max(0, x1 - tagW / 2));
  out.push(`<rect x="${n(tagX)}" y="0" width="${tagW}" height="14" rx="4" class="tag"/>`);
  out.push(`<text x="${n(tagX + tagW / 2)}" y="10.5" text-anchor="middle" class="t-tag">${n(now)}</text>`);
  out.push("</svg>");
  return out.join("");
}

/* ─────────── документ целиком ─────────── */

/**
 * Номер страницы для поля @page: «Сторінка {page} з {pages}» из словаря,
 * разобранная на строки и счётчики CSS.
 */
function pageCounter(lang: Lang): string {
  const raw = serverText("print.pageOf", lang, { page: "\u0001", pages: "\u0002" });
  return raw
    .split(/(\u0001|\u0002)/)
    .filter((part) => part !== "")
    .map((part) => (part === "\u0001" ? "counter(page)" : part === "\u0002" ? "counter(pages)" : cssString(part)))
    .join(" ");
}

const SEV_VARS = SEVERITY_STEPS_SCREEN_LIGHT.map((c, i) => `--s${i}:${c};--s${i}b:${SEVERITY_STEPS_SCREEN_BG_LIGHT[i]}`).join(";");

/** Палитра листа: светлая тема набора, всегда — бумага белая при любой теме экрана */
export const SHEET_VARS = `--ff:"Manrope",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--text:#221A33;--text2:#433A57;--muted:#695F80;--border:#E6E1F0;--divider:#EFEBF5;--ctl:#D4CBE3;--paper:#FFFFFF;--panel2:#FAF8FD;--sunk:#F3EFF9;--desk:#E9E5F0;--track:#E3DCEE;--v:#663399;--vink:#5A2C8E;--vline:#D5C4EB;--vtint:#EFE8F7;--riskink:#B71C1C;--riskline:#F1C1C5;--risktint:#FCEBEC;--warn:#8A5300;--warnline:#EDD6A6;--warntint:#FFF1D9;--good:#2E7D32;--goodline:#C9E1CB;--goodtint:#E7F3E8;--sline:#D4CBE3;${SEV_VARS}`;

/**
 * Стили листа. Пояснения к правилам — здесь, а не комментариями в <style>:
 * комментарий уезжал бы вместе с листом и читался в исходнике страницы.
 *
 *  - .ps-end (подписи и подвал) не отрывается от документа переносом и на
 *    экране прижат к низу листа;
 *  - строки таблиц, клетки фактов, рамки и подписи не рвутся посередине,
 *    заголовок раздела не остаётся последней строкой страницы, шапка
 *    таблицы повторяется на новой странице;
 *  - ширина экрана (viewport): лист открывает и браузер телефона, и без неё
 *    телефон раскладывал бы его на 980 точек мелким шрифтом;
 *  - на печати линии и приглушённый текст темнее (монохромный принтер).
 */
export const SHEET_CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--desk);color:var(--text);font:500 13px/19px var(--ff);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h1,h2,h3,h4,p,dl,dd,ol,ul{margin:0}
ol,ul{padding:0;list-style:none}
b,strong{font-weight:800}
.ic{display:inline-block;flex-shrink:0;vertical-align:-2px}
.mute{color:var(--muted)}
.t2{color:var(--text2)}
.ps{width:210mm;min-height:297mm;margin:32px auto;display:flex;flex-direction:column;padding:48px 60px 44px;background:var(--paper);color:var(--text);box-shadow:0 30px 60px -30px rgba(34,26,51,.45),0 0 0 1px rgba(34,26,51,.06)}
.ps-h{display:flex;align-items:center;gap:12px;padding-bottom:14px;border-bottom:1.5px solid var(--text)}
.ps-h .logo{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;flex-shrink:0;color:var(--v);box-shadow:inset 0 0 0 1px var(--border)}
.ps-h .org{font-size:12px;line-height:16px;color:var(--text2)}
.ps-h .org b{display:block;font-size:13px;color:var(--text)}
.ps-h .no{margin-left:auto;text-align:right;font-size:12px;line-height:16px;color:var(--text2)}
.ps-h .no b{display:block;font-size:14px;color:var(--text)}
.ps-t{margin-top:24px;font:800 22px/28px var(--ff);letter-spacing:-.02em}
.ps-sub{margin-top:4px;font-size:13px;line-height:19px;color:var(--text2)}
.ps-lead{margin-top:24px;font-size:15px;line-height:24px}
.ps-facts{display:grid;gap:1px;margin-top:14px;background:var(--border);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.ps-facts.c3{grid-template-columns:repeat(3,minmax(0,1fr))}
.ps-facts.c4{grid-template-columns:repeat(4,minmax(0,1fr))}
.ps-facts.c2{grid-template-columns:repeat(2,minmax(0,1fr))}
.ps-facts>div{padding:5px 12px 6px;background:var(--paper);min-width:0}
.ps-facts dt{font-size:11px;line-height:14px;font-weight:600;color:var(--muted)}
.ps-facts dd{margin-top:1px;font-size:12.5px;line-height:17px;font-weight:700;overflow-wrap:anywhere}
.ps-sec{margin-top:16px}
.ps-sec>h3{display:flex;align-items:baseline;gap:12px;padding-bottom:5px;margin-bottom:8px;border-bottom:1px solid var(--border);font:800 13.5px/18px var(--ff)}
.ps-sec>h3 .r{margin-left:auto;font:600 11.5px/16px var(--ff);color:var(--muted);text-align:right}
.ps-sec>h3 .r .ic{color:var(--good)}
.ps-sec p,.ps-text{font-size:13px;line-height:20px}
.ps-text{white-space:pre-wrap;overflow-wrap:anywhere}
.ps-tbl .ps-text{font-size:inherit;line-height:inherit}
.ps-tbl{width:100%;border-collapse:collapse;font-size:11.5px;line-height:15px}
.ps-tbl th{padding:0 6px 5px;text-align:left;font:700 11px/14px var(--ff);color:var(--text2);border-bottom:1px solid var(--text);vertical-align:bottom}
.ps-tbl td{padding:4px 6px;border-bottom:1px solid var(--border);vertical-align:top;overflow-wrap:anywhere}
.ps-tbl th:first-child,.ps-tbl td:first-child{padding-left:0}
.ps-tbl th:last-child,.ps-tbl td:last-child{padding-right:0}
.ps-tbl .num{text-align:right;white-space:nowrap}
.ps-tbl .nw{white-space:nowrap}
.ps-tbl .c{text-align:center}
.ps-tbl .ans{width:30%}
.ps-tbl td.no,.ps-tbl th.no{width:24px;color:var(--muted);font-weight:700}
.ps-tbl.mid td{vertical-align:middle}
.ps-tbl tr.crit td{color:var(--riskink)}
.ps-tbl tr.crit td.no{color:var(--riskink)}
.ps-tbl .ck{display:inline-flex;align-items:center;gap:4px;margin-top:2px;font-weight:800}
.ps-sev{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:10px;border:1px solid currentColor;font:700 11px/1 var(--ff);white-space:nowrap}
.ps-sev.big{height:22px;padding:0 9px;font-size:11.5px}
.ps-sev.l0{color:var(--s0)}.ps-sev.l1{color:var(--s1)}.ps-sev.l2{color:var(--s2)}.ps-sev.l3{color:var(--s3)}.ps-sev.l4{color:var(--s4)}.ps-sev.ln{color:var(--text2)}
.ps-res{display:grid;grid-template-columns:120px minmax(0,300px) minmax(0,1fr);gap:18px;align-items:center;margin-top:12px;padding:8px 14px 8px 16px;border:1px solid var(--border);border-radius:10px}
.ps-res+.ps-res{margin-top:8px}
.ps-big{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0}
.ps-big .nm{font-size:11.5px;line-height:15px;font-weight:700;color:var(--text2)}
.ps-big .v{display:flex;align-items:baseline;gap:6px}
.ps-big .v b{font:800 40px/1 var(--ff);letter-spacing:-.03em}
.ps-big .v span{font-size:13px;font-weight:600;color:var(--muted)}
.ps-scale{display:block;max-width:100%;height:auto;overflow:visible}
.ps-scale text{font-family:var(--ff);font-variant-numeric:tabular-nums;font-size:10.5px}
.ps-scale .t-mute{fill:var(--muted);font-weight:600}
.ps-scale .t-prev{fill:var(--text2);font-weight:700}
.ps-scale .t-tag{fill:var(--paper);font-weight:800}
.ps-scale .ring{fill:var(--paper);stroke:var(--text2);stroke-width:1.6}
.ps-scale .pin{fill:var(--text);stroke:var(--paper);stroke-width:1.5;paint-order:stroke}
.ps-scale .tag{fill:var(--text)}
.ps-mini{display:grid;gap:2px;font-size:11.5px;line-height:15px}
.ps-mini>div{display:flex;justify-content:space-between;gap:10px}
.ps-mini dt{color:var(--muted);font-weight:600}
.ps-mini dd{font-weight:800;text-align:right;white-space:nowrap}
.ps-legend{margin-top:6px;font-size:11.5px;line-height:16px;color:var(--text2)}
.ps-box{padding:10px 14px;border:1px solid var(--border);border-radius:10px}
.ps-box h4{display:flex;align-items:center;gap:6px;font:800 12.5px/18px var(--ff);margin-bottom:2px}
.ps-box p{font-size:12.5px;line-height:19px}
.ps-box.rk{border-color:var(--riskline)}
.ps-box.rk h4{color:var(--riskink)}
.ps-li{display:flex;flex-direction:column;gap:3px;font-size:12.5px;line-height:18px}
.ps-li>span{display:flex;gap:8px}
.ps-note{margin-top:12px;font-size:11px;line-height:16px;color:var(--muted)}
.ps-plain{display:flex;gap:8px;margin-top:12px;font-size:12px;line-height:18px;color:var(--text2)}
.ps-plain .ic{margin-top:2px}
.ps-st{display:inline-flex;align-items:center;gap:4px;font-weight:700;font-size:11.5px;color:var(--text2);white-space:nowrap}
.ps-st .ic{color:var(--muted)}
.ps-st.ok .ic{color:var(--good)}
.ps-st.wn,.ps-st.wn .ic{color:var(--warn)}
.ps-st.v,.ps-st.v .ic{color:var(--vink)}
.ps-st.off{color:var(--muted)}
.ps-cols{columns:2;column-gap:24px}
.ps-row{display:grid;grid-template-columns:100px minmax(0,1fr) auto;gap:4px 10px;align-items:start;padding:4px 0;border-bottom:1px solid var(--border);font-size:11.5px;line-height:15px;break-inside:avoid}
.ps-row>:last-child{text-align:right}
.ps-empty{font-size:12.5px;line-height:19px;color:var(--muted)}
.ps-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 24px;align-items:start}
.ps-end{margin-top:auto;padding-top:14px}
.ps-signs{display:grid;gap:28px;margin-top:8px;align-items:end}
.ps-signs .s{font-size:11.5px;line-height:16px;color:var(--text2);min-width:0}
.ps-signs .s i{display:block;height:20px;border-bottom:1px solid var(--text);margin-bottom:6px}
.ps-signs .s b{display:block;font-size:12.5px;color:var(--text)}
.ps-stamp{width:56px;height:56px;border-radius:50%;border:1.5px dashed var(--ctl);display:grid;place-items:center;font:700 11px/14px var(--ff);color:var(--muted);text-align:center}
.ps-foot{display:flex;gap:16px;align-items:flex-end;margin-top:18px;padding-top:12px;border-top:1px solid var(--border);font-size:11px;line-height:15px;color:var(--muted)}
.ps-foot .r{margin-left:auto;text-align:right;white-space:nowrap}
.ps-foot .r b{display:block;color:var(--text2);font-weight:700}
.ps-cut{display:flex;align-items:center;gap:8px;margin-top:28px;font-size:11px;line-height:14px;font-weight:600;color:var(--muted);white-space:nowrap}
.ps-cut i{flex:1;border-top:1px dashed var(--ctl)}
.ps-stub{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:28px;align-items:end}
.ps-stub dl{display:grid;grid-template-columns:110px minmax(0,1fr);gap:4px 12px;font-size:12px;line-height:17px}
.ps-stub dt{color:var(--muted);font-weight:600}
.ps-stub dd{font-weight:700}
@media screen and (max-width:820px){
  body{background:var(--paper)}
  .ps{width:auto;min-height:0;margin:0;padding:20px 16px 28px;box-shadow:none}
  .ps-facts.c3,.ps-facts.c4{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ps-facts>div{grid-column:auto!important}
  .ps-res{grid-template-columns:minmax(0,1fr);gap:10px}
  .ps-cols{columns:1}
  .ps-two{grid-template-columns:minmax(0,1fr)}
  .ps-stub{grid-template-columns:minmax(0,1fr)}
  .ps-tbl{font-size:12px}
}
@media screen and (max-width:480px){
  .ps-facts.c2,.ps-facts.c3,.ps-facts.c4{grid-template-columns:minmax(0,1fr)}
  .ps-signs{grid-template-columns:minmax(0,1fr)!important;gap:18px}
}
@media print{
  :root{--border:#B1A8C2;--divider:#C9C2D6;--muted:#4C4262;--text2:#30283F;--ctl:#8C83A0;--sline:#8C83A0}
  html,body{background:#fff}
  .ps{width:auto;min-height:0;margin:0;padding:0;box-shadow:none;display:block}
  .ps-end{margin-top:6px}
  .ps-t{margin-top:16px}
  .ps-sec{margin-top:12px}
  .ps-res{margin-top:10px}
  .ps-tbl td{padding-top:3px;padding-bottom:3px}
  .ps-foot{margin-top:12px;padding-top:8px}
  .no-print{display:none!important}
  thead{display:table-header-group}
  tr,.ps-row,.ps-box,.ps-res,.ps-facts,.ps-signs,.ps-end,.ps-stub,.ps-cut{break-inside:avoid}
  .ps-end{break-before:avoid}
  .fit .ps{display:flex;flex-direction:column;min-height:266mm}
  .fit .ps-end{margin-top:auto}
  .ps-sec>h3,.ps-t,.ps-sub{break-after:avoid}
}
`;

/**
 * Поля страницы на печати: внизу слева — о чём лист (имя документа и
 * человека, чтобы выпавший из стопки лист нашёл своё дело), внизу справа —
 * номер страницы.
 */
export function pageRules(lang: Lang, running: string): string {
  const box = `font-family:"Manrope",system-ui,sans-serif;font-size:7.5pt;line-height:1.35;color:#4C4262;vertical-align:top;padding-top:4mm`;
  return `@page{size:A4;margin:12mm 14mm 16mm;@bottom-left{content:${cssString(running)};${box};text-align:left}@bottom-right{content:${pageCounter(lang)};${box};text-align:right;font-weight:700}}`;
}

/** HTML-документ листа: шрифты, палитра, стили листа и свои */
export function sheetDocument(opts: {
  lang: Lang;
  title: string;
  running: string;
  body: string;
  css?: string;
  bodyAttrs?: string;
}): string {
  return `<!doctype html>
<html lang="${opts.lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<style>
${sheetFonts()}
:root{${SHEET_VARS}}
${SHEET_CSS}
${pageRules(opts.lang, opts.running)}
${opts.css ?? ""}
</style></head>
<body${opts.bodyAttrs ? ` ${opts.bodyAttrs}` : ""}>
${opts.body}
</body></html>`;
}
