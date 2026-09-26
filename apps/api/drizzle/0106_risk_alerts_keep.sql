-- Тревога не уходит вместе с черновиком (волна 12, клиническое ревью).
--
-- risk_alerts.response_id стоял на ON DELETE CASCADE. Автосохранение
-- черновика поднимает тревогу раньше сдачи — дежурный видит критический
-- ответ, пока человек ещё отвечает, и может выписать направление. Сдача же
-- удаляла черновик, и каскад уносил эти тревоги: случай оставался без
-- сигналов, у направления alert_id становился NULL (referrals — SET NULL).
--
-- Теперь сдача переносит тревоги черновика на итоговое прохождение
-- (routes/responses.ts, adoptDraftAlerts), а база больше не даёт удалить
-- прохождение с тревогами молча: RESTRICT. SET NULL невозможен и не нужен —
-- тревога без прохождения не читается (не видно, на что отвечали).
--
-- Удаление методики целиком (bun run survey:purge) по-прежнему проходит:
-- тревоги уходят каскадом по survey_id в том же операторе (проверено тестом
-- в submitIntegrity.test.ts).
ALTER TABLE "risk_alerts" DROP CONSTRAINT IF EXISTS "risk_alerts_response_id_responses_id_fk";
--> statement-breakpoint
ALTER TABLE "risk_alerts" ADD CONSTRAINT "risk_alerts_response_id_responses_id_fk"
  FOREIGN KEY ("response_id") REFERENCES "public"."responses"("id") ON DELETE restrict ON UPDATE no action;
