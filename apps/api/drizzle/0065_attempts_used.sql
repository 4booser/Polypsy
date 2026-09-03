-- Счётчик потраченных попыток.
--
-- Проверка «сколько прохождений уже есть» неустранимо гоночная: две
-- одновременные отправки — пациент дважды нажал «отправить», клиент повторил
-- по таймауту — обе видят «использовано 0 из 1» и обе проходят. В базе
-- оказываются два завершённых прохождения при одной разрешённой попытке, и
-- второе попадает в динамику, в RCI и в выборку норм.
ALTER TABLE survey_access ADD COLUMN IF NOT EXISTS attempts_used integer NOT NULL DEFAULT 0;

-- Уже сделанные прохождения после выдачи назначения считаются потраченными:
-- иначе включение счётчика молча вернуло бы всем по лишней попытке.
UPDATE survey_access sa
   SET attempts_used = (
     SELECT count(*) FROM responses r
      WHERE r.user_id = sa.user_id
        AND r.survey_id = sa.survey_id
        AND r.status = 'completed'
        AND r.submitted_at > sa.granted_at
   )
 WHERE sa.attempts_allowed IS NOT NULL;
