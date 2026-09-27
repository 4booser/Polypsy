import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { type SurveyListItem, UI, type UiKey } from "@quizzy/shared";
import { ApiError, type NoteState, type NoteVersion } from "../src/api";
import { LangProvider } from "../src/lang";
import { AssignForm, ProtocolBody } from "../src/pages/Visit";
import {
  type AssignDraft,
  EMPTY_PROTOCOL,
  NEW_ASSIGN,
  type NoteBase,
  type Protocol,
  type ProtocolEvent,
  assignBody,
  assignProblems,
  assignReady,
  protocolSavable,
  protocolStep,
} from "../src/pages/visitModel";
import type { Resource } from "../src/useResource";

/**
 * Экран приёма: протокол (w14:webtails).
 *
 * Протокол — заметка о человеке, и сервер сверяет её сохранение с версией и
 * редакцией, которые экран прислал как «видел» (routes/notes.ts). Экран
 * приёма проверок поведения не имел, и нашлось, что присылал он не
 * увиденное, а пришедшее последним; при отказе загрузки поле стояло
 * пустым, как у человека без записей. Здесь — ровно эти пути: на
 * подставном сервере, который сверяет базу так же, как настоящий, и на
 * разметке протокола в каждом состоянии загрузки.
 */

const note = (over: Partial<NoteVersion> = {}): NoteVersion => ({
  id: "n1",
  version: 1,
  revision: 1,
  kind: "session",
  text: "Черновик колеги",
  status: "draft",
  createdAt: "2026-09-27T08:00:00.000Z",
  authorName: "Коваль",
  signedAt: null,
  ...over,
});

const stateOf = (current: NoteVersion | null): NoteState => ({ current, versions: current ? [current] : [] });

/**
 * Подставной сервер заметок: сверяет базу так же, как PUT /api/notes
 * (baseVersion — версия базы или 0, baseRevision — её редакция), правит
 * черновик на месте и заводит новую версию поверх подписанной.
 */
function notesServer(start: NoteVersion | null) {
  let latest = start;
  return {
    now: () => latest,
    /** Правка коллеги в соседнем кабинете — мимо экрана */
    colleague: (text: string) => {
      latest = latest && latest.status === "draft" ? { ...latest, text, revision: latest.revision + 1 } : note({ text, version: (latest?.version ?? 0) + 1 });
      return stateOf(latest);
    },
    /** То, что делает api.saveNote: база null — «записей не было» */
    save: async (text: string, base: NoteBase | null): Promise<NoteState> => {
      const baseVersion = base?.version ?? 0;
      if (baseVersion !== (latest?.version ?? 0)) throw new ApiError("Запис змінився", 409);
      if (base && latest && latest.revision !== base.revision) throw new ApiError("Чернетку змінили", 409);
      latest =
        latest && latest.status === "draft"
          ? { ...latest, text, revision: latest.revision + 1 }
          : note({ id: `n${(latest?.version ?? 0) + 1}`, version: (latest?.version ?? 0) + 1, revision: 1, text, authorName: "Я" });
      return stateOf(latest);
    },
  };
}

const run = (events: ProtocolEvent[], start: Protocol = EMPTY_PROTOCOL) => events.reduce(protocolStep, start);

describe("протокол: поверх чего сохраняется", () => {
  test("поле открывает только ответ сервера; до него набирать некуда", () => {
    expect(EMPTY_PROTOCOL.text).toBeNull();
    // правка до ответа — не принимается: поля ещё нет
    expect(run([{ type: "edit", text: "Скарги на сон" }]).text).toBeNull();
    expect(protocolSavable(EMPTY_PROTOCOL)).toBe(false);
    const p = run([{ type: "loaded", state: stateOf(note()) }]);
    expect(p).toMatchObject({ text: "Черновик колеги", seen: { version: 1, revision: 1 } });
  });

  test("запись перечиталась сама — база остаётся увиденной, и чужая правка не затирается молча", async () => {
    /*
     * Было: сохранение уходило с базой последнего пришедшего ответа. Коллега
     * переписал черновик, запись перечиталась сама (вернулась связь), и
     * сохранение уходило с его свежей редакцией под текстом, набранным
     * поверх прежней: сервер принимал, правка коллеги исчезала.
     */
    const server = notesServer(note());
    let p = run([{ type: "loaded", state: stateOf(server.now()) }]);
    p = protocolStep(p, { type: "edit", text: "Черновик колеги, дописано мною" });

    const fresh = server.colleague("Черновик колеги, виправлено колегою");
    p = protocolStep(p, { type: "loaded", state: fresh });
    // набранное на месте, база — та, что видел человек
    expect(p.text).toBe("Черновик колеги, дописано мною");
    expect(p.seen).toEqual({ version: 1, revision: 1 });

    await expect(server.save(p.text!, p.seen)).rejects.toMatchObject({ status: 409 });
    expect(server.now()?.text).toBe("Черновик колеги, виправлено колегою");
    // прежняя база (последний ответ) сервер бы пропустил — вот что было потерей
    const latest = fresh.current!;
    await expect(notesServer(latest).save("затирає", latest)).resolves.toBeDefined();
  });

  test("база null — «записей не было»: первая версия заводится, а успевший первым коллега защищён", async () => {
    const empty = notesServer(null);
    const p = run([{ type: "loaded", state: stateOf(null) }, { type: "edit", text: "Первинна бесіда" }]);
    expect(p.seen).toBeNull();
    const saved = await empty.save(p.text!, p.seen);
    expect(saved.current).toMatchObject({ version: 1, revision: 1, text: "Первинна бесіда" });

    // пока протокол был открыт, коллега завёл запись первым: «записей не было» больше не правда
    const raced = notesServer(null);
    raced.colleague("Запис колеги");
    await expect(raced.save(p.text!, p.seen)).rejects.toMatchObject({ status: 409 });
    expect(raced.now()?.text).toBe("Запис колеги");
  });

  test("своё сохранение сдвигает базу сразу: второе «Зберегти» не упирается в 409 с самим собой", async () => {
    /*
     * Было: база обновлялась перечитыванием, которое шло после сохранения;
     * «Зберегти» ещё раз до его конца уходило со старой редакцией.
     */
    const server = notesServer(note());
    let p = run([{ type: "loaded", state: stateOf(server.now()) }, { type: "edit", text: "Перша правка" }]);
    p = protocolStep(p, { type: "saved", state: await server.save(p.text!, p.seen) });
    expect(p.seen).toEqual({ version: 1, revision: 2 });
    p = protocolStep(p, { type: "edit", text: "Друга правка" });
    const second = await server.save(p.text!, p.seen);
    expect(second.current).toMatchObject({ revision: 3, text: "Друга правка" });
  });

  test("«перечитати» после 409 кладёт в поле запись сервера вместе с её базой", async () => {
    const server = notesServer(note());
    let p = run([{ type: "loaded", state: stateOf(server.now()) }, { type: "edit", text: "Моє" }]);
    const fresh = server.colleague("Колеги");
    p = protocolStep(p, { type: "reread", state: fresh });
    expect(p).toMatchObject({ text: "Колеги", seen: { version: 1, revision: 2 } });
    await expect(server.save(`${p.text} + моє`, p.seen)).resolves.toBeDefined();
  });

  test("поверх подписанной записи сохраняется новой версией, база — подписанная", async () => {
    const server = notesServer(note({ status: "signed", text: "Минулий прийом" }));
    const p = run([{ type: "loaded", state: stateOf(server.now()) }, { type: "edit", text: "Сьогоднішній прийом" }]);
    const saved = await server.save(p.text!, p.seen);
    expect(saved.current).toMatchObject({ version: 2, revision: 1, text: "Сьогоднішній прийом" });
  });

  test("стенограмма, вставленная до ответа о записи, встаёт после текста записи, а не вместо него", () => {
    const p = run([
      { type: "append", text: "Стенограма" },
      { type: "loaded", state: stateOf(note()) },
    ]);
    expect(p.text).toBe("Черновик колеги\n\nСтенограма");
    expect(p.seen).toEqual({ version: 1, revision: 1 });
    expect(protocolStep(p, { type: "append", text: "Ще" }).text).toBe("Черновик колеги\n\nСтенограма\n\nЩе");
  });

  test("пробелы — не протокол: сохранить нечего (они легли бы пустой записью поверх черновика)", () => {
    const loaded = run([{ type: "loaded", state: stateOf(null) }]);
    expect(protocolSavable(loaded)).toBe(false);
    expect(protocolSavable(protocolStep(loaded, { type: "edit", text: "  \n " }))).toBe(false);
    expect(protocolSavable(protocolStep(loaded, { type: "edit", text: "Скарги" }))).toBe(true);
  });

  test("экран шлёт увиденную базу и кладёт ответ сохранения сразу", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Visit.tsx"), "utf8");
    // база — из протокола, а не из последнего ответа о записи
    expect(src).toMatch(/api\.saveNote\([\s\S]*?protocol\.seen,[\s\S]*?\)/);
    expect(src).not.toContain("notes.data?.current");
    expect(src).toMatch(/notes\.patch\(saved\);\s*dispatch\(\{ type: "saved", state: saved \}\)/);
    // запись — только когда известно, о ком
    expect(src).toContain("{ enabled: !!patientId }");
  });

  test("другой приём — чистый протокол: экран пересоздаётся по приёму, а не наследует набранное", () => {
    /*
     * Было: переход с приёма на приём (палитра, «назад») оставлял экран на
     * месте вместе с набранным протоколом и его базой — текст о прежнем
     * человеке стоял в поле нового и по «Зберегти» ложился в его записи.
     * Смену экрана без браузера не нарисовать: закрепляется ключ по приёму.
     */
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Visit.tsx"), "utf8");
    expect(src).toMatch(/export default function VisitPage\(\) \{\s*const \{ id = "" \} = useParams\(\);[\s\S]*?return <VisitScreen key=\{id\} id=\{id\} \/>;\s*\}/);
    // протокол живёт внутри пересоздаваемого экрана, а не над ним
    const screen = src.slice(src.indexOf("function VisitScreen("));
    expect(screen).toContain("useReducer(protocolStep, EMPTY_PROTOCOL)");
  });
});

/* ─────────── разметка протокола ─────────── */

const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

const has = (html: string, key: UiKey) => {
  const e = UI[key] as { uk: string; ru: string; en?: string };
  return [e.uk, e.ru, e.en].some((t) => !!t && html.includes(t));
};

const OOPS = "Сервер тимчасово недоступний";

function res<T = NoteState>(over: Partial<Resource<T>> = {}): Resource<T> {
  return {
    data: null,
    loading: false,
    refreshing: false,
    error: null,
    offline: false,
    updatedAt: null,
    reload: () => {},
    patch: () => {},
    ...over,
  };
}

const body = (notes: Resource<NoteState>, protocol: Protocol, opts: { busy?: boolean; stale?: string | null } = {}) =>
  draw(
    <ProtocolBody
      notes={notes}
      protocol={protocol}
      template="Скарги: …"
      busy={opts.busy ?? false}
      stale={opts.stale ?? null}
      areaRef={{ current: null }}
      onEvent={() => {}}
      onSave={() => {}}
      onReread={() => {}}
    />,
  );

/** Кнопка «Зберегти»: погашена ли — по атрибуту, а не по классам */
const saveOff = (html: string) => {
  const e = UI["visit.save"] as { uk: string; ru: string; en: string };
  const button = [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].find((m) => [e.uk, e.ru, e.en].includes(m[2]!));
  if (!button) throw new Error("кнопки «Зберегти» нет");
  return /\sdisabled=""/.test(button[1]!);
};

describe("протокол на экране", () => {
  test("запись не загрузилась — отказ с «повторити», а не пустое поле", () => {
    /* было: пустое поле, как у человека без записей, и живое «Зберегти» */
    const html = body(res({ error: OOPS }), EMPTY_PROTOCOL);
    expect(html).toContain(OOPS);
    expect(has(html, "common.retry")).toBe(true);
    expect(html).not.toContain("<textarea");
    expect(has(html, "visit.save")).toBe(false);
  });

  test("пока ответа нет или пропала связь — скелет, поля нет", () => {
    for (const notes of [res({ loading: true }), res({ offline: true }), res()]) {
      const html = body(notes, EMPTY_PROTOCOL);
      expect(html).toContain('aria-busy="true"');
      expect(html).not.toContain("<textarea");
    }
  });

  test("ответ пришёл — поле с текстом записи; записей нет — пустое поле с заготовкой в подсказке", () => {
    const withNote = body(res({ data: stateOf(note()), updatedAt: 1 }), run([{ type: "loaded", state: stateOf(note()) }]));
    expect(withNote).toMatch(/<textarea[^>]*>Черновик колеги<\/textarea>/);
    const none = body(res({ data: stateOf(null), updatedAt: 1 }), run([{ type: "loaded", state: stateOf(null) }]));
    expect(none).toMatch(/<textarea[^>]*placeholder="Скарги: …"[^>]*><\/textarea>/);
  });

  test("«Зберегти»: погашена без текста и на время сохранения, жива с текстом", () => {
    const loaded = run([{ type: "loaded", state: stateOf(null) }]);
    const typed = protocolStep(loaded, { type: "edit", text: "Скарги на сон" });
    const answered = res({ data: stateOf(null), updatedAt: 1 });
    expect(saveOff(body(answered, loaded))).toBe(true);
    expect(saveOff(body(answered, protocolStep(loaded, { type: "edit", text: "   " })))).toBe(true);
    expect(saveOff(body(answered, typed))).toBe(false);
    expect(saveOff(body(answered, typed, { busy: true }))).toBe(true);
  });

  test("409 — строкой у кнопок с «перечитати», набранное на месте", () => {
    const typed = run([{ type: "loaded", state: stateOf(note()) }, { type: "edit", text: "Моє" }]);
    const html = body(res({ data: stateOf(note()), updatedAt: 1 }), typed, { stale: "Чернетку змінили" });
    expect(html).toMatch(/role="alert"[\s\S]*Чернетку змінили/);
    expect(has(html, "integrity.reread")).toBe(true);
    expect(html).toMatch(/<textarea[^>]*>Моє<\/textarea>/);
  });
});

/* ─────────── назначение методики на приёме ─────────── */

describe("«Призначити методику» на приёме", () => {
  const TODAY = "2026-09-27";
  const draft = (over: Partial<AssignDraft> = {}): AssignDraft => ({ ...NEW_ASSIGN, surveyId: "s1", ...over });

  test("срок в прошлом не уходит: слова у поля, кнопка ждёт; сегодня и «без срока» — можно", () => {
    /* было: форма приёма слала любую дату, и доступ истекал раньше, чем человек о нём узнавал */
    expect(assignProblems(draft({ due: "2026-09-26" }), TODAY).due).toBe("uit.form.pastDeadline");
    expect(assignReady(draft({ due: "2026-09-26" }), TODAY)).toBe(false);
    expect(assignReady(draft({ due: TODAY }), TODAY)).toBe(true);
    expect(assignReady(draft({ due: "" }), TODAY)).toBe(true);
    expect(assignBody(draft({ due: "" })).expiresAt).toBeNull();
  });

  test("попытки — целое от 1 до 10; стёртое поле — не ноль на сервер, а слова у поля", () => {
    /* было: Number("") = 0 уходил на сервер, и тот отвечал отказом схемы */
    for (const bad of ["", " ", "0", "11", "1.5", "два"]) {
      expect(assignProblems(draft({ attempts: bad }), TODAY).attempts, bad).toBe("wt.visit.attempts");
      expect(assignReady(draft({ attempts: bad }), TODAY), bad).toBe(false);
    }
    expect(assignBody(draft({ attempts: " 3 " })).attempts).toBe(3);
    expect(assignReady(draft({ attempts: "10" }), TODAY)).toBe(true);
  });

  test("без выбранной методики назначать нечего — и это не ошибка у поля", () => {
    expect(assignReady(NEW_ASSIGN, TODAY)).toBe(false);
    expect(assignProblems(NEW_ASSIGN, TODAY)).toEqual({});
  });

  const surveys = [
    { id: "s1", title: "PHQ-9", status: "published", archivedAt: null },
    { id: "s2", title: "Чернетка", status: "draft", archivedAt: null },
    { id: "s3", title: "Знята", status: "published", archivedAt: "2026-09-01T00:00:00.000Z" },
  ] as unknown as SurveyListItem[];

  const form = (list: Resource<SurveyListItem[]>, d: AssignDraft, busy = false) =>
    draw(
      <AssignForm surveys={list} draft={d} todayKey={TODAY} busy={busy} onEdit={() => {}} onSubmit={() => {}} onCancel={() => {}} />,
    );
  const assignOff = (html: string) => {
    const e = UI["visit.assign"] as { uk: string; ru: string; en: string };
    const button = [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].find((m) => [e.uk, e.ru, e.en].includes(m[2]!));
    if (!button) throw new Error("кнопки «Призначити» нет");
    return /\sdisabled=""/.test(button[1]!);
  };

  test("методики не пришли — отказ с «повторити» на месте выбора, а не пустой выбор", () => {
    const failed = form(res<SurveyListItem[]>({ error: OOPS }), NEW_ASSIGN);
    expect(failed).toContain(OOPS);
    expect(has(failed, "common.retry")).toBe(true);
    expect(failed).not.toContain("<select");
    expect(form(res<SurveyListItem[]>({ loading: true }), NEW_ASSIGN)).toContain('aria-busy="true"');
  });

  test("в выборе — только опубликованные и не снятые", () => {
    const html = form(res<SurveyListItem[]>({ data: surveys, updatedAt: 1 }), NEW_ASSIGN);
    expect(html).toContain("PHQ-9");
    expect(html).not.toContain("Чернетка");
    expect(html).not.toContain("Знята");
  });

  test("кнопка: ждёт методику, гаснет на прошедшем сроке и на время отправки", () => {
    const answered = res<SurveyListItem[]>({ data: surveys, updatedAt: 1 });
    expect(assignOff(form(answered, NEW_ASSIGN))).toBe(true);
    expect(assignOff(form(answered, draft()))).toBe(false);
    expect(assignOff(form(answered, draft(), true))).toBe(true);
    const past = form(answered, draft({ due: "2026-09-01" }));
    expect(assignOff(past)).toBe(true);
    expect(has(past, "uit.form.pastDeadline")).toBe(true);
    expect(past).toContain('aria-invalid="true"');
  });
});
