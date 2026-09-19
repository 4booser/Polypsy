import { beforeAll, describe, expect, test } from "bun:test";
import { renderError, type ResponseDetail, type SurveyFull } from "@quizzy/shared";
import {
  adminA,
  adminB,
  api,
  createSurveySchema,
  createVersion,
  db,
  groupA,
  patient,
  submitSurvey,
  surveyInA,
  surveys,
} from "./fixtures";

/**
 * Просмотр пройденного теста: вес варианта, лестница полос и версия.
 *
 * Экран рисует вес каждого выбранного варианта и все ступени «від — до» с
 * подсвеченной. Раньше он собирал это из действующей методики, а человек
 * мог проходить прежнюю версию — и на экране оказывались правдоподобные, но
 * чужие числа. Здесь проверяется, что прохождение само отдаёт веса и
 * лестницу той версии, которую проходили, и что эту версию можно спросить
 * у методики по номеру.
 *
 * Каждая защита проверена мутацией — снималась, и тест обязан был упасть,
 * назвав виновника. Тестовый пользователь базы обходит RLS: границы здесь
 * проверяются через API от лица разных людей.
 */

type Band = { minScore: number; maxScore: number; label: string };
const BANDS_V1: Band[] = [
  { minScore: 0, maxScore: 1, label: "Низький" },
  { minScore: 2, maxScore: 3, label: "Високий" },
];
const BANDS_V2: Band[] = [
  { minScore: 0, maxScore: 2, label: "Помірний" },
  { minScore: 3, maxScore: 3, label: "Критичний" },
];

/** Методика из трёх пунктов «так/ні» и одной суммы; полосы — параметр, чтобы версии различались */
function draftWith(bands: Band[]) {
  return createSurveySchema.parse({
    title: { uk: "Версійна методика" },
    administration: "self",
    scoringEnabled: true,
    questions: [1, 2, 3].map((n) => ({
      type: "yesno",
      title: { uk: `Пункт ${n}` },
      required: true,
      options: [
        { text: { uk: "Ні" }, score: 0, keyCode: "no" },
        { text: { uk: "Так" }, score: 1, keyCode: "yes" },
      ],
    })),
    scales: [
      {
        code: "S",
        title: { uk: "Сума" },
        bands: bands.map((b) => ({ ...b, label: { uk: b.label } })),
        key: [1, 2, 3].map((item) => ({ item, matchKey: "yes", weight: 1 })),
      },
    ],
  });
}

async function makeSurveyRow(extra: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: "Версійна методика" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
    ...extra,
  } as never);
  return id;
}

describe("вес варианта и лестница полос", () => {
  let responseId: string;
  let survey: SurveyFull;

  beforeAll(async () => {
    const res = await submitSurvey(surveyInA, patient.token);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    responseId = res.body.id;
    survey = (await api<SurveyFull>(`/api/surveys/${surveyInA}`, adminA.token)).body;
  });

  /**
   * Мутация: отдать в `bands` только попавшую полосу — число ступеней не
   * сходится с методикой, проверка называет шкалу. Мутация: пометить `hit`
   * по первой полосе — подпись попавшей расходится с `band.label`.
   */
  test("персоналу — вес каждого варианта и вся лестница с одной попавшей ступенью", async () => {
    const res = await api<ResponseDetail>(`/api/responses/${responseId}`, adminA.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const detail = res.body;
    expect(detail.survey.versionNumber).toBe(survey.versionNumber);

    const optionById = new Map(survey.questions.flatMap((q) => q.options.map((o) => [o.id, o] as const)));
    expect(detail.answers.length).toBeGreaterThan(0);
    for (const a of detail.answers) {
      expect(a.options.length).toBeGreaterThan(0);
      for (const o of a.options) {
        expect(o.score, `вариант ${o.id} пункта «${a.title}» без веса`).toBe(optionById.get(o.id)!.score);
      }
    }

    expect(detail.scores.length).toBeGreaterThan(0);
    for (const sc of detail.scores) {
      const scale = survey.scales.find((s) => s.id === sc.scaleId)!;
      expect(
        sc.bands.map((b) => b.id).sort(),
        `шкала ${sc.scaleCode}: лестница не совпадает с полосами методики`,
      ).toEqual(scale.bands.map((b) => b.id).sort());
      for (let i = 1; i < sc.bands.length; i++) {
        expect(sc.bands[i]!.minScore >= sc.bands[i - 1]!.minScore, `шкала ${sc.scaleCode}: лестница не по возрастанию`).toBe(true);
      }
      const hits = sc.bands.filter((b) => b.hit);
      if (sc.band) {
        expect(hits.length, `шкала ${sc.scaleCode}: попавших ступеней ${hits.length}`).toBe(1);
        expect(hits[0]!.label, `шкала ${sc.scaleCode}: подсвечена не та ступень`).toBe(sc.band.label);
        expect(sc.value >= hits[0]!.minScore && sc.value <= hits[0]!.maxScore).toBe(true);
      } else {
        expect(hits, `шкала ${sc.scaleCode}: без полосы подсвечена ступень`).toEqual([]);
      }
    }
  });

  /**
   * Мутация: отдавать `o.score` без оглядки на `staffView` — веса уходят
   * обследуемому, проверка называет варианты.
   */
  test("обследуемому своё прохождение открыто, но без весов вариантов", async () => {
    const res = await api<ResponseDetail>(`/api/responses/${responseId}`, patient.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const leaked = res.body.answers.flatMap((a) => a.options.filter((o) => o.score !== null).map((o) => o.id));
    expect(leaked, `веса вариантов ушли обследуемому: ${leaked.slice(0, 3).join(", ")}`).toEqual([]);

    // всё остальное — то же, что видит персонал: ответы, баллы и лестница (у шкалы достоверности она пуста, и это норма)
    const staff = (await api<ResponseDetail>(`/api/responses/${responseId}`, adminA.token)).body;
    expect(res.body.answers.map((a) => a.optionIds)).toEqual(staff.answers.map((a) => a.optionIds));
    expect(res.body.scores.map((s) => s.bands)).toEqual(staff.scores.map((s) => s.bands));
  });
});

describe("версия методики по запросу", () => {
  let id: string;
  let responseId: string;

  beforeAll(async () => {
    id = await makeSurveyRow();
    await createVersion(id, draftWith(BANDS_V1), adminA.id, "Перша");
    // submitSurvey выбирает второй вариант — «Так» на всё: сумма 3, полоса «Високий» по первой версии
    const res = await submitSurvey(id, patient.token);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    responseId = res.body.id;
    await createVersion(id, draftWith(BANDS_V2), adminA.id, "Друга: межі переписані");
  });

  /**
   * Мутация: убрать `eq(surveyVersions.surveyId, …)` из поиска версии —
   * номер 1 находит первую попавшуюся версию любой методики, содержимое
   * приходит пустым или чужим, и проверка полос первой версии падает.
   */
  test("?version=N отдаёт содержимое той версии; без параметра — действующую", async () => {
    const current = await api<SurveyFull>(`/api/surveys/${id}`, adminA.token);
    expect(current.body.versionNumber).toBe(2);
    expect(current.body.scales[0]!.bands.map((b) => b.label)).toEqual(BANDS_V2.map((b) => b.label));

    const old = await api<SurveyFull>(`/api/surveys/${id}?version=1`, adminA.token);
    expect(old.status, JSON.stringify(old.body)).toBe(200);
    expect(old.body.id).toBe(id);
    expect(old.body.versionNumber).toBe(1);
    expect(old.body.scales[0]!.bands.map((b) => b.label), "по ?version=1 пришли не полосы первой версии").toEqual(
      BANDS_V1.map((b) => b.label),
    );
    // статус и видимость — из строки методики, а не из версии: версия хранит только содержимое
    expect(old.body.status).toBe("published");

    // действующая по номеру — то же, что без параметра
    expect((await api<SurveyFull>(`/api/surveys/${id}?version=2`, adminA.token)).body.versionNumber).toBe(2);
  });

  test("просмотр прохождения ведёт к версии, которую человек проходил", async () => {
    const detail = await api<ResponseDetail>(`/api/responses/${responseId}`, adminA.token);
    expect(detail.status).toBe(200);
    expect(detail.body.survey.versionNumber, "прохождение не знает своей версии").toBe(1);

    const [score] = detail.body.scores;
    expect(score, "балл по шкале не посчитан").toBeTruthy();
    expect(score!.bands.map((b) => b.label), "лестница собрана из действующей версии, а не пройденной").toEqual(
      BANDS_V1.map((b) => b.label),
    );
    expect(score!.band?.label).toBe("Високий");
    expect(score!.bands.find((b) => b.hit)?.label).toBe("Високий");

    // методика той же версии отдаёт те же полосы теми же идентификаторами — экрану есть что сопоставлять
    const versioned = await api<SurveyFull>(`/api/surveys/${id}?version=${detail.body.survey.versionNumber}`, adminA.token);
    expect(versioned.body.scales[0]!.bands.map((b) => b.id)).toEqual(score!.bands.map((b) => b.id));
  });

  test("несуществующая версия — 404, мусор — 400, права — как у методики", async () => {
    const missing = await api(`/api/surveys/${id}?version=9`, adminA.token);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe(renderError("err.surveyVersionNotFound", "uk"));

    expect((await api(`/api/surveys/${id}?version=abc`, adminA.token)).status).toBe(400);
    expect((await api(`/api/surveys/${id}?version=0`, adminA.token)).status).toBe(400);

    // чужому сотруднику версия закрыта так же, как и методика
    expect((await api(`/api/surveys/${id}?version=1`, adminB.token)).status).toBe(403);
    // а пациенту опубликованная открыта и по версии
    expect((await api(`/api/surveys/${id}?version=1`, patient.token)).status).toBe(200);
  });

  /**
   * Мутация: искать версию до проверки прав — черновик отвечает пациенту
   * «версию не найдено» на ?version=9 и содержимым на ?version=1, и по этой
   * разнице можно пересчитать версии закрытой методики.
   */
  test("по номеру версии нельзя узнать о методике, которую не положено видеть", async () => {
    const hiddenId = await makeSurveyRow({ status: "draft", publishedAt: null });
    await createVersion(hiddenId, draftWith(BANDS_V1), adminA.id, "Чернетка");

    for (const version of [1, 9]) {
      const res = await api(`/api/surveys/${hiddenId}?version=${version}`, patient.token);
      expect(res.status, `черновик с ?version=${version} открыт пациенту`).toBe(404);
      expect(res.body.error, `ответ на ?version=${version} выдаёт, есть ли такая версия`).toBe(
        renderError("err.surveyNotFound", "uk"),
      );
    }
  });
});

describe("язык текстов методики в прохождении", () => {
  let responseId: string;

  beforeAll(async () => {
    const id = await makeSurveyRow({ title: { uk: "Двомовна методика", ru: "Двуязычная методика" } });
    const draft = createSurveySchema.parse({
      title: { uk: "Двомовна методика", ru: "Двуязычная методика" },
      administration: "self",
      scoringEnabled: false,
      questions: [
        {
          type: "yesno",
          title: { uk: "Чи спите ви вночі?", ru: "Спите ли вы ночью?" },
          required: true,
          options: [
            { text: { uk: "Ні" }, score: 0, keyCode: "no" },
            { text: { uk: "Так" }, score: 1, keyCode: "yes" },
          ],
        },
      ],
    });
    await createVersion(id, draft, adminA.id, "Двомовна");
    const res = await submitSurvey(id, patient.token);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    responseId = res.body.id;
  });

  /**
   * Мутация: читать методику прохождения без языка читателя — под русской
   * консолью приходит украинский заголовок и украинский текст пункта,
   * проверка называет оба. Описание при этом шло отдельным запросом и
   * переводилось, так что на экране стоял украинский заголовок над русским
   * описанием — как недоперевод, а не как выбор.
   */
  test("заголовок и пункты приходят на языке того, кто читает", async () => {
    const ru = await api<ResponseDetail>(`/api/responses/${responseId}`, adminA.token, {
      headers: { "Accept-Language": "ru" },
    });
    expect(ru.status, JSON.stringify(ru.body)).toBe(200);
    expect(ru.body.survey.title, "заголовок под русской консолью").toBe("Двуязычная методика");
    expect(ru.body.answers[0]!.title, "пункт под русской консолью").toBe("Спите ли вы ночью?");

    const uk = await api<ResponseDetail>(`/api/responses/${responseId}`, adminA.token, {
      headers: { "Accept-Language": "uk" },
    });
    expect(uk.body.survey.title, "заголовок под украинской консолью").toBe("Двомовна методика");
    expect(uk.body.answers[0]!.title, "пункт под украинской консолью").toBe("Чи спите ви вночі?");
  });
});
