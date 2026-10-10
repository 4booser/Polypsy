import { createSurveySchema, createVersion, db, encryptPersonFields, eq, groupAdmins, root, sql, surveyGroups, surveys } from "./fixtures";
import { inArray } from "drizzle-orm";
import { options, questions, scales, surveyVersions } from "../src/db/schema";

/**
 * Методика с десятками тысяч прохождений — для проверок на объёме.
 *
 * Методика заводится обычным конвейером (createVersion), а люди,
 * прохождения, ответы и баллы — одной вставкой из generate_series на
 * таблицу: по одной строке через приложение 70 тыс. прохождений шли бы
 * минутами, а проверяется здесь не сдача, а то, что с ними потом делают.
 * Ключи — строки с меткой вызова: тексты, не uuid, и соседям не мешают.
 */

export interface MassSurvey {
  tag: string;
  surveyId: string;
  groupId: string;
  versionId: string;
  scaleId: string;
  /** по позиции пункта: id пункта и id его четырёх вариантов */
  items: { id: string; options: string[] }[];
}

export async function massSurvey(tag: string, items: number, adminId: string): Promise<MassSurvey> {
  const groupId = `${tag}-group`;
  const surveyId = `${tag}-survey`;
  await db.insert(surveyGroups).values({ id: groupId, title: `Обсяг ${tag}`, createdBy: root.id });
  await db.insert(groupAdmins).values({ groupId, userId: adminId, addedBy: root.id });
  await db.insert(surveys).values({
    id: surveyId,
    groupId,
    title: { uk: `Обсяг ${tag}` },
    administration: "self",
    status: "published",
    publishedAt: "2025-01-01T00:00:00.000Z",
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminId,
  } as never);
  await createVersion(
    surveyId,
    createSurveySchema.parse({
      title: { uk: `Обсяг ${tag}` },
      administration: "self",
      scoringEnabled: true,
      allowRetake: true,
      visibility: "public",
      scales: [{ code: "S", title: { uk: "Сума" }, aggregation: "sum" }],
      questions: Array.from({ length: items }, (_, i) => ({
        type: "single",
        title: { uk: `Пункт ${i + 1}` },
        scaleCode: "S",
        options: [0, 1, 2, 3].map((score) => ({ text: { uk: `${score}` }, score })),
      })),
    }),
    adminId,
    "v1",
  );
  const [version] = await db.select().from(surveyVersions).where(eq(surveyVersions.surveyId, surveyId));
  const [scale] = await db.select().from(scales).where(eq(scales.versionId, version!.id));
  const qs = (await db.select().from(questions).where(eq(questions.versionId, version!.id))).sort(
    (a, b) => a.position - b.position,
  );
  const opts = await db.select().from(options).where(inArray(options.questionId, qs.map((q) => q.id)));
  const list = qs.map((q) => ({
    id: q.id,
    options: opts
      .filter((o) => o.questionId === q.id)
      .sort((a, b) => a.position - b.position)
      .map((o) => o.id),
  }));
  return { tag, surveyId, groupId, versionId: version!.id, scaleId: scale!.id, items: list };
}

/**
 * Прохождения с номерами [from, from + count): у каждого ответ на каждый
 * пункт и балл шкалы. Люди — `people` человек по кругу, с полом и
 * датой рождения (зашифрованной, как в бою), заводятся при первом вызове.
 */
export async function massResponses(s: MassSurvey, from: number, count: number, people: number): Promise<void> {
  const { tag } = s;
  const [{ n } = { n: 0 }] = (await db.execute(
    sql`select count(*)::int as n from users where id like ${`${tag}-u%`}`,
  )) as unknown as { n: number }[];
  if (!n) {
    const name = encryptPersonFields({ firstName: "Обсяг", lastName: "Посів" });
    const births = ["1961-03-04", "1975-11-30", "1988-07-15", "1996-01-20", "2003-09-09"].map(
      (d) => encryptPersonFields({ birthDate: d }).birthDate,
    );
    await db.execute(sql`
      insert into users (id, email, password_hash, first_name, last_name, role, sex, birth_date)
      select ${tag} || '-u' || g, ${tag} || '-u' || g || '@mass.test', 'посів-без-входу',
             ${name.firstName}, ${name.lastName}, 'user',
             case when g % 2 = 0 then 'male' else 'female' end,
             ${JSON.stringify(births)}::jsonb ->> (g % 5)
      from generate_series(1, ${people}::int) g`);
  }
  await db.execute(sql`
    insert into responses (id, survey_id, user_id, status, version_id, started_at, submitted_at,
                           duration_ms, respondent_sex, respondent_age_band, reliable)
    select ${tag} || '-r' || g, ${s.surveyId}, ${tag} || '-u' || (1 + g % ${people}::int), 'completed', ${s.versionId},
           timestamptz '2025-01-01 00:00+00' + g * interval '7 minutes',
           timestamptz '2025-01-01 00:00+00' + g * interval '7 minutes' + interval '90 seconds',
           60000 + (g % 997) * 37,
           case when g % 2 = 0 then 'male' else 'female' end,
           (array['<25', '25-34', '35-44', '45+'])[1 + g % 4],
           g % 50 <> 0
    from generate_series(${from}::int, ${from + count - 1}::int) g`);
  await db.execute(sql`
    insert into answers (id, response_id, question_id, option_ids, score, duration_ms, change_count)
    select ${tag} || '-r' || g || '-a' || q.i, ${tag} || '-r' || g, q.x ->> 'id',
           jsonb_build_array(q.x -> 'options' ->> ((g + q.i) % 4)::int), ((g + q.i) % 4),
           500 + ((g * 7 + q.i * 13) % 4000), (g + q.i) % 3
    from generate_series(${from}::int, ${from + count - 1}::int) g,
         jsonb_array_elements(${JSON.stringify(s.items)}::jsonb) with ordinality as q(x, i)`);
  await db.execute(sql`
    insert into response_scores (id, response_id, scale_id, raw_score, value, normalization, max_score, percent, normalized)
    select ${tag} || '-r' || g || '-s', ${tag} || '-r' || g, ${s.scaleId}, g % 10, g % 10, 'raw', 30, (g % 10) * 10, true
    from generate_series(${from}::int, ${from + count - 1}::int) g`);
  /*
   * Статистика — сразу, а не когда до неё дойдёт autovacuum. Без неё
   * планировщик считает свежезалитые полмиллиона ответов пустой таблицей,
   * выбирает по ней полный просмотр на каждую порцию выгрузки — и замер
   * времени зависел от того, успел ли autovacuum (в прогоне test:app-role
   * выгрузка 20 тыс. × 20 шла 13,7 с вместо двух). В бою у таблиц
   * статистика есть всегда.
   */
  await db.execute(sql`analyze users, responses, answers, response_scores`);
}

/**
 * Убрать посев целиком — в afterAll файла, который его завёл.
 *
 * Файлы сюиты идут одним процессом по одной базе, и объём остаётся тем,
 * кто придёт следом: обходы «каждый GET под ролью приложения» и сводки по
 * всей базе на лишних десятках тысяч прохождений упирались в свои
 * таймауты. Прохождения, ответы и баллы уходят каскадом от методики.
 */
export async function dropMass(s: MassSurvey): Promise<void> {
  await db.execute(sql`delete from surveys where id = ${s.surveyId}`);
  await db.execute(sql`delete from users where id like ${`${s.tag}-u%`}`);
  await db.execute(sql`delete from survey_groups where id = ${s.groupId}`);
}
