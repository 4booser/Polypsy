import { beforeEach, describe, expect, test } from "bun:test";
import { resetStore } from "./store.mock";
import { json, loadClient, serve, session, signIn, useFakeServer } from "./client.harness";
import { enqueue, rejectedItems } from "../src/offline/queue";

/**
 * Ответ обмена refresh потерялся после фиксации (#144).
 *
 * Было: вход; `refresh(R1)` → 200, ответ (R2) потерян; повтор `refresh(R1)`
 * → 401 (сервер счёл кражей и погасил семью). Клиент: первый обмен
 * `unavailable`, второй `invalid`, flush → `rejected: 1` «Сесія
 * закінчилася» — человека выкидывало на вход, сданное без сети выпадало из
 * повтора.
 *
 * Стало: повтор обмена идёт с тем же ключом попытки (requestId), и сервер
 * отдаёт ту же новую пару (apps/api/test/refreshRetry.test.ts). Сервер здесь
 * подменён и ведёт себя по тому же договору: повтор с тем же ключом, пока
 * новая пара не предъявлена, — та же пара; иначе — гашение семьи.
 */

useFakeServer();

const ownerOf = () => `patient-${crypto.randomUUID().slice(0, 8)}`;

/** Access-токен с нужным sub и номером выдачи: владелец по нему тот же, а сервер их различает */
function accessOf(sub: string, n: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ sub, n })}.sig`;
}

/**
 * Сервер сессий по договору lib/refresh.ts: refresh одноразов; повтор
 * повёрнутого — та же пара, если ключ попытки тот же и преемник не
 * предъявлен; иначе семья гаснет. `lose` — сколько ответов обмена потерять
 * ПОСЛЕ фиксации поворота (обрыв на ответе).
 */
function sessionServer(owner: string, opts: { lose: number; refuseRefresh?: boolean }) {
  const st = {
    lose: opts.lose,
    issued: 1,
    access: null as string | null, // действующий access; токен входа считается истёкшим
    live: new Set([`refresh-${owner}`]),
    rotated: new Map<string, { requestId?: string; successor: string; token: string }>(),
    revokedFamily: false,
    exchanges: [] as { refreshToken: string; requestId?: string }[],
    accepted: [] as string[],
  };
  serve((path, init) => {
    if (path === "/api/auth/refresh") {
      const body = JSON.parse(String(init.body)) as { refreshToken: string; requestId?: string };
      st.exchanges.push(body);
      if (opts.refuseRefresh || st.revokedFamily) return json(401, { error: "Сесія закінчилася" });
      const prev = st.rotated.get(body.refreshToken);
      if (prev) {
        if (body.requestId && prev.requestId === body.requestId && st.live.has(prev.successor)) {
          return json(200, { token: prev.token, refreshToken: prev.successor });
        }
        st.revokedFamily = true; // повтор погашенного — кража
        st.access = null;
        return json(401, { error: "Сесія закінчилася" });
      }
      if (!st.live.has(body.refreshToken)) return json(401, { error: "Сесія закінчилася" });
      st.live.delete(body.refreshToken);
      const successor = body.requestId ? `r-${body.requestId}` : `r-${crypto.randomUUID()}`;
      const token = accessOf(owner, ++st.issued);
      st.live.add(successor);
      st.rotated.set(body.refreshToken, { requestId: body.requestId, successor, token });
      st.access = token;
      if (st.lose-- > 0) throw new TypeError("Network request failed"); // зафиксировано, ответ не дошёл
      return json(200, { token, refreshToken: successor });
    }
    if (path === "/api/surveys/s1/responses") {
      const auth = (init.headers as Record<string, string>).Authorization;
      if (!st.access || auth !== `Bearer ${st.access}`) return json(401, { error: "Потрібно увійти" });
      st.accepted.push(JSON.parse(String(init.body)).clientRequestId);
      return json(201, { id: "resp-1", scores: [] });
    }
    return json(404, { error: "not found" });
  });
  return st;
}

beforeEach(() => {
  resetStore();
});

describe("ответ обмена потерян после фиксации", () => {
  test("повтор не выбивает сессию, сдача из очереди уходит, а не отклоняется", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    enqueue(owner, "s1", { answers: [] });
    const srv = sessionServer(owner, { lose: 1 });

    // обмен прошёл на сервере, ответ потерян: сеть, сдача ждёт
    expect(await api.flushQueue()).toEqual({ sent: 0, left: 1, rejected: 0 });
    expect(session.refresh, "старый refresh на месте — новой пары клиент не видел").toBe(`refresh-${owner}`);

    // связь вернулась: повтор того же обмена
    const res = await api.flushQueue();
    expect(res, "сдача ушла в отклонённые").toEqual({ sent: 1, left: 0, rejected: 0 });
    expect(rejectedItems(owner)).toEqual([]);
    expect(srv.revokedFamily, "сервер счёл повтор кражей").toBe(false);
    expect(srv.exchanges).toHaveLength(2);
    expect(srv.exchanges[1]!.requestId).toBeDefined();
    expect(srv.exchanges[1]!.requestId).toBe(srv.exchanges[0]!.requestId);
    expect(session.refresh).toBe(srv.rotated.get(`refresh-${owner}`)!.successor);
    expect(session.token).toBe(srv.access);
  });

  test("следующий обмен — уже новым refresh и с новым ключом", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    enqueue(owner, "s1", { answers: [] });
    const srv = sessionServer(owner, { lose: 1 });
    await api.flushQueue();
    await api.flushQueue();

    // access снова истёк
    srv.access = null;
    enqueue(owner, "s1", { answers: [] });
    expect(await api.flushQueue()).toEqual({ sent: 1, left: 0, rejected: 0 });
    const [first, , third] = srv.exchanges;
    expect(third!.refreshToken).not.toBe(first!.refreshToken);
    expect(third!.requestId).not.toBe(first!.requestId);
  });
});

describe("положительный контроль", () => {
  test("сервер отверг refresh по существу — сессия недействительна, как и было", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    enqueue(owner, "s1", { answers: [] });
    sessionServer(owner, { lose: 0, refuseRefresh: true });

    expect(await api.flushQueue()).toEqual({ sent: 0, left: 0, rejected: 1 });
  });

  test("без потерь обмен один, сдача уходит с первого раза", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    enqueue(owner, "s1", { answers: [] });
    const srv = sessionServer(owner, { lose: 0 });

    expect(await api.flushQueue()).toEqual({ sent: 1, left: 0, rejected: 0 });
    expect(srv.exchanges).toHaveLength(1);
  });
});
