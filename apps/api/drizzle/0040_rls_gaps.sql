-- Четыре таблицы с данными о людях остались без политик.
--
-- Проверка полноты RLS существовала, но список таблиц был вписан в неё
-- руками — и устарел. Она проверяла восемь названий, а таблиц с данными о
-- людях стало больше: телеметрия ответов, назначения батарей, согласия и
-- участники киоск-сеансов прошли мимо страховочной сетки.
--
-- Политики зеркалят те, что уже есть у прохождений: сам человек видит своё,
-- сотрудник — тех, кого вправе видеть.

alter table answer_events enable row level security;
drop policy if exists answer_events_access on answer_events;
create policy answer_events_access on answer_events
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or exists (
      select 1 from responses r
      where r.id = answer_events.response_id
        and (
          r.user_id = nullif(current_setting('app.user_id', true), '')
          or rls_admin_sees_survey(r.survey_id)
        )
    )
  );

alter table battery_assignments enable row level security;
drop policy if exists battery_assignments_access on battery_assignments;
create policy battery_assignments_access on battery_assignments
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or user_id = nullif(current_setting('app.user_id', true), '')
    or rls_admin_sees_patient(user_id)
  );

alter table consents enable row level security;
drop policy if exists consents_access on consents;
create policy consents_access on consents
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or user_id = nullif(current_setting('app.user_id', true), '')
    or rls_admin_sees_patient(user_id)
  );

alter table kiosk_participants enable row level security;
drop policy if exists kiosk_participants_access on kiosk_participants;
create policy kiosk_participants_access on kiosk_participants
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or user_id = nullif(current_setting('app.user_id', true), '')
    or rls_admin_sees_patient(user_id)
  );
