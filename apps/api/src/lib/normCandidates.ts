import { sql } from "drizzle-orm";
import type { Sex, SurveyFull } from "@quizzy/shared";
import { db } from "../db";
import { rawSignature } from "./comparable";
import { patientRespondent } from "./population";
import { suppress } from "./privacy";
import { average, round, variance } from "./stats";

/** Ниже этого нормы — шум, а не нормы: считается в ЛЮДЯХ */
export const MIN_GROUP = 30;
/** Ниже этого даже не показываем кандидата */
export const MIN_SHOW = 10;

export interface CandidateGroup {
  sex: Sex | null;
  /** Людей — по одному значению на человека */
  n: number;
  mean: number;
  sd: number;
  /** Достаточно ли выборки для публикации */
  publishable: boolean;
}

export interface CandidateScale {
  code: string;
  title: string;
  current: { sex: Sex | null; mean: number; sd: number; source: string | null }[];
  candidate: CandidateGroup[];
  /** Номера версий, чьи прохождения вошли в выборку этой шкалы: сырой балл в них считается одинаково */
  versions: number[];
}

export interface CandidateStats {
  scales: CandidateScale[];
  /**
   * Сколько достоверностью не прошедших протоколов пациентов не вошло в
   * выборку; null — меньше порога малых ячеек (как и у любого числа людей).
   */
  unreliable: number | null;
}

/**
 * Кандидатные нормы по фактической выборке учреждения.
 *
 * Считаются по СКОРРЕКТИРОВАННОМУ сырому баллу (как того требует формула
 * T = 50 + 10(x − M)/SD): raw хранится в response_scores, поправки
 * восстанавливаются по кодам шкал той же версии. Группировка — по полу,
 * как в нормах пособий; возрастные разрезы появятся, когда выборка позволит.
 *
 * ═══ Кто и что входит в выборку ═══
 *
 * Прежде сюда шли все сданные прохождения методики, и норма, которую
 * публикуют новой версией и по которой потом переводят в T-баллы каждого
 * следующего человека, собиралась из четырёх ошибок сразу:
 *
 *  1. Версии смешивались. Сырой балл версии с другим ключом — другая
 *     величина: убрали пункт из Hs — и средний сырой сдвинулся бы на
 *     разницу ключей, а не на разницу людей. Теперь в выборку шкалы идут
 *     только версии, где её сырой балл считается ТАК ЖЕ, как в действующей
 *     (lib/comparable.ts). Версия, где поменяли только нормы, — идёт:
 *     сырой балл от норм не зависит, и публикация норм для второй шкалы не
 *     обнуляет выборку для первой.
 *
 *  2. Пол брался нынешний, из карточки. Норма — про то, каким человек был
 *     обследован, а обследован он по снимку пола на момент сдачи
 *     (respondent_sex): по нему считались и T-баллы, и полосы. Поправленная
 *     потом карточка переносила человека в чужую группу задним числом.
 *
 *  3. Недостоверные протоколы шли в норму наравне с честными. Бланк,
 *     проваливший шкалу лжи, — ровно то, что норма описывать не должна.
 *
 *  4. Порог N = 30 считался по прохождениям. Трое, пересдавшие по три
 *     раза, выглядели девятью людьми — и «норма учреждения» публиковалась по
 *     двадцати с небольшим людям. Теперь — по одному значению на человека:
 *     его ПЕРВОМУ достоверному прохождению совместимых версий. Первому, а
 *     не последнему: повторный замер несёт эффект повторного предъявления
 *     и эффект лечения, а норма описывает человека, впервые встретившего
 *     методику, — так собраны и нормы пособий.
 *
 * Анонимные прохождения (user_id пуст) не идут: у них нет человека, и
 * посчитать «людей» по ним нельзя — каждый бланк выглядел бы новым. Сотрудник,
 * заполнивший методику на себя, — не человек выборки (lib/population.ts).
 */
export async function normCandidates(
  surveyId: string,
  current: SurveyFull,
  versionOf: (versionId: string) => Promise<SurveyFull | null>,
): Promise<CandidateStats> {
  const rows = [
    ...(await db.execute<{
      id: string;
      user_id: string;
      version_id: string;
      reliable: boolean;
      sex: Sex | null;
    } & Record<string, unknown>>(sql`
      select r.id, r.user_id, r.version_id, r.reliable, r.respondent_sex as sex
      from responses r
      where r.survey_id = ${surveyId}
        and r.status = 'completed'
        and r.user_id is not null
        and r.version_id is not null
        and ${patientRespondent("r")}
      order by r.user_id, r.submitted_at asc nulls last, r.id asc
    `)),
  ].map((r) => ({
    id: String(r.id),
    userId: String(r.user_id),
    versionId: String(r.version_id),
    reliable: r.reliable !== false,
    sex: (r.sex ?? null) as Sex | null,
  }));

  const trusted = rows.filter((r) => r.reliable);
  const scoreRows = trusted.length
    ? [
        ...(await db.execute<{ response_id: string; code: string; raw: number } & Record<string, unknown>>(sql`
          select rs.response_id, sc.code, rs.raw_score as raw
          from response_scores rs
          join scales sc on sc.id = rs.scale_id
          join responses r on r.id = rs.response_id
          where r.survey_id = ${surveyId}
            and r.status = 'completed'
            and r.reliable
            and r.user_id is not null
            and ${patientRespondent("r")}
        `)),
      ]
    : [];
  const rawByResponse = new Map<string, Map<string, number>>();
  for (const s of scoreRows) {
    const m = rawByResponse.get(String(s.response_id)) ?? new Map<string, number>();
    m.set(String(s.code), Number(s.raw));
    rawByResponse.set(String(s.response_id), m);
  }

  /* версии с прохождениями — чтобы сравнить, как в них считается сырой балл */
  const versionIds = [...new Set(rows.map((r) => r.versionId))];
  const versions = new Map<string, SurveyFull>();
  for (const id of versionIds) {
    const full = id === current.versionId ? current : await versionOf(id);
    if (full) versions.set(id, full);
  }

  const scales = current.scales
    .filter((s) => s.normalization === "tscore")
    .map((scale): CandidateScale => {
      const own = rawSignature(current, scale.code);
      const compatible = new Set(
        [...versions.entries()].filter(([, v]) => rawSignature(v, scale.code) === own).map(([id]) => id),
      );

      // первое достоверное прохождение каждого человека среди совместимых версий
      const firstOf = new Map<string, (typeof trusted)[number]>();
      for (const r of trusted) {
        if (!compatible.has(r.versionId) || firstOf.has(r.userId)) continue;
        if (!rawByResponse.get(r.id)?.has(scale.code)) continue;
        firstOf.set(r.userId, r);
      }

      // скорректированный балл: raw + Σ coeff × raw(источник)
      const people = [...firstOf.values()].map((r) => {
        const raws = rawByResponse.get(r.id)!;
        let value = raws.get(scale.code)!;
        for (const c of scale.corrections) value += (raws.get(c.sourceScaleCode) ?? 0) * c.coefficient;
        return { sex: r.sex, value };
      });

      const candidate: CandidateGroup[] = [];
      for (const sex of ["male", "female", null] as const) {
        const values = people.filter((p) => sex === null || p.sex === sex).map((p) => p.value);
        if (values.length < MIN_SHOW) continue;
        const sd = round(Math.sqrt(variance(values)));
        candidate.push({
          sex,
          n: values.length,
          mean: round(average(values)),
          sd,
          // нулевой разброс — не норма: T-формула делит на SD, а выборка,
          // где все ответили одинаково, ничего не измеряет
          publishable: values.length >= MIN_GROUP && sd > 0,
        });
      }

      const used = new Set([...firstOf.values()].map((r) => r.versionId));
      return {
        code: scale.code,
        title: scale.title,
        current: scale.norms.map((n) => ({ sex: n.sex, mean: n.mean, sd: n.sd, source: n.source })),
        candidate,
        versions: [...versions.entries()]
          .filter(([id]) => used.has(id))
          .map(([, v]) => v.versionNumber)
          .sort((a, b) => a - b),
      };
    });

  return { scales, unreliable: suppress(rows.length - trusted.length) };
}
