import { SMALL_CELL_FLOOR, suppressedKeys } from "../lib/privacy";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { facetQuery, renderError, type ErrorKey, type Lang, type SurveyFull } from "@quizzy/shared";
import { db } from "../db";
import { audit } from "../lib/audit";
import { rawSignature } from "../lib/comparable";
import { langOf, notFound, parseQuery } from "../lib/http";
import { patientRespondent } from "../lib/population";
import { percent, round } from "../lib/stats";
import { assertSurveyAccess } from "../lib/scope";
import { getSurvey } from "../lib/surveys";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const facetRoutes = new Hono<AppEnv>();

/*
 * Право вместо «просто персонал». requireStaff остаётся первым: оно отвечает
 * на другой вопрос — сотрудник ли это вообще, — и снимать его значило бы
 * отдать проверку класса учётной записи проверке права.
 *
 * Сегодня разницы в поведении нет — встроенная роль есть у каждого
 * администратора, — и это ровно то, чего мы хотим от перехода.
 */
facetRoutes.use("*", requireAuth, requireStaff, requirePermission("analytics.read"));

/** П-1: страта меньше пяти наружу не выходит */
/*
 * Порог берётся из общего места, а не объявляется здесь заново.
 *
 * Своя копия числа означает, что изменить порог в одном месте и забыть о
 * другом — вопрос времени, а расходятся такие копии молча. Ровно об этом
 * предупреждает докстрока в lib/privacy.ts.
 */

/** В каких единицах лежит усреднённое значение */
type Unit = "tscore" | "sten" | "ratio" | "raw";

const BASIS_KEY: Record<Unit, ErrorKey> = {
  tscore: "err.facetBasisT",
  sten: "err.facetBasisSten",
  ratio: "err.facetBasisRatio",
  raw: "err.facetBasisRaw",
};

/**
 * Подпись группы: что усреднено, из каких версий и кого нет в счёте.
 * Готовым текстом на языке запроса — как пометки статистики (errorStrings).
 */
function basisOf(unit: Unit, normed: boolean, versions: number[], lang: Lang): string {
  const what = renderError(normed ? BASIS_KEY[unit] : "err.facetBasisRawNoNorm", lang, {
    versions: versions.join(", ") || "—",
  });
  return `${what}. ${renderError("err.facetBasisExcluded", lang)}`;
}

/**
 * Группа сравнимых значений внутри шкалы.
 *
 * Нормированные T-баллы и стены всех версий — одна группа: они уже
 * приведены нормой к общей шкале. Всё остальное — доли, сырые баллы и
 * СЫРЫЕ баллы, оставшиеся там, где норма не применилась, — делится по
 * изданиям подсчёта (lib/comparable.ts): две версии, где сырой балл
 * считается одинаково, складываются, где по-разному — нет.
 */
async function versionClasses(surveyId: string, lang: Lang) {
  const rows = await db.execute<{ id: string; version: number } & Record<string, unknown>>(sql`
    select distinct sv.id, sv.version
    from responses r
    join survey_versions sv on sv.id = r.version_id
    where r.survey_id = ${surveyId} and r.status = 'completed'
    order by sv.version
  `);
  const versions: { id: string; number: number; full: SurveyFull }[] = [];
  for (const r of rows) {
    const full = await getSurvey(surveyId, String(r.id), lang);
    if (full) versions.push({ id: String(r.id), number: Number(r.version), full });
  }
  /* класс — номер первой версии с таким же отпечатком: читается и в отладке */
  const classes: { versionId: string; code: string; cls: string }[] = [];
  const codes = new Set(versions.flatMap((v) => v.full.scales.filter((s) => s.kind === "clinical").map((s) => s.code)));
  for (const code of codes) {
    const first = new Map<string, number>();
    for (const v of versions) {
      const sig = rawSignature(v.full, code);
      if (sig === null) continue;
      if (!first.has(sig)) first.set(sig, v.number);
      classes.push({ versionId: v.id, code, cls: `v${first.get(sig)}` });
    }
  }
  return classes;
}

/**
 * Стратифицированные срезы аналитики (5.1).
 *
 * Средний балл «по больнице» скрывает обе группы сразу: тревожность женщин
 * 25–34 и мужчин 45+ — разные распределения. Здесь каждая метрика режется
 * по выбранному фасету, а ячейки меньше порога подавляются: это стандарт
 * медицинской статистики против реидентификации, а не перестраховка.
 *
 * ═══ Что усредняется ═══
 *
 * Только сравнимое. Прежде `avg(value)` брался по всем строкам шкалы сразу —
 * и по всем версиям, — а в value лежат РАЗНЫЕ величины: T-балл, если норма
 * к человеку применилась, и сырой балл, если нет (нет нормы для пола или
 * возраста). У Мини-мульта пятеро мужчин с T 64,9 и пятеро без пола с
 * сырым 11 давали «средний T» 37,95 — ниже нормы у группы, где половина
 * выше неё. Теперь у шкалы несколько групп, каждая — одна величина одного
 * издания подсчёта (см. versionClasses), и у каждой подпись: что именно
 * усреднено, из каких версий и кого нет в счёте (`basis`).
 *
 * ═══ Кого считаем ═══
 *
 * Достоверные протоколы пациентов. Недостоверный протокол (reliable =
 * false) не усредняется: его баллам не верят — ровно это флаг и значит.
 * Сотрудник, заполнивший методику на себя, — не респондент
 * (lib/population.ts). Считается прямо по прохождениям и баллам, а не по
 * витрине response_facts: в витрине нет ни normalized, ни reliable, а
 * менять её — чужая выгрузка (spss) и чужая миграция. Определение
 * «случая риска» то же, что в витрине: полоса moderate или severe.
 *
 * ═══ Порог ═══
 *
 * Все группы шкалы вместе — одно разбиение её прохождений, и скрытое
 * решается по нему целиком (suppressedKeys): иначе одна скрытая страта
 * одной группы вычислялась бы из числа прохождений шкалы вычитанием
 * показанных — ровно та утечка, против которой разбиение и заведено.
 */
facetRoutes.get("/surveys/:id", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const lang = langOf(c);
  const survey = await getSurvey(surveyId, null, lang);
  if (!survey) notFound("err.surveyNotFound");

  const { facet } = parseQuery(c, facetQuery);
  const expr = {
    sex: sql`coalesce(r.respondent_sex, '—')`,
    age: sql`coalesce(r.respondent_age_band, '—')`,
    sexAge: sql`coalesce(r.respondent_sex, '—') || ' · ' || coalesce(r.respondent_age_band, '—')`,
    lang: sql`coalesce(r.lang, '—')`,
    unit: sql`coalesce(u.unit, '—')`,
  }[facet];

  type Row = {
    scale_code: string;
    unit: Unit;
    normed: boolean;
    grp: string;
    stratum: string;
    n: number;
    mean: number | null;
    sd: number | null;
    median: number | null;
    banded: number;
    risk: number;
    versions: number[] | null;
  };

  const classes = await versionClasses(surveyId, lang);
  const rows: Row[] = classes.length
    ? ([
        ...(await db.execute(sql`
          with cls(version_id, code, cls) as (
            values ${sql.join(
              classes.map((k) => sql`(${k.versionId}::text, ${k.code}::text, ${k.cls}::text)`),
              sql`, `,
            )}
          )
          select
            sc.code                                                     as scale_code,
            case when s.normalized then s.normalization else 'raw' end  as unit,
            s.normalized                                                as normed,
            case when s.normalized and s.normalization in ('tscore', 'sten') then '*'
                 else coalesce(cls.cls, '?') end                        as grp,
            ${expr}                                                     as stratum,
            count(*)::int                                               as n,
            avg(s.value)                                                as mean,
            stddev_samp(s.value)                                        as sd,
            percentile_cont(0.5) within group (order by s.value)        as median,
            count(*) filter (where s.severity is not null)::int         as banded,
            count(*) filter (where s.severity in ('moderate', 'severe'))::int as risk,
            array_agg(distinct sv.version) filter (where sv.version is not null) as versions
          from responses r
          join response_scores s on s.response_id = r.id
          join scales sc on sc.id = s.scale_id
          left join survey_versions sv on sv.id = r.version_id
          left join cls on cls.version_id = r.version_id and cls.code = sc.code
          left join users u on u.id = r.user_id
          where r.survey_id = ${surveyId}
            and r.status = 'completed'
            and r.reliable
            and ${patientRespondent("r")}
            and sc.kind = 'clinical'
          group by 1, 2, 3, 4, 5
          order by 1, 2, 3, 4, 5
        `)),
      ] as unknown as Row[])
    : [];

  const byScale = new Map<string, Row[]>();
  for (const raw of rows) {
    const list = byScale.get(raw.scale_code) ?? [];
    list.push(raw);
    byScale.set(raw.scale_code, list);
  }

  /* нормированное — первым, потом сырое без нормы; внутри — по первой версии */
  const UNIT_ORDER: Unit[] = ["tscore", "sten", "ratio", "raw"];
  const groupKey = (r: Row) => `${r.unit}|${r.normed}|${r.grp}`;

  const scales = survey.scales
    .filter((s) => s.kind === "clinical")
    .flatMap((scale) => {
      const list = byScale.get(scale.code) ?? [];
      /*
       * Скрытые страты считает общая функция, а не фильтр по порогу.
       *
       * Фильтр «n < порога» отвечал на вопрос «мала ли страта», а вопрос
       * стоит другой: «называет ли отчёт человека». Когда скрытая страта
       * одна, он называет — её размер получается вычитанием показанных из
       * общего числа прохождений, а оно отдаётся открыто и по делу. Поэтому
       * решение о скрытии принимается по строке целиком, см. suppressedKeys.
       * Строка — все группы шкалы вместе: см. «Порог» выше.
       */
      const cellKey = (r: Row) => `${groupKey(r)}|${r.stratum}`;
      const hidden = suppressedKeys(list.map((r) => ({ key: cellKey(r), n: Number(r.n) })));

      const groups = new Map<string, Row[]>();
      for (const r of list) groups.set(groupKey(r), [...(groups.get(groupKey(r)) ?? []), r]);

      return [...groups.values()]
        .map((own) => {
          const head = own[0]!;
          const versions = [...new Set(own.flatMap((r) => (r.versions ?? []).map(Number)))].sort((a, b) => a - b);
          return {
            code: scale.code,
            title: scale.title,
            normalization: scale.normalization,
            unit: head.unit,
            normed: head.normed,
            versions,
            basis: basisOf(head.unit, head.normed, versions, lang),
            suppressedStrata: own.filter((r) => hidden.has(cellKey(r))).length,
            strata: own
              .filter((r) => !hidden.has(cellKey(r)))
              .map((r) => ({
                stratum: r.stratum,
                n: Number(r.n),
                mean: r.mean === null ? null : round(Number(r.mean), 2),
                sd: r.sd === null ? null : round(Number(r.sd), 2),
                median: r.median === null ? null : round(Number(r.median), 2),
                /*
                 * Доля риска скрывается, если по ней восстанавливается человек.
                 *
                 * Порог применялся к размеру страты, но не к числу людей в
                 * риске внутри неё: страта из пяти с одним в риске отдавала
                 * riskShare 20 — и этот один вычислялся точно. Скрывать надо и
                 * обратный край: «четверо из пяти» так же однозначно называет
                 * пятого.
                 *
                 * Доля — от тех, у кого полоса есть. Сырой балл без нормы в
                 * полосу не ложится, и «0 % в риске» у такой группы значило
                 * бы «никого в риске», хотя на деле — «не с чем сравнить»:
                 * там null.
                 */
                riskShare:
                  Number(r.banded) === 0 ||
                  Number(r.risk) < SMALL_CELL_FLOOR ||
                  Number(r.banded) - Number(r.risk) < SMALL_CELL_FLOOR
                    ? null
                    : percent(Number(r.risk), Number(r.banded)),
              })),
          };
        })
        .sort(
          (a, b) =>
            Number(b.normed) - Number(a.normed) ||
            UNIT_ORDER.indexOf(a.unit) - UNIT_ORDER.indexOf(b.unit) ||
            (a.versions[0] ?? 0) - (b.versions[0] ?? 0),
        );
    })
    .filter((s) => s.strata.length > 0 || s.suppressedStrata > 0);

  await audit(c, {
    action: "analytics.facets",
    resourceType: "survey",
    resourceId: surveyId,
    details: { facet, scales: scales.length },
  });

  return c.json({ surveyId, title: survey.title, facet, smallCellFloor: SMALL_CELL_FLOOR, scales });
});
