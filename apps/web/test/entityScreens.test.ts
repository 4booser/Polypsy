import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import * as messages from "../src/pages/Messages";
import { resourceQuery } from "../src/useResource";

/**
 * Экраны одной сущности не показывают прежнюю под адресом новой (#177).
 *
 * Слой загрузки по умолчанию держит прежний ответ, пока едет новый
 * (keepPreviousData): списку это и нужно — таблица не схлопывается на
 * каждую букву поиска. Экрану одного человека — нет: карточка A стояла под
 * адресом B как готовая, и «+ тест», «Підписатись» уходили на A. Экран
 * переписки держал набранный ответ в одном поле на все разговоры — и
 * ответ, набранный A, уходил B.
 */

const SRC = resolve(import.meta.dir, "../src");
const source = (f: string) => readFileSync(resolve(SRC, f), "utf8");

describe("keep: false — после смены id загрузка, а не данные прежнего", () => {
  /* механизм: то, что получает TanStack от useResource (resourceQuery) */
  async function afterSwitch(keep: boolean | undefined): Promise<unknown> {
    const client = new QueryClient();
    const load = (who: string) => () => (who === "A" ? Promise.resolve({ id: "A" }) : new Promise<never>(() => {}));
    const observer = new QueryObserver(client, resourceQuery(["card", "A"], load("A"), { keep }));
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    observer.setOptions(resourceQuery(["card", "B"], load("B"), { keep }));
    const shown = observer.getCurrentResult().data;
    stop();
    client.clear();
    return shown;
  }

  test("с keep: false под ключом B пусто — экран рисует загрузку", async () => {
    expect(await afterSwitch(false)).toBeUndefined();
  });

  test("положительный контроль: по умолчанию под ключом B стоит ответ A — так держат списки", async () => {
    expect(await afterSwitch(undefined)).toEqual({ id: "A" });
  });

  const screens: [string, string][] = [
    ["pages/patientCard/PatientCard.tsx", "useResource(() => api.patientCard(id), [id], { keep: false })"],
    /* «Хто це» реестра 2.0 — на месте прежней панели components/PatientContext */
    ["pages/patients/QuickView.tsx", "useResource(() => api.dynamics(id), [id], { enabled, keep: false })"],
    ["pages/Alerts.tsx", "useResource(() => api.caseSummary(userId), [userId], { keep: false, key: \"alerts:summary\" })"],
    ["pages/CaseCard.tsx", "{ enabled: !!userId, keep: false }"],
    /* хронология делит кэш с шапкой справы (общий ключ), keep: false — на месте */
    ["pages/Timeline.tsx", "{ enabled: !!userId, keep: false, key: TL_KEY }"],
  ];
  for (const [file, call] of screens) {
    test(`${file}: загрузка одного человека — с keep: false`, () => {
      expect(source(file)).toContain(call);
    });
  }

  test("pages/people/StaffCard.tsx: карточка сотрудника — с keep: false", () => {
    expect(source("pages/people/StaffCard.tsx")).toMatch(/useResource\(\(\) => loadMember\([\s\S]{0,200}?keep: false/);
  });
});

describe("остатки #177: заключение, протокол, группа, повідомлення (#200)", () => {
  const screens: [string, string][] = [
    ["pages/Conclusion.tsx", "[responseId],\n    { keep: false },"],
    ["pages/Conclusion.tsx", "[responseId], { manual: true, keep: false })"],
    ["pages/Conclusion.tsx", "enabled: !!surveyId,\n    keep: false,"],
    ["pages/response/index.tsx", "[rid], { enabled: !!rid, keep: false }"],
    ["pages/response/data.ts", "[id], { enabled: !!id, keep: false }"],
    ["pages/patientGroups/PatientGroupCard.tsx", "useResource(() => api.patientGroup(groupId), [groupId], { keep: false })"],
    ["pages/messages/MailingEditor.tsx", "useResource(() => api.mailing(id!), [id], { enabled: id !== null, keep: false })"],
  ];
  for (const [file, call] of screens) {
    test(`${file}: ${call.replace(/\s+/g, " ")}`, () => {
      expect(source(file)).toContain(call);
    });
  }

  test("заключение: название, набранное к прежнему прохождению, к новому не переходит", () => {
    expect(source("pages/Conclusion.tsx")).toContain('useEffect(() => setTitle(""), [responseId]);');
  });

  test("заключение: отказ 409 прежнего прохождения к новому не переходит", () => {
    const editor = source("components/ConclusionEditor.tsx");
    const reset = editor.indexOf("useEffect(() => setStale(null), [responseId]);");
    expect(reset, "строка «заключение переписали» живёт через смену прохождения").toBeGreaterThan(-1);
    // хук — до раннего возврата «загрузка»: иначе порядок хуков зависел бы от данных
    expect(reset).toBeLessThan(editor.indexOf("if (!state) {"));
  });

  test("положительный контроль: форма повідомлення по-прежнему пересоздаётся по адресу", () => {
    expect(source("pages/messages/MailingEditor.tsx")).toContain('<MailingEditor key={id ?? "new"} id={id ?? null} />');
  });
});

describe("набранный ответ — свой у каждого разговора", () => {
  type Drafts = Readonly<Record<string, string>>;
  const m = messages as {
    draftIn?: (d: Drafts, id: string | undefined) => string;
    withDraft?: (d: Drafts, id: string, text: string) => Drafts;
    afterSent?: (d: Drafts, id: string, sent: string) => Drafts;
  };

  test("набрал A, перешёл к B — поле пусто; вернулся к A — набранное на месте", () => {
    expect(m.withDraft).toBeFunction();
    const typed = m.withDraft!({}, "thread-a", "Добрий день, Ірино");
    expect(m.draftIn!(typed, "thread-b")).toBe("");
    const both = m.withDraft!(typed, "thread-b", "Петре, нагадую про запис");
    expect(m.draftIn!(both, "thread-a")).toBe("Добрий день, Ірино");
    expect(m.draftIn!(both, "thread-b")).toBe("Петре, нагадую про запис");
    expect(m.draftIn!(both, undefined)).toBe("");
  });

  test("отправлено — стирается черновик своего разговора, и только если его не дописали", () => {
    expect(m.afterSent).toBeFunction();
    const both = { "thread-a": "Привіт", "thread-b": "Чекаю" };
    expect(m.afterSent!(both, "thread-a", "Привіт")).toEqual({ "thread-a": "", "thread-b": "Чекаю" });
    const grown = { "thread-a": "Привіт, як ви?", "thread-b": "Чекаю" };
    expect(m.afterSent!(grown, "thread-a", "Привіт")).toEqual(grown);
  });

  test("экран держит черновики по разговору, а не одно поле на все", () => {
    const src = source("pages/Messages.tsx");
    expect(src).not.toContain('const [text, setText] = useState("")');
    expect(src).toContain("draftIn(drafts, id)");
    expect(src).toContain("afterSent(d, id, sent)");
  });
});
