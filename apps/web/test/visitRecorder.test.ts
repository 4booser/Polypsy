import { describe, expect, test } from "bun:test";
import {
  audioFileName,
  failureKey,
  pickMimeType,
  RecorderRegistry,
  RecorderSession,
  refusedForGood,
  type BeforeUnloadLike,
  type RecorderDeps,
  type RecorderLike,
  type UnloadTarget,
} from "../src/components/recorder/model";

/**
 * Запись приёма в браузере — на поддельных микрофоне, рекордере и сервере.
 *
 * Прежде компонент очищал буфер до ответа сервера (сбой сети — и часовой
 * разговор пропадал без возможности повторить) и не останавливал
 * микрофон при уходе с экрана и при отказе сервера в старте. Проверяется
 * модель (components/recorder/model.ts): компонент только рисует её
 * состояние и зовёт её методы.
 */

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  readonly tracks = [new FakeTrack(), new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
  get released() {
    return this.tracks.every((t) => t.stopped);
  }
}

class FakeRecorder implements RecorderLike {
  mimeType = "audio/webm;codecs=opus";
  running = false;
  private onChunk: ((chunk: Blob) => void) | null = null;
  start(_ms: number, onChunk: (chunk: Blob) => void) {
    this.running = true;
    this.onChunk = onChunk;
  }
  /** кусок записи, как ondataavailable раз в пять секунд */
  emit(bytes: number) {
    this.onChunk?.(new Blob([new Uint8Array(bytes).fill(1)]));
  }
  async stop() {
    if (!this.running) return;
    // последний кусок приходит перед событием остановки
    this.emit(100);
    this.running = false;
  }
}

const S = "2026-09-27T10:00:00.000Z";
const failure = (status: number, message = "відмова") => Object.assign(new Error(message), { status });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(over: Partial<RecorderDeps<FakeStream>> = {}) {
  const stream = new FakeStream();
  const recorders: FakeRecorder[] = [];
  const sent: { audio: Blob; uploadId: string }[] = [];
  const calls = { start: 0, send: 0, stopOnServer: 0 };
  let ids = 0;
  const deps: RecorderDeps<FakeStream> = {
    getMic: async () => stream,
    makeRecorder: () => {
      const r = new FakeRecorder();
      recorders.push(r);
      return r;
    },
    startOnServer: async () => {
      calls.start += 1;
      return { startedAt: S };
    },
    sendAudio: async (audio, uploadId) => {
      calls.send += 1;
      sent.push({ audio, uploadId });
    },
    stopOnServer: async () => {
      calls.stopOnServer += 1;
    },
    newId: () => `upload-${++ids}`,
    ...over,
  };
  const session = new RecorderSession(deps);
  return { session, stream, recorders, sent, calls, deps, rec: () => recorders[0]! };
}

describe("микрофон освобождается во всех ветках", () => {
  test("сервер отказал в старте после того, как браузер дал микрофон", async () => {
    const h = harness({
      startOnServer: async () => {
        throw failure(403, "Запис не почнеться без згоди");
      },
    });
    await h.session.start();
    expect(h.stream.released, "поток микрофона остался открытым").toBe(true);
    expect(h.session.phase).toBe("idle");
    expect(h.session.snapshot().notice).toEqual({ kind: "failed", message: "Запис не почнеться без згоди" });
    expect(h.recorders.every((r) => !r.running)).toBe(true);
  });

  test("ушли с экрана, пока браузер спрашивал разрешение", async () => {
    const mic = deferred<FakeStream>();
    const h = harness({ getMic: () => mic.promise });
    const starting = h.session.start();
    await h.session.leave();
    mic.resolve(h.stream);
    await starting;
    expect(h.stream.released).toBe(true);
    expect(h.calls.start, "сервер не должен считать запись начатой").toBe(0);
    expect(h.session.phase).toBe("idle");
  });

  test("ушли, пока сервер отвечал на старт: микрофон свободен, сервер узнаёт, что записи не было", async () => {
    const server = deferred<{ startedAt: string }>();
    const h = harness({ startOnServer: () => server.promise });
    const starting = h.session.start();
    await Bun.sleep(0);
    await h.session.leave();
    server.resolve({ startedAt: S });
    await starting;
    expect(h.stream.released).toBe(true);
    expect(h.recorders.every((r) => !r.running)).toBe(true);
    expect(h.calls.stopOnServer).toBe(1);
  });

  test("рекордер не запустился — микрофон свободен, сервер предупреждён", async () => {
    const h = harness({
      makeRecorder: () => ({
        mimeType: "",
        start: () => {
          throw new Error("NotSupportedError");
        },
        stop: async () => {},
      }),
    });
    await h.session.start();
    expect(h.stream.released).toBe(true);
    expect(h.calls.stopOnServer).toBe(1);
    expect(h.session.phase).toBe("idle");
  });

  test("уход с экрана во время записи: рекордер стоит, микрофон свободен, записанное отправлено", async () => {
    const h = harness();
    await h.session.start();
    expect(h.session.phase).toBe("live");
    h.rec().emit(1000);
    await h.session.leave();
    expect(h.rec().running, "рекордер пишет без экрана и индикатора").toBe(false);
    expect(h.stream.released).toBe(true);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.audio.size).toBe(1100);
  });

  test("отказ браузера в микрофоне — сервер не трогается", async () => {
    const h = harness({
      getMic: async () => {
        throw new Error("NotAllowedError");
      },
    });
    await h.session.start();
    expect(h.calls.start).toBe(0);
    expect(h.session.snapshot().notice).toEqual({ kind: "micDenied" });
  });
});

describe("запись живёт до подтверждения сервера", () => {
  test("сбой сети при отправке не теряет запись; повтор уходит тем же ключом и тем же аудио", async () => {
    let attempts = 0;
    const h = harness();
    h.deps.sendAudio = async (audio, uploadId) => {
      attempts += 1;
      if (attempts < 3) throw failure(0, "Немає зв’язку");
      h.sent.push({ audio, uploadId });
    };
    await h.session.start();
    h.rec().emit(4000);
    await h.session.stop();

    expect(h.session.phase, "запись стёрта до ответа сервера").toBe("unsent");
    expect(h.session.snapshot().notice).toEqual({ kind: "sendFailed", message: "Немає зв’язку" });
    expect(h.stream.released, "микрофон держится, пока ждём повтора").toBe(true);

    await h.session.send();
    expect(h.session.phase).toBe("unsent");
    await h.session.send();
    expect(h.session.phase).toBe("idle");
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.uploadId).toBe("upload-1");
    expect(h.sent[0]!.audio.size).toBe(4100);
  });

  test("пока сервер не ответил, аудио числится неотправленным", async () => {
    const reply = deferred<void>();
    const h = harness({ sendAudio: () => reply.promise });
    await h.session.start();
    h.rec().emit(10);
    const stopping = h.session.stop();
    await Bun.sleep(0);
    expect(h.session.phase).toBe("sending");
    expect(h.session.unsent).toBe(true);
    reply.resolve();
    await stopping;
    expect(h.session.unsent).toBe(false);
  });

  test("отказ по существу стирает аудио и не предлагает повтор", async () => {
    const h = harness({
      sendAudio: async () => {
        throw failure(400, "Запис вже не йде: його зупинили або видалили");
      },
    });
    await h.session.start();
    h.rec().emit(10);
    await h.session.stop();
    expect(h.session.phase).toBe("idle");
    expect(h.session.snapshot().notice?.kind).toBe("sendRefused");
    expect(h.session.unsent).toBe(false);
  });

  test("истёкший вход и сбой сервера — повторяемы, отказ по существу — нет", () => {
    for (const status of [0, 401, 408, 429, 500, 502, 503]) expect(refusedForGood(status)).toBe(false);
    for (const status of [400, 403, 404, 409, 413, 415, 422]) expect(refusedForGood(status)).toBe(true);
  });

  test("запись без единого куска — сервер узнаёт об остановке без аудио", async () => {
    const h = harness();
    h.deps.makeRecorder = () => {
      const r = new FakeRecorder();
      r.stop = async () => {
        r.running = false;
      };
      h.recorders.push(r);
      return r;
    };
    await h.session.start();
    await h.session.stop();
    expect(h.calls.stopOnServer).toBe(1);
    expect(h.sent.length).toBe(0);
    expect(h.session.phase).toBe("idle");
  });

  test("удаление стирает и неотправленное", async () => {
    const h = harness({
      sendAudio: async () => {
        throw failure(0);
      },
    });
    await h.session.start();
    h.rec().emit(10);
    await h.session.stop();
    expect(h.session.phase).toBe("unsent");
    await h.session.abandon();
    expect(h.session.unsent).toBe(false);
    h.deps.sendAudio = async () => {
      throw new Error("удалённое не должно уходить на сервер");
    };
    await h.session.send();
    expect(h.session.phase).toBe("idle");
  });
});

describe("вторая сторона остановила или удалила запись", () => {
  test("остановил пациент: запись здесь прекращается, записанное досылается", async () => {
    const h = harness();
    await h.session.start();
    h.rec().emit(300);
    expect(await h.session.remote("ready", S)).toBe(true);
    expect(h.rec().running).toBe(false);
    expect(h.stream.released).toBe(true);
    expect(h.sent.length).toBe(1);
    expect(h.session.snapshot().notice).toEqual({ kind: "stoppedRemotely" });
  });

  test("ответ опроса, отправленный до старта, запись не останавливает", async () => {
    const h = harness();
    await h.session.start();
    // «готово» от прошлой записи или без неё вовсе — не про эту запись
    expect(await h.session.remote("ready", null)).toBe(false);
    expect(await h.session.remote("ready", "2026-09-27T09:00:00.000Z")).toBe(false);
    expect(await h.session.remote("recording", S)).toBe(false);
    expect(h.session.phase).toBe("live");
    expect(h.rec().running).toBe(true);
  });

  test("удалили запись: микрофон свободен, записанное стёрто, ничего не отправлено", async () => {
    const h = harness();
    await h.session.start();
    h.rec().emit(300);
    expect(await h.session.remote("discarded", S)).toBe(true);
    expect(h.stream.released).toBe(true);
    expect(h.sent.length).toBe(0);
    expect(h.session.unsent).toBe(false);
    expect(h.session.snapshot().notice).toEqual({ kind: "withdrawn" });
  });
});

describe("предупреждение при уходе со страницы", () => {
  function target() {
    const listeners = new Set<(e: BeforeUnloadLike) => void>();
    const t: UnloadTarget = {
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
    };
    const fire = () => {
      const event = { prevented: false, returnValue: undefined as unknown, preventDefault() {
        this.prevented = true;
      } };
      for (const fn of listeners) fn(event);
      return event;
    };
    return { t, listeners, fire };
  }

  test("пока есть неотправленное аудио, закрытие вкладки спрашивает подтверждения", async () => {
    const w = target();
    const registry = new RecorderRegistry(w.t);
    const base = harness();
    let fail = true;
    const session = registry.session("appt-1", () => ({
      ...base.deps,
      sendAudio: async () => {
        if (fail) throw failure(0);
      },
    }));
    expect(w.listeners.size).toBe(0);

    await session.start();
    expect(w.listeners.size, "идущая запись — тоже неотправленное аудио").toBe(1);

    base.rec().emit(10);
    await session.stop();
    expect(session.phase).toBe("unsent");
    const event = w.fire();
    expect(event.prevented).toBe(true);

    fail = false;
    await session.send();
    expect(w.listeners.size, "после подтверждения сервера предупреждать не о чем").toBe(0);
  });

  test("сессия переживает экран: вернулись — неотправленное на месте", async () => {
    const registry = new RecorderRegistry(null);
    const base = harness({
      sendAudio: async () => {
        throw failure(503);
      },
    });
    const first = registry.session("appt-2", () => base.deps);
    await first.start();
    base.rec().emit(10);
    await first.leave();
    expect(first.phase).toBe("unsent");
    const again = registry.session("appt-2", () => {
      throw new Error("сессия должна найтись, а не создаться заново");
    });
    expect(again).toBe(first);
    expect(again.phase).toBe("unsent");
  });
});

describe("мелочи", () => {
  test("контейнер: Opus, где умеют; Safari — MP4", () => {
    expect(pickMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(() => false)).toBeNull();
    expect(
      pickMimeType(() => {
        throw new Error("старый браузер");
      }),
    ).toBeNull();
    expect(audioFileName("audio/mp4")).toBe("visit.m4a");
    expect(audioFileName("audio/ogg;codecs=opus")).toBe("visit.ogg");
    expect(audioFileName("")).toBe("visit.webm");
  });

  test("причина отказа расшифровки — словами экрана", () => {
    expect(failureKey("Error: empty-transcript: whisper не вернул текста")).toBe("rec.fail.silent");
    expect(failureKey("Error: audio-unreadable: ffmpeg вышел с кодом 183")).toBe("rec.fail.unreadable");
    expect(failureKey("Error: converter-missing: ffmpeg не запустился")).toBe("rec.fail.engine");
    expect(failureKey("Error: ключ v1 не найден")).toBeNull();
    expect(failureKey(null)).toBeNull();
  });
});
