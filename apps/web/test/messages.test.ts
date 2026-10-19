import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { UI, type PatientCard } from "@quizzy/shared";
import {
  daysFrom,
  feedByDay,
  orderThreads,
  slotsByDay,
  stepThread,
  threadInView,
  threadMatches,
  threadViewCounts,
  unansweredId,
  viewFrom,
  waitsForReply,
  type ThreadRow,
} from "../src/pages/messages/model";
import { ageOf, measureText, measuresOf, openFor } from "../src/pages/messages/thread";

/**
 * Экран переписки: три вещи, которые уже были сломаны и ломаются молча.
 *
 * Все три — про то, что видит человек, а не про то, что считает код, и ни
 * одну из них не ловит ни компилятор, ни проверка словаря. Имя, обрезанное
 * на «Гончаренко Та…», — валидная разметка. «Переписки нет» под списком из
 * четырёх переписок — валидная строка из словаря. Название экрана, вставшее
 * запасным значением в заголовок панели, — валидное выражение.
 *
 * Поэтому проверяется исходник экрана, а не отрисовка. Отрисовка здесь
 * ничего не решает: список приходит из сети, а обрезание имени — свойство
 * ширины колонки, которое меряет снимок экрана в e2e. Исходник же хранит
 * ровно то, что здесь важно: в каком ряду стоит имя, сколько раз экран зовёт
 * собственное название и различает ли он два пустых состояния.
 */

const WEB = resolve(import.meta.dir, "..");
const FILE = "apps/web/src/pages/Messages.tsx";
const source = readFileSync(join(WEB, "src/pages/Messages.tsx"), "utf8");

/*
 * Ключи словаря, названные в исходнике экрана.
 *
 * Ищется строковый литерал, а не обращение `ut("…")`: выбор состояния стоит
 * внутри вызова — `ut(data.items.length ? "ms.pick" : "ms.none")`, — и разбор
 * по вызову не видел бы ровно тех двух ключей, ради которых всё это.
 */
const calls = [...source.matchAll(/"([A-Za-z][A-Za-z0-9]*\.[A-Za-z0-9.]+)"/g)]
  .map((m) => m[1]!)
  .filter((key) => key in UI);

/**
 * Открывающий тег строки списка — от «<Link» до первого «>».
 *
 * Ни адрес, ни классы «>» не содержат, поэтому граница тега находится поиском
 * подстроки, без разбора JSX: разбор ради одного тега стоил бы дороже, чем всё,
 * что здесь проверяется.
 */
const rowTag = () => {
  const from = source.indexOf("<Link");
  if (from < 0) throw new Error(`${FILE}: строки списка нет — проверку надо переписать под новую разметку`);
  return source.slice(from, source.indexOf(">", from));
};

describe("список переписок", () => {
  test("строка списка — не горизонтальный ряд: имя не делит ширину с датой", () => {
    /*
     * Имя и дата стояли соседями во флексе, имя жало до `flex-1` и обрезалось
     * на «Гончаренко Та…» — в колонке 280 пикселей, при пустующих 750 справа.
     * Собеседника в переписке узнают по имени: обрезать можно что угодно,
     * только не его, поэтому имя заняло строку целиком, а дата ушла на
     * следующую.
     *
     * Вертикальный флекс (`flex-col`) это правило не нарушает — он как раз
     * ставит имя и дату друг под друга. Запрещён именно ряд.
     */
    const tag = rowTag();
    const isRow = /\bflex\b/.test(tag) && !/\bflex-col\b/.test(tag);
    expect(isRow, `${FILE}: строка списка снова флекс-ряд — «${tag.replace(/\s+/g, " ")}»`).toBe(false);
  });
});

describe("панель чтения", () => {
  test("«ничего не выбрано» и «ничего нет» — разные состояния и разные слова", () => {
    /*
     * Панель говорила «Переписки нет», когда переписка была — просто ни одна
     * не открыта: отрицала то, что в этот момент стояло слева в списке.
     * Состояний два, и врозь их держат два ключа. Схлопнуть их обратно в
     * один — значит снова соврать человеку про его же переписку.
     */
    const lost = `${FILE}: экран не зовёт`;
    expect(calls, `${lost} ms.pick — «выберите» снова схлопнуто в «ничего нет»`).toContain("ms.pick");
    expect(calls, `${lost} ms.none — пустому списку нечего сказать о себе`).toContain("ms.none");

    for (const lang of ["uk", "ru"] as const) {
      const same = `ms.pick и ms.none совпали на «${lang}» — два состояния одним текстом`;
      expect(UI["ms.pick"][lang], same).not.toBe(UI["ms.none"][lang]);
    }
  });

  test("название экрана стоит на экране один раз", () => {
    /*
     * Запасным значением заголовка панели стояло название экрана, и слово
     * «Переписка» оказывалось на экране трижды: заголовок страницы, заголовок
     * панели, пустое состояние. Трижды повторённое слово не сообщает ничего
     * сверх одного раза, зато занимает место, где должно стоять имя
     * собеседника.
     *
     * Считаются обращения к ключу, а не вхождения слова: «Выберите переписку
     * слева» и «Переписки нет» — разные сообщения, каждое по делу. Лишним
     * было именно второе обращение к ms.title.
     */
    const lines = source
      .split("\n")
      .map((text, i) => ({ text, line: i + 1 }))
      .filter((l) => l.text.includes('"ms.title"'))
      .map((l) => `${FILE}:${l.line}`);
    expect(lines.length, `название экрана зовётся ${lines.length} раз: ${lines.join(", ")}`).toBe(1);
  });
});

/* ─────────── консоль 2.0: список и запись (v2-comms) ─────────── */

const row = (id: string, over: Partial<ThreadRow> = {}): ThreadRow => ({
  id,
  withName: `Пацієнт ${id}`,
  patientId: `p-${id}`,
  lastMessageAt: "2026-10-08T10:00:00.000Z",
  unread: 0,
  preview: null,
  lastMine: null,
  lastReadAt: null,
  next: null,
  ...over,
});

describe("кто ждёт ответа", () => {
  test("ждёт — последнее письмо от пациента, а не «есть непрочитанное»", () => {
    /*
     * Прочитанное, но оставленное без ответа письмо ждёт так же; число
     * непрочитанных гаснет от одного открытия разговора, и по нему
     * «чекає відповіді» пропадало бы, ничего не дождавшись.
     */
    expect(waitsForReply({ lastMine: false })).toBe(true);
    expect(waitsForReply({ lastMine: true })).toBe(false);
    expect(waitsForReply({ lastMine: null }), "писем нет — ждать нечего").toBe(false);
    const read = row("a", { lastMine: false, unread: 0 });
    expect(threadInView(read, "wait")).toBe(true);
    expect(threadInView(read, "unread")).toBe(false);
  });

  test("порядок: ждущие с сигналом, ждущие, остальные; внутри — свежие сверху", () => {
    const items = [
      row("calm-new", { lastMine: true, lastMessageAt: "2026-10-08T16:00:00.000Z" }),
      row("wait-old", { lastMine: false, lastMessageAt: "2026-10-08T09:00:00.000Z" }),
      row("risk-older", { lastMine: false, lastMessageAt: "2026-10-07T19:40:00.000Z" }),
      row("wait-new", { lastMine: false, lastMessageAt: "2026-10-08T16:20:00.000Z" }),
      row("calm-old", { lastMine: true, lastMessageAt: "2026-10-01T09:00:00.000Z" }),
    ];
    const order = orderThreads(items, (pid) => pid === "p-risk-older").map((t) => t.id);
    expect(order).toEqual(["risk-older", "wait-new", "wait-old", "calm-new", "calm-old"]);
  });

  test("счётчики видов и поиск по имени и началу письма", () => {
    const items = [
      row("a", { unread: 2, lastMine: false, preview: "Чи можна пити мелатонін?" }),
      row("b", { lastMine: true, withName: "Бойко Тарас" }),
      row("c", { lastMine: false }),
    ];
    expect(threadViewCounts(items)).toEqual({ all: 3, unread: 1, wait: 2 });
    expect(items.filter((t) => threadMatches(t, "МЕЛАТОНІН")).map((t) => t.id)).toEqual(["a"]);
    expect(items.filter((t) => threadMatches(t, "бойко")).map((t) => t.id)).toEqual(["b"]);
    expect(items.filter((t) => threadMatches(t, "  ")).length).toBe(3);
    expect(viewFrom("wait")).toBe("wait");
    expect(viewFrom("archive"), "незнакомый вид из адреса — «усі»").toBe("all");
  });

  test("J/K: шаг по видимым строкам, по краям — стоп", () => {
    const order = ["a", "b", "c"];
    expect(stepThread(order, undefined, 1)).toBe("a");
    expect(stepThread(order, undefined, -1)).toBe("c");
    expect(stepThread(order, "b", 1)).toBe("c");
    expect(stepThread(order, "c", 1)).toBeNull();
    expect(stepThread(order, "a", -1)).toBeNull();
    expect(stepThread([], "a", 1)).toBeNull();
  });
});

describe("лента", () => {
  test("дни — разделитель перед первым письмом дня; без ответа — последнее письмо пациента", () => {
    const items = [
      { id: "1", mine: true, sentAt: "2026-09-25T10:05:00.000Z" },
      { id: "2", mine: false, sentAt: "2026-10-02T09:15:00.000Z" },
      { id: "3", mine: true, sentAt: "2026-10-02T09:40:00.000Z" },
      { id: "4", mine: false, sentAt: "2026-10-07T16:40:00.000Z" },
    ];
    const days = feedByDay(items, (iso) => iso.slice(0, 10));
    expect(days.map((d) => [d.key, d.items.map((m) => m.id)])).toEqual([
      ["2026-09-25", ["1"]],
      ["2026-10-02", ["2", "3"]],
      ["2026-10-07", ["4"]],
    ]);
    expect(unansweredId(items)).toBe("4");
    expect(unansweredId(items.slice(0, 3)), "последнее — моё: ответ дан").toBeNull();
    expect(unansweredId([])).toBeNull();
  });

  test("дни — по местным полуночам, а не сутками от «сейчас»", () => {
    const now = new Date(2026, 9, 8, 23, 30).getTime();
    expect(daysFrom(new Date(2026, 9, 9, 0, 30).toISOString(), now), "через час, но завтра").toBe(1);
    expect(daysFrom(new Date(2026, 9, 8, 0, 5).toISOString(), now)).toBe(0);
    expect(daysFrom(new Date(2026, 9, 7, 19, 40).toISOString(), now)).toBe(-1);
  });
});

describe("перенос приёма", () => {
  test("окна по дням: без прошедших и без самого приёма, по времени", () => {
    const now = Date.parse("2026-10-08T14:00:00.000Z");
    const slot = (id: string, startsAt: string) => ({ id, startsAt, endsAt: startsAt, room: "214" });
    const byDay = slotsByDay(
      [
        slot("late", "2026-10-10T15:00:00.000Z"),
        slot("past", "2026-10-08T09:00:00.000Z"),
        slot("own", "2026-10-10T07:30:00.000Z"),
        slot("early", "2026-10-10T14:00:00.000Z"),
        slot("next-week", "2026-10-13T08:00:00.000Z"),
      ],
      (iso) => iso.slice(0, 10),
      now,
      "2026-10-10T07:30:00.000Z",
    );
    expect([...byDay.keys()]).toEqual(["2026-10-10", "2026-10-13"]);
    expect(byDay.get("2026-10-10")!.map((s) => s.id)).toEqual(["early", "late"]);
  });
});

describe("запись: возраст, сигнал, заміри", () => {
  test("полных лет — с учётом дня рождения в этом году", () => {
    const now = new Date(2026, 9, 8).getTime();
    expect(ageOf("1988-05-12", now)).toBe(38);
    expect(ageOf("1988-11-12", now), "день рождения ещё не наступил").toBe(37);
    expect(ageOf(null, now)).toBeNull();
    expect(ageOf("не дата", now)).toBeNull();
  });

  test("сколько открыт сигнал: часы в первые сутки, дальше дни", () => {
    expect(openFor(168, "{n} дн.")).toBe("2:48");
    expect(openFor(5, "{n} дн.")).toBe("0:05");
    expect(openFor(9 * 24 * 60 + 300, "{n} дн."), "216:19 читалось бы как время суток").toBe("9 дн.");
  });

  test("заміри: последний по методике, одна шкала с тяжестью, история той же шкалы", () => {
    const scale = (code: string, value: number, severity: "mild" | "moderate" | null = null) => ({
      code,
      title: code,
      value,
      normalization: "raw" as const,
      percent: 0,
      bandLabel: severity ? "помірна" : null,
      severity,
    });
    const resp = (surveyId: string, at: string, scales: ReturnType<typeof scale>[]) => ({
      responseId: `${surveyId}-${at}`,
      surveyId,
      surveyTitle: surveyId.toUpperCase(),
      submittedAt: at,
      reliable: true,
      scales,
    });
    const card = {
      responses: [
        resp("phq", "2026-08-24", [scale("lie", 1), scale("total", 19, "moderate")]),
        resp("gad", "2026-09-01", [scale("total", 11, "moderate")]),
        resp("phq", "2026-09-11", [scale("lie", 0), scale("total", 16, "moderate")]),
        resp("phq", "2026-10-08", [scale("lie", 0), scale("total", 14, "moderate")]),
        resp("empty", "2026-10-09", []),
      ],
    } as unknown as Pick<PatientCard, "responses">;
    const lines = measuresOf(card);
    expect(lines.map((l) => l.surveyId), "свежие сверху, без прохождений без шкал").toEqual(["phq", "gad"]);
    expect(lines[0]).toMatchObject({ code: "total", value: 14, history: [19, 16, 14], word: "помірна" });
    expect(lines[1]!.history, "один замер — истории нет").toEqual([11]);
  });

  test("число замера — запятой языка и процентом для доли, а не голым «2.67» и «0.73»", () => {
    expect(measureText(14, "raw", "uk-UA")).toBe("14");
    expect(measureText(2.67, "raw", "uk-UA")).toBe("2,7");
    expect(measureText(2.67, "raw", "ru-RU")).toBe("2,7");
    expect(measureText(2.67, "raw", "en-GB")).toBe("2.7");
    expect(measureText(0.734, "ratio", "uk-UA")).toBe("73 %");
    expect(measureText(52.3, "tscore", "uk-UA")).toBe("52,3");
  });
});
