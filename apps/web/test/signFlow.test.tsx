import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UI } from "@quizzy/shared";
import { ApiError, type ConclusionState, type ConclusionVersion } from "../src/api";
import { ConclusionEditor } from "../src/components/ConclusionEditor";
import {
  draftOf,
  draftSavable,
  saveThenSign,
  signPlan,
  staleMessage,
  type VersionedState,
} from "../src/components/versioned";
import { LangProvider } from "../src/lang";

/**
 * Подпись заключения и заметки приёма: что уходит на сервер по кнопке.
 *
 * Оба редактора подписывают «ровно то, что видел человек», и оба делают это
 * в два шага — сохранить набранное, подписать сохранённое. Ошибки здесь
 * тихие: подпись встаёт под текст, которого нет на экране, или человек
 * упирается в конфликт версий с самим собой. Глазами их не поймать —
 * нужны две учётные записи и неудачная подпись посередине. Поэтому шаги
 * проверяются на подставных запросах, а не в браузере.
 */

const v = (over: Partial<ConclusionVersion> = {}): ConclusionVersion => ({
  id: "c1",
  version: 1,
  revision: 1,
  text: "Черновик",
  status: "draft",
  createdAt: "2026-09-27T08:00:00.000Z",
  authorName: "Коваль",
  signedAt: null,
  ...over,
});

const state = (current: ConclusionVersion | null): ConclusionState => ({ current, versions: current ? [current] : [] });

describe("что сделает «підписати»", () => {
  test("пустое поле — подписывать нечего, даже когда на сервере лежит черновик", () => {
    // человек стёр текст, чтобы написать заново: под подпись не должен уйти стёртый
    expect(signPlan("", v()).canSign).toBe(false);
    expect(signPlan("   \n ", v()).canSign).toBe(false);
    expect(signPlan("", null).canSign).toBe(false);
  });

  test("текст совпадает с черновиком — подписывается черновик без сохранения", () => {
    expect(signPlan("Черновик", v())).toEqual({ canSign: true, save: false });
  });

  test("текст правили или черновика нет — сперва сохранить", () => {
    expect(signPlan("Черновик, дописано", v())).toEqual({ canSign: true, save: true });
    expect(signPlan("Новый текст", null)).toEqual({ canSign: true, save: true });
  });

  test("у заметки сменили только вид — это правка, её сохраняют перед подписью", () => {
    expect(signPlan("Черновик", v(), false)).toEqual({ canSign: true, save: true });
  });

  test("«Зберегти чернетку» — только непустое: пробелы легли бы пустым черновиком поверх настоящего", () => {
    expect(draftSavable("")).toBe(false);
    expect(draftSavable("  \n")).toBe(false);
    expect(draftSavable("Скарги на сон")).toBe(true);
  });

  test("черновик — только последняя версия в статусе черновика", () => {
    expect(draftOf(state(v()))?.id).toBe("c1");
    expect(draftOf(state(v({ status: "signed" })))).toBeNull();
    expect(draftOf(state(null))).toBeNull();
  });
});

/**
 * Подставной сервер: пишет, что у него просили, и ведёт себя как настоящий —
 * сохранение поднимает редакцию, подпись сверяет её с последней.
 */
function server(opts: { signFails?: unknown; start?: ConclusionVersion } = {}) {
  let latest: ConclusionVersion = opts.start ?? v();
  const calls: string[] = [];
  const applied: VersionedState[] = [];
  const io = {
    save: async () => {
      calls.push(`save r${latest.revision}`);
      latest = { ...latest, revision: latest.revision + 1, text: "Дописано" };
      return state(latest);
    },
    sign: async (seen: { version: number; revision: number }) => {
      calls.push(`sign v${seen.version} r${seen.revision}`);
      if (opts.signFails) throw opts.signFails;
      if (seen.revision !== latest.revision) throw new ApiError("Заключение изменили", 409);
      latest = { ...latest, status: "signed", signedAt: "2026-09-27T09:00:00.000Z" };
      return state(latest);
    },
    apply: (next: VersionedState) => {
      applied.push(next);
    },
  };
  return { io, calls, applied, now: () => latest };
}

describe("сохранить и подписать", () => {
  test("подписывается редакция, которую вернуло сохранение", async () => {
    const s = server();
    const done = await saveThenSign(state(v()), signPlan("Дописано", v()), s.io);
    expect(s.calls).toEqual(["save r1", "sign v1 r2"]);
    expect(done.current?.status).toBe("signed");
  });

  test("без правки — одна подпись, без сохранения", async () => {
    const s = server();
    await saveThenSign(state(v()), signPlan("Черновик", v()), s.io);
    expect(s.calls).toEqual(["sign v1 r1"]);
  });

  test("сохранение прошло, подпись — нет: на экран легло сохранённое, и повтор не упирается в 409", async () => {
    /*
     * Стажёр пишет заключение без права подписи: сохранение проходит,
     * подпись — 403. Раньше экран оставался с редакцией до сохранения, и
     * следующее нажатие уходило с ней же — сервер отвечал «заключение
     * изменили», хотя изменил его сам человек.
     */
    const first = server({ signFails: new ApiError("Немає права", 403) });
    await expect(saveThenSign(state(v()), signPlan("Дописано", v()), first.io)).rejects.toThrow("Немає права");
    const onScreen = (first.applied.at(-1) ?? state(v())) as ConclusionState;
    expect(onScreen.current?.revision, "сохранённое не легло на экран").toBe(2);

    // повтор (подписал старший): на сервере — редакция 2, на экране — она же
    const again = server({ start: first.now() });
    const done = await saveThenSign(onScreen, signPlan("Дописано", draftOf(onScreen)), again.io);
    expect(again.calls, "повтор сохранял заново или подписывал не ту редакцию").toEqual(["sign v1 r2"]);
    expect(done.current?.status).toBe("signed");
  });

  test("409 — это строка «перечитати»; прочие отказы — не она", () => {
    expect(staleMessage(new ApiError("Висновок змінили", 409))).toBe("Висновок змінили");
    expect(staleMessage(new ApiError("Немає права", 403))).toBeNull();
    expect(staleMessage(new ApiError("Немає зв’язку", 0))).toBeNull();
    expect(staleMessage(new Error("x"))).toBeNull();
  });
});

describe("кнопка «Сформувати заключення» в разметке", () => {
  const draw = (current: ConclusionVersion | null, text: string) =>
    renderToStaticMarkup(
      <LangProvider>
        <ConclusionEditor
          responseId="r1"
          state={state(current)}
          error={null}
          onState={() => {}}
          onReload={() => {}}
          title=""
          text={text}
          setText={() => {}}
          areaRef={{ current: null }}
          tool={null}
          setTool={() => {}}
        />
      </LangProvider>,
    );

  /*
   * Выключена ли главная кнопка редактора — по её подписи на любом языке.
   * Смотрится атрибут, а не слово: «disabled:opacity-45» в списке классов
   * есть у каждой кнопки, выключенной или нет.
   */
  const formDisabled = (html: string): boolean => {
    const e = UI["cn3.form"] as { uk: string; ru: string; en?: string };
    const all = [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)];
    const found = all.find((m) => [e.uk, e.ru, e.en].includes(m[2]!));
    expect(found, "кнопки «Сформувати заключення» нет в разметке").toBeDefined();
    return /\sdisabled=""/.test(found![1]!);
  };

  test("стёртое поле при сохранённом черновике — кнопка выключена", () => {
    expect(formDisabled(draw(v(), ""))).toBe(true);
    expect(formDisabled(draw(v(), "  "))).toBe(true);
  });

  test("текст в поле — кнопка живая", () => {
    expect(formDisabled(draw(v(), "Черновик"))).toBe(false);
    expect(formDisabled(draw(null, "Первый текст"))).toBe(false);
  });
});
