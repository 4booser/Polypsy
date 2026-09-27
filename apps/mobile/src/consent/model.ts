/**
 * Экран информированного согласия — модель состояний и выходов.
 *
 * Переехала в packages/shared/src/consentFlow.ts: тот же экран появился в
 * веб-кабинете, и тот же дефект («Не погоджуюся» молча выходит из учётной
 * записи) нашёлся там заново. Здесь — прежние имена, чтобы экран
 * (app/consent.tsx) и проверка (test/consent.test.ts) не менялись.
 */
export {
  consentActionsOf as actionsOf,
  consentViewOf as viewOfStatus,
  consentViewOfLoadError as viewOfLoadError,
  type ConsentAction,
  type ConsentStatus,
  type ConsentView,
} from "@quizzy/shared";
