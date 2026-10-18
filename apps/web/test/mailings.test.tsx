import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { Mailing, MailingListItem, MailingUpdateInput } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import {
  answerShares,
  cleanOptions,
  draftFromMailing,
  draftToInput,
  draftToUpdate,
  isFilled,
  mailingQuery,
  mailingViewFrom,
  MAX_OPTIONS,
  type MailingDraft,
  optionPreset,
  saveThenSend,
  withoutOption,
} from "../src/pages/messages/model";
import { AnswersCell, StateCell, TitleCell } from "../src/pages/messages/MailingList";
import { railGroups } from "../src/shell/Rail";
import { navAccess, railEntries, subNavFor } from "../src/shell/nav";

/**
 * Раздел «Повідомлення» (розсилки) и переписка — две двери, обе на месте.
 *
 * Тихая ошибка, ради которой это написано: розсилки и переписка
 * называются похожими словами, и подмена адреса у пункта — или потеря
 * переписки из общего списка — глазами не отличается: и то и другое
 * открывается, и на обоих экранах написано «повідомлення». Проверяется
 * состав навигации, а не отрисовка: маршруты читаются из App.tsx, пункты —
 * из тех же списков, из которых их читает оболочка.
 */

const APP = readFileSync(resolve(import.meta.dir, "../src/App.tsx"), "utf8");
const declared = new Set([...APP.matchAll(/path="([^"]+)"/g)].map((m) => m[1]!));
const COUNTS = { today: 0, worklist: 0, alerts: 0, referrals: 0 };

describe("навигация раздела «Повідомлення»", () => {
  test("розсилки — пункт подразделов пациентов, «Листування» на рельсе — переписка", () => {
    /*
     * Polypsy 2.0: розсилки — подраздел пациентов (набор, SUBNAV['patients']),
     * а «Листування» на рельсе — разговор с пациентом. Слова разные, адреса
     * разные, и подмена одного другим проверяется здесь.
     */
    const all = navAccess({ role: "superadmin" }, () => true);
    const patients = subNavFor("patients", "/patients", all)!.groups.flatMap((g) => g.items);
    expect(patients.find((it) => it.label === "sn.mailings")?.to).toBe("/mailings");
    expect(railEntries(all).find((e) => e.key === "messages")?.to).toBe("/messages");
  });

  test("переписка осталась по прежнему адресу и в бургере под своим именем", () => {
    /*
     * Переписку не удаляли и не переименовывали: её адрес объявлен, а в
     * бургере она стоит под заголовком собственного экрана («Листування») —
     * тем же ключом, что зовёт Messages.tsx, чтобы два «Повідомлення» не
     * вели на два разных экрана.
     */
    expect(declared.has("/messages"), "маршрут переписки пропал из App.tsx").toBe(true);
    const items = railGroups(COUNTS, false, false).flatMap((g) => g.items);
    const thread = items.find((i) => i.to === "/messages");
    expect(thread, "у переписки не осталось двери в бургере").toBeDefined();
    expect(thread!.key).toBe("ms.title");
  });

  test("все три экрана раздела объявлены", () => {
    for (const path of ["/mailings", "/mailings/new", "/mailings/:id"]) {
      expect(declared.has(path), `маршрут ${path} не объявлен в App.tsx`).toBe(true);
    }
  });
});

describe("черновик повідомлення", () => {
  test("пустые варианты выбрасываются, пробелы по краям снимаются", () => {
    /*
     * Стереть текст варианта — тоже способ его убрать. Пустое поле поэтому
     * не ошибка, а «прибрати», и на сервер оно не уходит.
     */
    expect(cleanOptions([" Так ", "", "Ні", "   "])).toEqual(["Так", "Ні"]);
  });

  test("вариантов не больше потолка сервера", () => {
    const many = Array.from({ length: MAX_OPTIONS + 3 }, (_, i) => `в${i}`);
    expect(cleanOptions(many)).toHaveLength(MAX_OPTIONS);
  });

  test("невыбранная группа уходит null, а не пустой строкой", () => {
    /* селект не умеет null — пустая строка живёт только на экране; сервер ждёт nullish */
    const input = draftToInput({
      title: " Тема ",
      body: "Текст",
      options: ["Так"],
      patientGroupId: "",
      revision: 3,
    });
    expect(input.patientGroupId).toBeNull();
    expect(input.title).toBe("Тема");
    /* поимённого списка экран не ведёт и не должен стирать его пустым массивом */
    expect("patientIds" in input).toBe(false);
    /* заведение нового — не правка: редакции у него ещё нет, и в POST она не уходит */
    expect("baseRevision" in input).toBe(false);
  });

  test("сохранять нечего без названия и текста", () => {
    expect(isFilled({ title: " ", body: "Текст", options: [], patientGroupId: "", revision: null })).toBe(false);
    expect(isFilled({ title: "Тема", body: "", options: [], patientGroupId: "", revision: null })).toBe(false);
    expect(isFilled({ title: "Тема", body: "Текст", options: [], patientGroupId: "", revision: null })).toBe(true);
  });
});

/**
 * Редакция черновика (волна 15, внешний разбор 2026-09-28, п. 1).
 *
 * Правка и отправка, пришедшие одновременно, отправляли новый текст прежним
 * адресатам. Сервер теперь сверяет редакцию; здесь — что экран её называет,
 * и называет ту, что надо: правка — ту, с которой открыт черновик; отправка
 * — ту, что вернуло её собственное сохранение, а не ту, что была на экране
 * до него (иначе человек упирался бы в 409 от своей же правки).
 */
describe("редакция черновика", () => {
  const MAILING: Mailing = {
    id: "m1",
    authorId: "a1",
    title: "Тема",
    body: "Текст",
    options: ["Так", "Ні"],
    status: "draft",
    patientGroupId: "g1",
    patientIds: [],
    revision: 4,
    createdAt: "2026-09-28T08:00:00.000Z",
    updatedAt: "2026-09-28T08:00:00.000Z",
    sentAt: null,
    hiddenAt: null,
  };

  test("черновик открывается с редакцией карточки, правка уходит поверх неё", () => {
    const d = draftFromMailing(MAILING);
    expect(d.revision).toBe(4);
    expect(draftToUpdate({ ...d, body: "Новий текст" })).toMatchObject({ body: "Новий текст", baseRevision: 4 });
  });

  test("отправляется ровно сохранённая редакция, и сохранённое ложится на экран до отправки", async () => {
    const calls: string[] = [];
    const draft: MailingDraft = { ...draftFromMailing(MAILING), body: "Правка перед відправленням" };
    await saveThenSend(draft, {
      save: async (input: MailingUpdateInput) => {
        calls.push(`save:${input.baseRevision}:${input.body}`);
        return { ...MAILING, body: input.body!, revision: 5 };
      },
      apply: (saved) => calls.push(`apply:${saved.revision}`),
      send: async (revision) => calls.push(`send:${revision}`),
    });
    expect(calls).toEqual(["save:4:Правка перед відправленням", "apply:5", "send:5"]);
  });

  test("сохранение отклонено — отправки нет вовсе", async () => {
    /* 409 на сохранении значит, что черновик переписали: отправлять нечего, пока человек не перечитал */
    let sent = false;
    const refused = saveThenSend(draftFromMailing(MAILING), {
      save: async () => {
        throw new Error("409");
      },
      apply: () => {},
      send: async () => {
        sent = true;
      },
    });
    await expect(refused).rejects.toThrow("409");
    expect(sent).toBe(false);
  });
});

/**
 * Строка списка розсилок: видимое на экране обязано быть в дереве доступности.
 *
 * Однажды это уже сломали: чтобы имя ссылки не разрасталось до трёх строк
 * текста, начало текста и дату пометили `aria-hidden` — и они пропали у
 * диктора начисто. Глазами такая потеря не видна: экран остаётся прежним.
 * В 2.0 строка — ряд таблицы (comms-mailings), и проверяются её ячейки:
 * «Повідомлення» (тема и начало текста) и «Стан» (дата, охват).
 */

const ROW: MailingListItem = {
  id: "m1",
  title: "Тема повідомлення",
  preview: "Початок тексту розсилки",
  status: "sent",
  at: "2025-05-14T17:15:00.000Z",
  sentAt: "2025-05-14T17:15:00.000Z",
  recipientCount: 24,
  answeredCount: 18,
  readCount: 22,
  options: ["Так", "Ні"],
  answers: [15, 3],
  patientGroupId: "g1",
};

const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <LangProvider>
      <MemoryRouter>{node}</MemoryRouter>
    </LangProvider>,
  );

describe("строка списка розсилок", () => {
  test("начало текста и дата видны диктору: aria-hidden в ячейках нет", () => {
    const title = draw(<TitleCell m={ROW} />);
    expect(title).toContain(ROW.preview);
    expect(title, "видимое в строке спрятано от дерева доступности").not.toContain("aria-hidden");
    const state = draw(<StateCell m={ROW} />);
    /* формат даты меряет format.test; здесь важно одно — что она вообще в разметке */
    expect(state).toMatch(/>[^<]*\b14\b[^<]*17:15[^<]*</);
    expect(state).toContain("22");
  });

  test("имя ссылки — по-прежнему одна тема, а не вся строка", () => {
    /* перечень ссылок должен читаться темами, иначе диктор зачитывает абзацы */
    const inner = draw(<TitleCell m={ROW} />).match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
    expect(inner, "ссылки в строке не стало").not.toBeNull();
    expect(inner![1]).toBe(ROW.title);
  });

  test("ответы отправленной — числа по вариантам словами, не только цветом полосы", () => {
    const html = draw(<AnswersCell m={ROW} />);
    // полоса — украшение для глаза; числа и подписи вариантов стоят текстом рядом
    expect(html).toContain("Так");
    expect(html).toMatch(/>15</);
    expect(html).toMatch(/>3</);
    expect(html).toMatch(/18[^<]*24/);
  });

  test("черновик показывает варианты, а не нули ответов", () => {
    const html = draw(<AnswersCell m={{ ...ROW, status: "draft", answers: [0, 0], answeredCount: 0 }} />);
    expect(html).toContain("Так");
    expect(html).not.toMatch(/0[^<]*24/);
  });
});

describe("вид списка и полоса ответов", () => {
  test("вид из адреса: незнакомое значение — «усі»", () => {
    expect(mailingViewFrom("draft")).toBe("draft");
    expect(mailingViewFrom("archived")).toBe("all");
    expect(mailingViewFrom(null)).toBe("all");
  });

  test("вид — в параметры запроса: скрытые отдельным списком, состояние фильтром", () => {
    expect(mailingQuery("all")).toEqual({});
    expect(mailingQuery("draft")).toEqual({ status: "draft" });
    expect(mailingQuery("sent")).toEqual({ status: "sent" });
    expect(mailingQuery("hidden")).toEqual({ hidden: true });
  });

  test("доли полосы — от числа получателей, молчащие — остатком", () => {
    const s = answerShares([15, 3], 24);
    expect(s.option[0]).toBeCloseTo(15 / 24);
    expect(s.option[1]).toBeCloseTo(3 / 24);
    expect(s.silent).toBeCloseTo(6 / 24);
    // ответов больше, чем получателей (счётчики разошлись) — полоса не вылезает за край
    const over = answerShares([3, 2], 4);
    expect(over.option.reduce((a, b) => a + b, 0) + over.silent).toBeCloseTo(1);
    expect(answerShares([0, 0], 0)).toEqual({ option: [0, 0], silent: 0 });
  });

  test("шаблоны вариантов и «прибрати»", () => {
    const words = { yes: "Так", no: "Ні", maybe: "Ще не знаю" };
    expect(optionPreset("yesNo", words)).toEqual(["Так", "Ні"]);
    expect(optionPreset("yesNoMaybe", words)).toEqual(["Так", "Ні", "Ще не знаю"]);
    expect(optionPreset("none", words)).toEqual([]);
    expect(withoutOption(["а", "б", "в"], 1)).toEqual(["а", "в"]);
  });
});
