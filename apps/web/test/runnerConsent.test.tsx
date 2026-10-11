import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { UI } from "@quizzy/shared";
import { ApiError } from "../src/api";
import { LangProvider } from "../src/lang";
import { ConsentScreen } from "../src/patient/ConsentGate";
import { acceptAndResend, cabinetIo, sendAnswers, type SubmitBody } from "../src/patient/sendAnswers";

/**
 * Новая редакция согласия посреди методики (#171).
 *
 * Редакцию опубликовали, пока человек отвечал: сдача — 403 «спершу прийміть
 * згоду». Принять её можно было только на /me — прохождение
 * размонтировалось, и ответы, жившие лишь в его состоянии, пропадали; в
 * очередь такая сдача не ложилась. Теперь согласие принимается на месте, и
 * после принятия уходит та же сдача — то же тело, тот же clientRequestId.
 *
 * Проверяется через настоящий клиент API (api.ts) с подменённым fetch: в
 * сравнении — тела запросов, которые ушли бы на сервер.
 */

/** Хранилище в памяти: клиент читает токен из localStorage, которого в bun нет */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

type Call = { url: string; method: string; body: string };
type Reply = { status: number; body: unknown };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
const saved = { fetch: globalThis.fetch, localStorage: g.localStorage, sessionStorage: g.sessionStorage };
beforeEach(() => {
  g.localStorage = memoryStorage();
  g.sessionStorage = memoryStorage();
});
afterEach(() => {
  globalThis.fetch = saved.fetch;
  g.localStorage = saved.localStorage;
  g.sessionStorage = saved.sessionStorage;
});

/** Сервер по маршрутам: каждому — очередь ответов по порядку */
function server(routes: Record<string, Reply[]>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: String(init?.body ?? "") });
    const reply = routes[`${method} ${url}`]?.shift();
    if (!reply) throw new Error(`нет ответа на ${method} ${url}`);
    return json(reply.status, reply.body);
  }) as typeof fetch;
  return calls;
}

const SUBMIT = "POST /api/surveys/s1/responses";
const STATUS = "GET /api/consents/me";
const ACCEPT = "POST /api/consents/me/accept";

/* с #201 отказ несёт код — по нему, а не по фразе, сдача узнаёт «нужно согласие» */
const refused = {
  status: 403,
  body: { error: "Спершу прийміть інформовану згоду — без неї відповіді не приймаються", code: "err.consentRequired" },
};
const newEdition = (textId: string, text: string) => ({
  status: 200,
  body: { required: true, accepted: false, version: 2, textId, text },
});

const body = (): SubmitBody => ({
  versionId: "v1",
  startedAt: "2026-10-11T09:00:00.000Z",
  durationMs: 184_000,
  answers: [
    { questionId: "q1", optionIds: ["q1-o2"], durationMs: 4100, changeCount: 0, visitCount: 1 },
    { questionId: "q2", number: 3, durationMs: 2900, changeCount: 0, visitCount: 1 },
  ],
  events: [],
  clientRequestId: "req-7f1c",
});

const submits = (calls: Call[]) => calls.filter((c) => `${c.method} ${c.url}` === SUBMIT).map((c) => c.body);

describe("403 «примите согласие» посреди методики", () => {
  test("после 403 и принятия уходят те же ответы — тем же телом и clientRequestId", async () => {
    const calls = server({
      [SUBMIT]: [refused, { status: 201, body: { id: "r1", safetyPlan: null } }],
      [STATUS]: [newEdition("t2", "Нова редакція згоди")],
      [ACCEPT]: [{ status: 200, body: { ok: true } }],
    });
    const io = cabinetIo(null);

    const held = await sendAnswers(io, "s1", body());
    expect(held.kind).toBe("consent");
    if (held.kind !== "consent") return;
    // на экране — новая редакция, принимать — её
    expect(held.status.text).toBe("Нова редакція згоди");
    expect(held.error).toBeNull();

    const outcome = await acceptAndResend(io, held, "Помилка");
    expect(outcome).toEqual({ kind: "sent", safetyPlan: null });

    const sent = submits(calls);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]!);
    expect(JSON.parse(sent[1]!)).toEqual(body());
    // принята показанная редакция, а не «какая-нибудь действующая»
    const accept = calls.find((c) => `${c.method} ${c.url}` === ACCEPT)!;
    expect(JSON.parse(accept.body)).toEqual({ textId: "t2" });
  });

  test("редакция сменилась ещё раз, пока человек читал: новый текст и причина, сдача по-прежнему держится", async () => {
    const calls = server({
      [SUBMIT]: [refused, { status: 201, body: { id: "r1", safetyPlan: "Зателефонуйте 7333" } }],
      [STATUS]: [newEdition("t2", "Редакція 2"), newEdition("t3", "Редакція 3")],
      [ACCEPT]: [
        { status: 409, body: { error: "Текст згоди змінився, поки ви його читали" } },
        { status: 200, body: { ok: true } },
      ],
    });
    const io = cabinetIo(null);
    const first = await sendAnswers(io, "s1", body());
    if (first.kind !== "consent") throw new Error("ожидалось удержание");

    const again = await acceptAndResend(io, first, "Помилка");
    expect(again.kind).toBe("consent");
    if (again.kind !== "consent") return;
    expect(again.status.textId).toBe("t3");
    expect(again.status.text).toBe("Редакція 3");
    expect(again.error).toContain("Текст згоди змінився");
    expect(submits(calls)).toHaveLength(1);

    const done = await acceptAndResend(io, again, "Помилка");
    expect(done).toEqual({ kind: "sent", safetyPlan: "Зателефонуйте 7333" });
    const sent = submits(calls);
    expect(sent[1]).toBe(sent[0]!);
  });

  test("403 не о согласии — отказ как был: ответы на экране, удержания нет", async () => {
    server({
      [SUBMIT]: [{ status: 403, body: { error: "Методика вам не призначена" } }],
      [STATUS]: [{ status: 200, body: { required: true, accepted: true, version: 2, textId: "t2", text: "т" } }],
    });
    const error = await sendAnswers(cabinetIo(null), "s1", body()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).message).toBe("Методика вам не призначена");
  });

  test("временный отказ, как и раньше, кладёт сдачу в очередь тем же телом", async () => {
    server({ [SUBMIT]: [{ status: 503, body: { error: "Тривають технічні роботи", code: "maintenance" } }] });
    const queued: SubmitBody[] = [];
    const outcome = await sendAnswers(cabinetIo((_, b) => void queued.push(b)), "s1", body());
    expect(outcome).toEqual({ kind: "queued" });
    expect(queued).toEqual([body()]);
  });
});

describe("экран согласия в прохождении", () => {
  const has = (html: string, key: keyof typeof UI) => {
    const e = UI[key] as { uk: string; ru: string; en?: string };
    return [e.uk, e.ru, e.en].some((t) => !!t && html.includes(t));
  };

  test("сказано, что ответы ждут на экране; кроме «погоджуюся» и «ні» — возврат к ответам", () => {
    const html = renderToStaticMarkup(
      <LangProvider>
        <ConsentScreen
          view={{ kind: "read", text: "Нова редакція згоди" }}
          busy={false}
          error={null}
          note={UI["pw.consentHeld"].uk}
          onAction={() => {}}
          after={<button type="button">{UI["pw.backToAnswers"].uk}</button>}
        />
      </LangProvider>,
    );
    expect(html).toContain("Нова редакція згоди");
    expect(has(html, "pw.consentHeld")).toBe(true);
    expect(has(html, "consent.accept")).toBe(true);
    expect(has(html, "consent.decline")).toBe(true);
    expect(has(html, "pw.backToAnswers")).toBe(true);
  });

  test("Runner держит сдачу и принимает согласие на месте, а не уводит на /me", () => {
    const runner = readFileSync(resolve(import.meta.dir, "../src/patient/Runner.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(runner).toContain("sendAnswers(io, survey.id, body)");
    expect(runner).toContain("acceptAndResend(io, held,");
    expect(runner).toContain("<ConsentScreen");
    expect(runner).toContain('ut("pw.consentHeld")');
  });
});
