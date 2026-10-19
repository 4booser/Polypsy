/**
 * @quizzy/shared — та часть, что нужна приложению (волна 27).
 *
 * Общий пакет отдаёт всё одним входом (packages/shared/src/index.ts), а
 * Metro неиспользованное не вытряхивает: приложение везло в сборке и
 * вычисляло на старте то, чего не зовёт ни один его экран, — тексты ошибок
 * и сообщений сервера (errorStrings, serverStrings), права консоли, zod со
 * схемами входа API и техпанели (они ещё и строятся при загрузке модуля),
 * медстатистику, сетку приёмного дня.
 *
 * `@quizzy/shared` в приложении — этот файл (tsconfig.json, paths: по нему
 * идут и tsc, и Metro, и bun test). Значения — только из модулей ниже.
 * Понадобилось значение или тип из модуля, которого здесь нет, — компилятор
 * скажет «has no exported member», и модуль (или тип) дописывается сюда;
 * test/sharedSubset.test.ts сверяет, что всё, что берут экраны, на месте, и
 * что лишнее в сборку не вернулось.
 *
 * Внутренние импорты пакета (risk → scoring → types) идут относительными
 * путями и сюда не смотрят.
 */
export * from "../../../packages/shared/src/types";
export * from "../../../packages/shared/src/uiStrings";
export * from "../../../packages/shared/src/scoring";
export * from "../../../packages/shared/src/risk";
export * from "../../../packages/shared/src/serviceStatus";
export * from "../../../packages/shared/src/rci";
export * from "../../../packages/shared/src/dynamicsPoint";
export * from "../../../packages/shared/src/palette";
export * from "../../../packages/shared/src/format";
export * from "../../../packages/shared/src/usage";
export * from "../../../packages/shared/src/telemetry";
export * from "../../../packages/shared/src/consentFlow";

/*
 * Типы входа API — без самих схем: тип стирается при сборке, и zod за ним
 * не едет. Не `export type *`: такой реэкспорт рядом с значениями роняет
 * tsc 6.0 (внутренняя ошибка getTypeOnlyAliasDeclaration) вместо понятного
 * «нет такого значения».
 */
export type {
  CreateSurveyInput,
  CreateUserInput,
  GroupInput,
  UpdateProfileInput,
  UpdateSurveyInput,
} from "../../../packages/shared/src/schemas";
export type { ScreenViewsInput } from "../../../packages/shared/src/wireSchemas";
