import { z } from "zod";
import { DATE_ERROR_KEY, isDateInput } from "./dates";
import { SERVICE_STATUSES } from "./serviceStatus";
import { SCREEN_APPS, SCREEN_ROUTE_MAX, isRouteTemplate } from "./usage";

/*
 * Схемы входа двух маршрутов техпанели — отдельно от модулей, чьи чистые
 * функции нужны консоли с первой секунды.
 *
 * Волна 12, разбор кода («весь бандл консоли загружался одним файлом»):
 * консоль при загрузке зовёт isRouteTemplate (счётчики экранов) и
 * isTransientStatus (баннер обслуживания), а схемы сервера лежали в тех же
 * модулях. Вызов z.object() на верхнем уровне модуля сборщик обязан
 * считать побочным эффектом и потому вёз в начальный кусок консоли весь
 * zod — пятую часть этого куска по весу, — хотя консоль не разбирает им
 * ничего. Здесь схемы стоят в модуле, которого консоль не касается; для
 * сервера и мобилки ничего не меняется — пакет отдаёт те же имена
 * (index.ts → export *).
 */

/**
 * Объявление из техпанели: новое состояние, текст для людей и когда
 * ожидается конец.
 *
 * Текст — для людей, а не для журнала: его читают на баннере и на странице
 * статуса все, включая пациентов, поэтому длина ограничена одной-двумя
 * фразами. Время конца — момент с поясом, а не «через час»: объявление
 * переживает перезапуск, а «через час» от чего — после перезапуска уже не
 * сказать.
 */
export const serviceStatusInputSchema = z.object({
  status: z.enum(SERVICE_STATUSES),
  message: z.string().trim().max(500).nullish(),
  /*
   * datetime() zod пропускает нулевой год, а PostgreSQL его не знает:
   * «0000-01-01T00:00:00Z» доезжало до колонки пятисоткой. Вторая проверка —
   * та же, что у всех дат снаружи (dates.ts).
   */
  expectedEnd: z
    .string()
    .datetime({ offset: true })
    .refine((v) => isDateInput(v), { message: "ожидается существующий момент ISO 8601", params: { errorKey: DATE_ERROR_KEY } })
    .nullish(),
});

export type ServiceStatusInput = z.output<typeof serviceStatusInputSchema>;

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
            route: z.string().max(SCREEN_ROUTE_MAX).refine(isRouteTemplate, {
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
