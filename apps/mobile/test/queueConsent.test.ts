import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resetStore } from "./store.mock";
import { json, loadClient, serve, signIn, useFakeServer } from "./client.harness";
import { enqueue, pending, rejectedItems } from "../src/offline/queue";

/**
 * Очередь мобилки упёрлась в новую редакцию согласия (#201), как в вебе.
 *
 * Сдача из очереди с 403 «спершу прийміть згоду» становилась отклонённой и
 * ждала разбора человеком. Теперь по коду err.consentRequired запись не
 * помечается и попытка не считается, прогон встаёт, приложение уводит на
 * экран согласия (onConsentRequired → корневая раскладка), а после
 * принятия первый прогон отправляет ту же запись с тем же clientRequestId.
 *
 * Через настоящий клиент (api.flushQueue) и подменённый сервер.
 */

useFakeServer();

const ownerOf = () => `patient-${crypto.randomUUID().slice(0, 8)}`;

beforeEach(() => {
  resetStore();
});

/** Сервер: сдачи до принятия согласия — 403 с кодом (или без, `coded: false`), после — 201 */
function consentServer(coded = true) {
  const st = { consented: false, accepted: [] as string[], submits: 0 };
  serve((path, init) => {
    if (path === "/api/consents/me/accept") {
      st.consented = true;
      return json(200, { ok: true });
    }
    if (path === "/api/surveys/s1/responses") {
      st.submits++;
      if (!st.consented) {
        return json(403, {
          error: "Спершу прийміть інформовану згоду",
          ...(coded ? { code: "err.consentRequired" } : {}),
        });
      }
      st.accepted.push(JSON.parse(String(init.body)).clientRequestId);
      return json(201, { id: "resp-1", scores: [] });
    }
    return json(404, { error: "not found" });
  });
  return st;
}

type ConsentApi = { onConsentRequired?: (listener: () => void) => () => void };

describe("мобилка: сдача из очереди и 403 «нужно согласие»", () => {
  test("запись ждёт, приложение зовёт экран согласия; после принятия уходит та же сдача", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    const item = enqueue(owner, "s1", { answers: [1] });
    await Bun.sleep(2);
    enqueue(owner, "s1", { answers: [2] });
    const st = consentServer();
    let asked = 0;
    const off = (api as ConsentApi).onConsentRequired?.(() => asked++);

    const stopped = await api.flushQueue();
    expect(stopped.rejected, "сдача на новой редакции согласия отклонена").toBe(0);
    expect(stopped).toEqual({ sent: 0, left: 2, rejected: 0, consent: true });
    expect(asked, "экран согласия не позван").toBe(1);
    // следующие не пробовались: упёрлись бы в то же согласие
    expect(st.submits).toBe(1);
    // попытка не засчитана: согласие — не сбой сервера
    expect(pending(owner)[0]!.attempts).toBe(0);

    await api.acceptConsent("t2");
    const sent = await api.flushQueue();
    expect(sent).toEqual({ sent: 2, left: 0, rejected: 0 });
    expect(st.accepted[0]).toBe(item.payload.clientRequestId as string);
    expect(asked).toBe(1);
    off?.();
  });

  test("положительный контроль: 403 без кода согласия — отклонена, как прежде, экран не зовётся", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    enqueue(owner, "s1", {});
    consentServer(false);
    let asked = 0;
    const off = (api as ConsentApi).onConsentRequired?.(() => asked++);

    expect(await api.flushQueue()).toEqual({ sent: 0, left: 0, rejected: 1 });
    expect(rejectedItems(owner)).toHaveLength(1);
    expect(asked).toBe(0);
    off?.();
  });

  test("приложение уводит на экран согласия, а принятие досылает очередь", () => {
    const strip = (f: string) =>
      readFileSync(resolve(import.meta.dir, "../app", f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    const layout = strip("_layout.tsx");
    expect(layout).toContain("api.onConsentRequired(() => {");
    expect(layout).toContain('router.replace("/consent");');
    expect(layout).toContain("useConsentGate();");
    expect(strip("consent.tsx")).toMatch(
      /await api\.acceptConsent\(textId\);\s*void api\.flushQueue\(\)\.catch\(\(\) => \{\}\);\s*router\.replace\("\/\(app\)\/home"\);/,
    );
  });
});
