-- Подписи концов шкалы становятся локализованными.
--
-- Их видит пациент во время прохождения: «0 — Не мешала … 10 — Мешала
-- критически». Хранились они простой строкой, то есть на одном языке, — и в
-- украинском режиме человек читал русские подписи под украинским вопросом.
--
-- Существующие значения переносятся в русское поле: они и были русскими.
-- Записать их сразу в оба языка значило бы объявить перевод там, где его
-- никто не делал.
alter table questions alter column min_label type jsonb
  using case when min_label is null then null else jsonb_build_object('ru', min_label) end;
alter table questions alter column max_label type jsonb
  using case when max_label is null then null else jsonb_build_object('ru', max_label) end;
