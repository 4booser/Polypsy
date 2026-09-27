import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { RuleHit, SurveyListItem } from "@quizzy/shared";
import { UI, type UiKey } from "@quizzy/shared";
import type { api } from "../src/api";
import { DispensaryBody, EpisodesBody } from "../src/components/Episodes";
import { SafetyPlanBody } from "../src/components/SafetyPlanEditor";
import { SuggestionsBody } from "../src/components/Suggestions";
import { LibraryState } from "../src/components/TemplatePicker";
import { LangProvider } from "../src/lang";
import { ConsentTextBody } from "../src/pages/Admin";
import { ThreadFeed, ownThread } from "../src/pages/Messages";
import { gateOf } from "../src/pages/Permissions";
import { HomeBody } from "../src/patient/Home";
import { MissedList } from "../src/shell/EventCenter";
import { Loading, Screen, loadView } from "../src/ui";
import type { Resource } from "../src/useResource";

/**
 * «Нет данных» против «ошибка» против «нет связи» (w13:uitests).
 *
 * Внешний разбор: покрытие интерфейса проверяло отрисовку данных и
 * пропускало то, что экран показывает, когда данных нет. А это три разных
 * ответа человеку, и путать их опасно:
 *
 *  - сервер ответил пустым — «нічого немає» (только здесь!);
 *  - сервер отказал — текст отказа и «Повторити»;
 *  - ответа ещё нет (грузится или пропала связь) — скелет; о связи говорит
 *    строка оболочки (ConnectionLine), а не каждый экран сам.
 *
 * Экраны ниже брали `data ?? []` и на отказе и обрыве говорили «звернень не
 * було», «прийомів не заплановано», «нічого нового» — неправду о человеке,
 * выглядящую как правда. Каждый из них разделён на загрузку и тело, и тело
 * рисуется здесь с загрузкой в каждом из состояний.
 */

const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

/** Текст ключа на любом из языков — проверка не зависит от языка окружения */
const has = (html: string, key: UiKey) => {
  const e = UI[key] as { uk: string; ru: string; en?: string };
  return [e.uk, e.ru, e.en].some((t) => !!t && html.includes(t));
};

const OOPS = "Сервер тимчасово недоступний";

/** Загрузка в нужном состоянии — то, что useResource отдаёт экрану */
function res<T>(over: Partial<Resource<T>> = {}): Resource<T> {
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

const waiting = <T,>() => res<T>({ loading: true });
const failed = <T,>() => res<T>({ error: OOPS });
/** Пропала связь до первого ответа: запрос на паузе, ни данных, ни ошибки */
const offline = <T,>() => res<T>({ offline: true });
const answered = <T,>(data: T) => res<T>({ data, updatedAt: Date.now() });

const skeleton = (html: string) => html.includes('aria-busy="true"');
const refusal = (html: string) => html.includes(OOPS) && has(html, "common.retry");

describe("правило: что стоит на месте данных", () => {
  test("четыре состояния различаются, «пусто» — только по ответу", () => {
    expect(loadView(waiting<string[]>())).toBe("wait");
    expect(loadView(offline<string[]>())).toBe("wait");
    expect(loadView(failed<string[]>())).toBe("failed");
    expect(loadView(answered<string[]>([]), (d) => d.length === 0)).toBe("empty");
    expect(loadView(answered(["a"]), (d) => d.length === 0)).toBe("ready");
    // ответ «ничего» (null, 204) — это ответ
    expect(loadView(res<string | null>({ data: null, updatedAt: 1 }))).toBe("empty");
    // отказ повтора при показанных данных данные не стирает
    expect(loadView(res({ data: ["a"], error: OOPS, updatedAt: 1 }))).toBe("ready");
  });

  test("Screen: скелет до ответа, отказ с «повторить», данные — с отказом повтора над ними", () => {
    const body = (d: string[]) => <p>рядків: {d.length}</p>;
    expect(skeleton(draw(<Screen res={waiting<string[]>()}>{body}</Screen>))).toBe(true);
    expect(skeleton(draw(<Screen res={offline<string[]>()}>{body}</Screen>))).toBe(true);
    expect(refusal(draw(<Screen res={failed<string[]>()}>{body}</Screen>))).toBe(true);
    const stale = draw(<Screen res={res({ data: ["a"], error: OOPS, updatedAt: 1 })}>{body}</Screen>);
    expect(stale).toContain(OOPS);
    expect(stale).toContain("рядків: 1");
  });

  test("отказ без «повторить» — тупик: Loading с onRetry рисует кнопку, занятая — гасит её", () => {
    expect(draw(<Loading error={OOPS} onRetry={() => {}} />)).toMatch(/<button[^>]*>/);
    expect(draw(<Loading error={OOPS} onRetry={() => {}} busy />)).toMatch(/<button[^>]*disabled=""/);
    expect(draw(<Loading error={OOPS} />)).not.toContain("<button");
  });
});

/* ─────────── кабинет пациента: главная ─────────── */

type Visits = Awaited<ReturnType<typeof api.myAppointments>>;

const survey = (over: Partial<SurveyListItem>): SurveyListItem =>
  ({ id: "s1", title: "PHQ-9", status: "published", completedByMe: false, ...over }) as SurveyListItem;

const home = (visits: Resource<Visits>, surveys: Resource<SurveyListItem[]>) =>
  draw(<HomeBody visits={visits} surveys={surveys} busy={false} onConfirm={() => {}} onCancel={() => {}} />);

describe("главная кабинета", () => {
  test("пока ответа нет или пропала связь — скелет, а не «прийомів не заплановано» с «Записатися»", () => {
    for (const [name, v, s] of [
      ["загрузка", waiting<Visits>(), waiting<SurveyListItem[]>()],
      ["нет связи", offline<Visits>(), offline<SurveyListItem[]>()],
    ] as const) {
      const html = home(v, s);
      expect(has(html, "pt.noVisit"), name).toBe(false);
      expect(has(html, "pt.bookNow"), name).toBe(false);
      expect(has(html, "pt.noTests"), name).toBe(false);
      expect(skeleton(html), name).toBe(true);
    }
  });

  test("отказ — отказ с «Повторити», а не «прийомів не заплановано»", () => {
    const html = home(failed<Visits>(), failed<SurveyListItem[]>());
    expect(refusal(html)).toBe(true);
    expect(has(html, "pt.noVisit")).toBe(false);
    expect(has(html, "pt.bookNow")).toBe(false);
    expect(has(html, "pt.noTests")).toBe(false);
  });

  test("пустой ответ — «не заплановано» и запись; пройденное в «пройти» не зовёт", () => {
    const html = home(answered<Visits>({ items: [] }), answered([survey({ completedByMe: true })]));
    expect(has(html, "pt.noVisit")).toBe(true);
    expect(has(html, "pt.bookNow")).toBe(true);
    expect(has(html, "pt.noTests")).toBe(true);
    expect(skeleton(html)).toBe(false);
  });

  test("блоки независимы: отказ приёмов не прячет тесты", () => {
    const html = home(failed<Visits>(), answered([survey({ title: "ГТР-7" })]));
    expect(refusal(html)).toBe(true);
    expect(html).toContain("ГТР-7");
  });
});

/* ─────────── обращения и диспансерный учёт ─────────── */

type EpisodeList = Awaited<ReturnType<typeof api.episodes>>;
type Dispensary = Awaited<ReturnType<typeof api.dispensary>>;

describe("обращения человека", () => {
  const episodes = (r: Resource<EpisodeList>) => draw(<EpisodesBody patientId="p1" res={r} />);

  test("до ответа и на отказе — ни «звернень не було», ни формы открыть новое", () => {
    for (const [name, r] of [
      ["загрузка", waiting<EpisodeList>()],
      ["нет связи", offline<EpisodeList>()],
      ["отказ", failed<EpisodeList>()],
    ] as const) {
      const html = episodes(r);
      expect(has(html, "ep.none"), name).toBe(false);
      expect(has(html, "ep.open"), name).toBe(false);
    }
    expect(refusal(episodes(failed<EpisodeList>()))).toBe(true);
  });

  test("пустой ответ — «звернень не було» и форма открыть первое", () => {
    const html = episodes(answered<EpisodeList>({ items: [] }));
    expect(has(html, "ep.none")).toBe(true);
    expect(has(html, "ep.open")).toBe(true);
  });

  test("открытое обращение есть — формы открыть второе нет", () => {
    const open = {
      id: "e1",
      openedAt: "2026-09-01T09:00:00.000Z",
      closedAt: null,
      reason: "Безсоння",
      outcome: null,
      outcomeKind: null,
      leadName: null,
      visits: 2,
      conclusions: 1,
      referrals: 0,
    };
    const html = episodes(answered<EpisodeList>({ items: [open] }));
    expect(html).toContain("Безсоння");
    expect(has(html, "ep.oneOpen")).toBe(true);
    expect(has(html, "ep.none")).toBe(false);
  });

  test("диспансерный учёт: отказ виден, а не блок пропадает; до ответа блока нет", () => {
    expect(refusal(draw(<DispensaryBody patientId="p1" res={failed<Dispensary>()} />))).toBe(true);
    expect(draw(<DispensaryBody patientId="p1" res={waiting<Dispensary>()} />)).toBe("");
    expect(has(draw(<DispensaryBody patientId="p1" res={answered<Dispensary>({ on: false })} />), "disp.title")).toBe(true);
  });
});

/* ─────────── переписка ─────────── */

type ThreadPage = Awaited<ReturnType<typeof api.thread>>;

const thread = (id: string, texts: string[]): ThreadPage => ({
  id,
  items: texts.map((text, i) => ({ id: `${id}-${i}`, mine: false, text, sentAt: "2026-09-26T10:00:00.000Z", readAt: null })),
  hasMore: false,
  nextBefore: null,
});

describe("переписка", () => {
  test("письма прежнего разговора не стоят под адресом нового, пока новый едет", () => {
    /*
     * Слой загрузки держит прежний ответ как заглушку (keepPreviousData).
     * Разговор с Коваль, открыт разговор с Бондар — ответ по Бондар ещё в
     * пути: на экране не должно быть ни одного письма Коваль.
     */
    const placeholder = res<ThreadPage | null>({ data: thread("t-koval", ["Мені гірше"]), loading: false, refreshing: true });
    const own = ownThread(placeholder, "t-bondar");
    expect(own.data).toBeNull();
    expect(own.view).toBe("wait");
    const html = draw(<ThreadFeed view={own.view} items={own.data?.items ?? []} res={placeholder} />);
    expect(html).not.toContain("Мені гірше");
    expect(has(html, "ms.empty")).toBe(false);
    expect(skeleton(html)).toBe(true);
  });

  test("отказ — отказ с «Повторити», а не «тут поки порожньо»", () => {
    const r = failed<ThreadPage | null>();
    const own = ownThread(r, "t-bondar");
    const html = draw(<ThreadFeed view={own.view} items={[]} res={r} />);
    expect(refusal(html)).toBe(true);
    expect(has(html, "ms.empty")).toBe(false);
  });

  test("пустой разговор — «порожньо», свой — письма", () => {
    const empty = ownThread(answered<ThreadPage | null>(thread("t-1", [])), "t-1");
    expect(has(draw(<ThreadFeed view={empty.view} items={[]} res={waiting()} />), "ms.empty")).toBe(true);
    const full = ownThread(answered<ThreadPage | null>(thread("t-1", ["Добрий день"])), "t-1");
    expect(full.view).toBe("ready");
    expect(draw(<ThreadFeed view={full.view} items={full.data!.items} res={waiting()} />)).toContain("Добрий день");
  });
});

/* ─────────── текст согласия ─────────── */

type ConsentText = Awaited<ReturnType<typeof api.consentText>>;

describe("текст согласия", () => {
  const screen = (r: Resource<ConsentText>) => draw(<ConsentTextBody res={r} />);

  test("до ответа и на отказе — ни метки «не налаштовано», ни полей, ни кнопки новой версии", () => {
    for (const [name, r] of [
      ["загрузка", waiting<ConsentText>()],
      ["нет связи", offline<ConsentText>()],
      ["отказ", failed<ConsentText>()],
    ] as const) {
      const html = screen(r);
      expect(has(html, "adm.consentUnset"), name).toBe(false);
      expect(html.includes("<textarea"), name).toBe(false);
      expect(has(html, "adm.consentSave"), name).toBe(false);
    }
    expect(refusal(screen(failed<ConsentText>()))).toBe(true);
  });

  test("сервер ответил «текста нет» — «не налаштовано» и пустые поля", () => {
    const html = screen(res<ConsentText>({ data: null, updatedAt: Date.now() }));
    expect(has(html, "adm.consentUnset")).toBe(true);
    expect(html.match(/<textarea/g)).toHaveLength(3);
  });

  test("текст есть — его версия на метке с первого показа", () => {
    const html = screen(answered<ConsentText>({ version: 4, body: { uk: "Текст", ru: "Текст" }, createdAt: "2026-09-01T00:00:00.000Z" }));
    expect(has(html, "adm.consentUnset")).toBe(false);
    expect(html).toMatch(/(версія|версия|version) 4/);
  });
});

/* ─────────── права ─────────── */

describe("экран прав: две загрузки на одно место", () => {
  test("отказ ролей при пришедшем справочнике — отказ, а не вечный скелет", () => {
    const reloaded: string[] = [];
    const catalogue = res<unknown>({ data: { groups: [] }, updatedAt: 1, reload: () => reloaded.push("catalogue") });
    const roles = res<unknown>({ error: OOPS, reload: () => reloaded.push("roles") });
    const gate = gateOf([catalogue, roles]);
    expect(gate).toMatchObject({ view: "failed", error: OOPS });
    // «Повторити» перечитывает то, что не пришло, а не всё подряд
    gate.retry();
    expect(reloaded).toEqual(["roles"]);
  });

  test("одна ещё едет — ожидание; обе пришли — экран", () => {
    expect(gateOf([answered({}), waiting()]).view).toBe("wait");
    expect(gateOf([answered({}), answered([])]).view).toBe("ready");
  });
});

/* ─────────── библиотека шаблонов ─────────── */

type Templates = Awaited<ReturnType<typeof api.templates>>;

describe("библиотека шаблонов", () => {
  test("«бібліотека порожня» — только по пустому ответу", () => {
    expect(has(draw(<LibraryState res={failed<Templates | null>()} />), "tpl.none")).toBe(false);
    expect(refusal(draw(<LibraryState res={failed<Templates | null>()} />))).toBe(true);
    expect(has(draw(<LibraryState res={waiting<Templates | null>()} />), "tpl.none")).toBe(false);
    expect(has(draw(<LibraryState res={answered<Templates | null>({ items: [] })} />), "tpl.none")).toBe(true);
  });
});

/* ─────────── план безопасности ─────────── */

type Plans = Awaited<ReturnType<typeof api.safetyPlans>>;

describe("план безопасности", () => {
  test("отказ виден, а не блок пропадает вместе с меткой «плану немає»", () => {
    expect(refusal(draw(<SafetyPlanBody userId="p1" res={failed<Plans>()} />))).toBe(true);
    // до ответа блока нет, как и было
    expect(draw(<SafetyPlanBody userId="p1" res={waiting<Plans>()} />)).toBe("");
  });

  test("плана нет — блок с меткой «плану немає»", () => {
    const html = draw(<SafetyPlanBody userId="p1" res={answered<Plans>({ versions: [] })} />);
    expect(has(html, "sp.title")).toBe(true);
    expect(has(html, "sp.none")).toBe(true);
  });
});

/* ─────────── центр событий ─────────── */

type Missed = Awaited<ReturnType<typeof api.missed>>;

describe("центр событий: «пока вас не было»", () => {
  const list = (r: Resource<Missed>) => draw(<MissedList res={r} onGo={() => {}} />);

  test("отказ и ожидание — не «нічого нового»", () => {
    expect(has(list(failed<Missed>()), "ec.nothing")).toBe(false);
    expect(refusal(list(failed<Missed>()))).toBe(true);
    expect(has(list(offline<Missed>()), "ec.nothing")).toBe(false);
    expect(has(list(waiting<Missed>()), "common.loading")).toBe(true);
  });

  test("пустой ответ — «нічого нового»; пропущенное — строками", () => {
    expect(has(list(answered<Missed>({ since: "2026-09-26T00:00:00.000Z", groups: [] })), "ec.nothing")).toBe(true);
    const html = list(
      answered<Missed>({
        since: "2026-09-26T00:00:00.000Z",
        groups: [
          {
            kind: "case.opened",
            count: 1,
            items: [{ id: "c1", at: "2026-09-26T10:00:00.000Z", title: "Коваль Т.", detail: "", severity: "severe", href: "/alerts" }],
          },
        ],
      } as Missed),
    );
    expect(html).toContain("Коваль Т.");
    expect(has(html, "ec.nothing")).toBe(false);
  });
});

/* ─────────── предложения правил ─────────── */

describe("предложения правил", () => {
  test("отказ — панель с отказом; пусто — панели нет", () => {
    const html = draw(<SuggestionsBody res={failed<RuleHit[]>()} />);
    expect(has(html, "ds.title")).toBe(true);
    expect(refusal(html)).toBe(true);
    expect(draw(<SuggestionsBody res={answered<RuleHit[]>([])} />)).toBe("");
    expect(draw(<SuggestionsBody res={waiting<RuleHit[]>()} />)).toBe("");
  });
});
