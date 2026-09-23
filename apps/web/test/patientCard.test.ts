import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PatientCard } from "@quizzy/shared";
import {
  conclusionName,
  groupStatsText,
  leadAction,
  personFields,
  resultText,
  statsText,
} from "../src/pages/patientCard/model";

/**
 * Карточка пациента (кадр f19): то, что на живом экране проверяется лишь
 * случайно.
 *
 * Порядок плашек — это порядок кадра: перестановка «Стать» и «Прізвище»
 * ничего не ломает и глазом ловится не сразу. Подпись «Відписатись /
 * Підписатись» — это право: «Відписатись» на чужом закреплении сервер
 * отвергает, и кнопка, которая обещает отпустить чужого пациента, — обман.
 * Адреса — третье: на карточку ведут ссылки с десятка экранов, а прежняя
 * клиническая карта переехала на /case, и её старые адреса обязаны
 * перенаправляться, иначе очередь работы с сервера уводит на сводку через
 * запасной маршрут, молча.
 */

const SRC = resolve(import.meta.dir, "../src");
const labels = {
  firstName: "Ім’я",
  lastName: "Прізвище",
  middleName: "Ім’я по батькові",
  sex: "Стать",
  birthDate: "Дата народження",
  phone: "Телефон",
  city: "Населений пункт",
  email: "Email",
  male: "чоловіча",
  female: "жіноча",
};
const iso = (s: string) => `d:${s}`;

const person = (over: Partial<PatientCard> = {}): PatientCard => ({
  id: "u1",
  firstName: "Олена",
  lastName: "Коваль",
  middleName: null,
  fullName: "Коваль Олена",
  anonymous: false,
  pseudonym: null,
  email: "olena@example.org",
  sex: "female",
  birthDate: "1990-04-12",
  unit: null,
  position: null,
  specialty: null,
  rank: null,
  createdAt: "2026-01-01T00:00:00Z",
  lead: null,
  responses: [],
  groups: [],
  conclusions: [],
  ...over,
});

describe("карточка пациента: плашки", () => {
  test("восемь плашек в порядке кадра; пустые показывают подпись, а не прочерк", () => {
    const fields = personFields(person(), labels, iso);
    expect(fields.map((f) => f.key)).toEqual(["firstName", "lastName", "middleName", "sex", "birthDate", "phone", "city", "email"]);
    expect(fields.map((f) => f.value)).toEqual([
      "Олена",
      "Коваль",
      null,
      "жіноча",
      "d:1990-04-12",
      null,
      null,
      "olena@example.org",
    ]);
    // телефон и населённый пункт сервер не отдаёт — плашка на месте, значения нет
    expect(fields.find((f) => f.key === "phone")!.label).toBe("Телефон");
  });

  test("анонимный пациент: вместо имени псевдоним, фамилии и отчества нет", () => {
    const fields = personFields(person({ anonymous: true, pseudonym: "Сокіл-12", firstName: "", lastName: "" }), labels, iso);
    expect(fields[0]!.value).toBe("Сокіл-12");
    expect(fields[1]!.value).toBeNull();
    expect(fields[2]!.value).toBeNull();
  });
});

describe("карточка пациента: колонки строк", () => {
  const scales = [
    { code: "A", title: "Тривожність", value: 14, normalization: "raw" as const, percent: 70, bandLabel: "підвищена", severity: "moderate" as const },
    { code: "D", title: "Депресія", value: 3, normalization: "raw" as const, percent: 15, bandLabel: null, severity: null },
  ];

  test("«Результат тесту» — балл и полоса каждой шкалы одной строкой", () => {
    expect(resultText(scales, { none: "Балів немає" })).toBe("Тривожність: 14 — підвищена; Депресія: 3");
    expect(resultText([], { none: "Балів немає" })).toBe("Балів немає");
  });

  test("«Статистика» — дата, доля от максимума по шкалам, недостоверность словом", () => {
    expect(statsText({ submittedAt: "2026-03-01T10:00:00Z", reliable: true, scales }, { unreliable: "Протокол недостовірний" }, iso)).toBe(
      "d:2026-03-01T10:00:00Z · A 70%, D 15%",
    );
    expect(statsText({ submittedAt: null, reliable: false, scales: [] }, { unreliable: "Протокол недостовірний" }, iso)).toBe(
      "Протокол недостовірний",
    );
  });

  test("«Статистика Групи» — те же числа, что на вкладке группы", () => {
    expect(groupStatsText({ memberCount: 12, surveyCount: 3 }, { members: "учасників", tests: "тестів" })).toBe("12 учасників · 3 тестів");
  });

  test("имя заключения — методика; черновик помечен словом", () => {
    expect(conclusionName({ surveyTitle: "PHQ-9", status: "signed" }, { draft: "чернетка" })).toBe("PHQ-9");
    expect(conclusionName({ surveyTitle: "PHQ-9", status: "draft" }, { draft: "чернетка" })).toBe("PHQ-9 (чернетка)");
  });
});

describe("карточка пациента: закрепление", () => {
  test("«Відписатись» только на своём закреплении; чужое и пустое — «Підписатись»", () => {
    expect(leadAction({ lead: null })).toBe("subscribe");
    expect(leadAction({ lead: { specialistId: "s2", name: "Інша", mine: false } })).toBe("subscribe");
    expect(leadAction({ lead: { specialistId: "s1", name: "Я", mine: true } })).toBe("unsubscribe");
  });
});

describe("карточка пациента: адреса", () => {
  const app = readFileSync(join(SRC, "App.tsx"), "utf8");
  const card = readFileSync(join(SRC, "pages/patientCard/PatientCard.tsx"), "utf8");

  test("карточка кадра стоит на адресе человека, клиническая карта — под /case", () => {
    expect(app).toContain('<Route path="/patients/:userId" element={<PatientCard />} />');
    expect(app).toContain('<Route path="/patients/:userId/case" element={<CaseCard />}>');
  });

  test("прежние адреса клинической карты перенаправляются, а не проваливаются в «*»", () => {
    for (const tail of ["summary", "dynamics", "timeline"]) {
      expect(app, `/patients/:userId/${tail} без перенаправления`).toContain(`path="/patients/:userId/${tail}"`);
    }
  });

  test("ссылки карточки собраны по форме объявленных маршрутов", () => {
    // группа пациентов и заключение — свои экраны со своими адресами (App.tsx)
    expect(card).toContain("`/patient-groups/${g.id}`");
    expect(app).toContain('path="/patient-groups/:id"');
    expect(card).toContain("`/responses/${c.responseId}/conclusion`");
    expect(app).toContain('path="/responses/:id/conclusion"');
    // дверь к клинической карте ведёт на её новый адрес, а не на старый
    expect(card).toContain("`${base}/case`");
  });
});
