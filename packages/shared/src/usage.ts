import { z } from "zod";

/**
 * Телеметрия открытия экранов — общая часть клиента и сервера.
 *
 * Что это и чего это НЕ: счётчик «какой экран открывали», по маршруту-
 * шаблону и по дню. Не адрес, не человек, не текст. `/patients/:userId` —
 * да, `/patients/8c1f…` — никогда: адрес с идентификатором говорит, ЧЬЮ
 * карточку открывали, и счётчик превратился бы во второй журнал чтений,
 * только без хэш-цепочки и без права audit.read.
 *
 * Правило проверки живёт здесь, а не только на сервере: клиент прогоняет
 * шаблон через ту же функцию до отправки и не шлёт того, что сервер всё
 * равно отвергнет. Сервер при этом проверяет сам — клиент бывает старым,
 * чужим или сломанным.
 */

/** Откуда пришёл счётчик: консоль персонала, кабинет пациента, мобильное приложение */
export const SCREEN_APPS = ["console", "patient", "mobile"] as const;
export type ScreenApp = (typeof SCREEN_APPS)[number];

/** Самый длинный шаблон консоли — /surveys/:id/responses/:rid/charts, 35 знаков; 120 с запасом */
const ROUTE_MAX = 120;

/*
 * Сегмент шаблона — одно из трёх:
 *   — статичное слово строчными латинскими буквами и дефисами (`patients`,
 *     `my-schedule`, `patient-groups`);
 *   — параметр `:имя` (`:userId`, `:rid`);
 *   — звёздочка хвоста (`*`).
 *
 * Цифр в статичных сегментах маршрутов консоли нет ни одного, и это правило
 * закрывает главное: идентификаторы — UUID, числа, коды приглашений — почти
 * всегда содержат цифры. «Почти» закрывает вторая проверка ниже: сегмент
 * длиннее 24 знаков или похожий на шестнадцатеричную строку отвергается, даже
 * если цифр в нём случайно не оказалось.
 */
const STATIC = /^[a-z][a-z-]{0,23}$/;
const PARAM = /^:[A-Za-z][A-Za-z0-9]{0,23}$/;
/** 8+ шестнадцатеричных подряд — примета идентификатора, а не слова */
const HEXISH = /^[a-f-]{8,}$/;

/**
 * Шаблон маршрута, а не адрес: можно ли такое хранить.
 *
 * Корень `/` — законный шаблон (стартовый экран). Пустые сегменты (`//`) и
 * хвостовая косая — нет: у шаблона их не бывает, а у склеенного руками
 * адреса бывают.
 */
export function isRouteTemplate(route: string): boolean {
  if (typeof route !== "string" || route.length === 0 || route.length > ROUTE_MAX) return false;
  if (route === "/") return true;
  if (!route.startsWith("/") || route.endsWith("/")) return false;
  const parts = route.slice(1).split("/");
  return parts.every((p) => {
    if (p === "*") return true;
    if (PARAM.test(p)) return true;
    return STATIC.test(p) && !HEXISH.test(p);
  });
}

/**
 * Пачка счётчиков от клиента.
 *
 * `.strict()` на обоих уровнях — не педантизм. Лишнее поле в телеметрии —
 * это место, куда однажды положат «заодно» адрес, имя экрана с фамилией или
 * текст поиска. Отказ на лишнем поле делает такую правку громкой: она падает
 * в первом же прогоне, а не тихо копит персональные данные в таблице, которую
 * никто не читает глазами.
 */
export const screenViewsSchema = z
  .object({
    views: z
      .array(
        z
          .object({
            app: z.enum(SCREEN_APPS),
            route: z.string().max(ROUTE_MAX).refine(isRouteTemplate, {
              message: "route must be a route template (/patients/:userId), not an address",
            }),
            count: z.number().int().min(1).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export type ScreenViewsInput = z.infer<typeof screenViewsSchema>;

/** Больше полусотни строк сервер в одной пачке не примет (screenViewsSchema) */
const BATCH_ROWS = 50;
/** Потолок одного счётчика в пачке */
const COUNT_MAX = 1000;

/**
 * Пачка счётчиков: открытия копятся в памяти и уходят разом — из консоли,
 * кабинета и мобильного приложения одинаково, поэтому здесь, а не в каждом.
 *
 * Не запрос на каждый переход: консоль — это сотни переходов за смену, и
 * запрос на каждый удвоил бы разговор с сервером ради счётчика, который
 * никому не нужен с точностью до секунды.
 */
export class ScreenBatch {
  private counts = new Map<string, { app: ScreenApp; route: string; count: number }>();

  /** Шаблон, не прошедший isRouteTemplate, не копится вовсе: сервер его всё равно отвергнет */
  add(app: ScreenApp, route: string): void {
    if (!isRouteTemplate(route)) return;
    const key = `${app}\u0000${route}`;
    const row = this.counts.get(key);
    if (row) row.count = Math.min(COUNT_MAX, row.count + 1);
    else this.counts.set(key, { app, route, count: 1 });
  }

  /** Сколько открытий накоплено */
  views(): number {
    let n = 0;
    for (const r of this.counts.values()) n += r.count;
    return n;
  }

  /** Забрать накопленное пачками по размеру сервера; пусто — пустой список */
  take(): ScreenViewsInput[] {
    const rows = [...this.counts.values()];
    this.counts.clear();
    const out: ScreenViewsInput[] = [];
    for (let i = 0; i < rows.length; i += BATCH_ROWS) out.push({ views: rows.slice(i, i + BATCH_ROWS) });
    return out;
  }
}

/**
 * Сравнение версий приложения: «1.10.0» новее «1.9.3».
 *
 * Строкой их сравнивать нельзя — «1.10» лексикографически меньше «1.9», и
 * свежая сборка числилась бы устаревшей. Нечисловые хвосты («1.2.0-beta»)
 * отбрасываются: сборка с хвостом считается той же версией, что без него, —
 * для вопроса «на старой ли сборке человек» этого достаточно.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .split(/[.+-]/)
      .slice(0, 4)
      .map((x) => Number.parseInt(x, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
