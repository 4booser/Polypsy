export * from "./types";
export * from "./schemas";
/* дата снаружи: строгий ISO, который база прочтёт так же (волна 12, integrity) */
export * from "./dates";
export * from "./scoring";
/* оценка сдачи целиком: отбор ответов, профиль и риск — общая для сервера и клиентов */
export * from "./risk";
export * from "./validate";
export * from "./phone";
export * from "./uiStrings";
export * from "./errorStrings";
export * from "./pushStrings";
/* тексты, которые собирает сервер или общий пакет, — на языке смотрящего (волна 13, srv-i18n) */
export * from "./serverStrings";
export * from "./permissions";
/* техпанель, эксплуатация: состояние системы и флаги функций */
export * from "./serviceStatus";
export * from "./featureFlags";
export * from "./rci";
export * from "./medstats";
export * from "./versionDiff";
export * from "./palette";
export * from "./format";
export * from "./rules";
export * from "./equating";
export * from "./kanon";
export * from "./usage";
/* схемы входа техпанели — отдельно от чистых функций, которые консоль грузит сразу */
export * from "./wireSchemas";
export * from "./telemetry";
/* экран информированного согласия: состояния и выходы — общие для приложения и веб-кабинета */
export * from "./consentFlow";
