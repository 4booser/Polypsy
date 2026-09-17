import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UI, type UiKey } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { WeekEdit, nextHours } from "../src/pages/Schedule";

/**
 * Обычная неделя: день — заголовок группы, а не значение в строке.
 *
 * Это уже разъезжалось. Правка недели была плоским списком промежутков, в
 * каждом из которых день выбирался выпадающим списком: у специалиста с
 * обедом «Понедельник» стоял в списке дважды подряд, а два вторника могли
 * оказаться через четверг друг от друга. Читалось это не как «понедельник,
 * два приёма», а как «две одинаковые строки, в одной опечатка».
 *
 * Глазами такое ловится только на живом экране и только у того, у кого в дне
 * больше одного промежутка, — то есть почти никогда. Поэтому здесь
 * проверяется состав разметки: сколько раз назван день и остался ли в строке
 * выбор дня.
 */

const draw = (node: React.ReactNode) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);

/*
 * Считается то, что человек видит, а не весь исходник разметки.
 *
 * Имя дня стоит ещё и в подписях полей для диктора — `aria-label="Понеділок
 * · З"`, — и по сырой разметке «Понеділок» встречается шесть раз в каждой
 * группе. Считать их вместе значило бы проверять не то: повторяется ли день
 * на экране, а сколько у него полей. Теги вырезаются целиком, остаются
 * только текстовые узлы.
 */
const onScreen = (html: string) => html.replace(/<[^>]*>/g, " ");

/*
 * Язык берётся из разметки, а не назначается.
 *
 * LangProvider в тестовом процессе читает язык из браузера, которого здесь
 * нет, и садится на украинский. Зашить «Понеділок» значило бы привязать
 * проверку к этому обстоятельству: сменится умолчание — проверка позеленеет
 * на пустом месте, потому что искать станет нечего, а «ноль совпадений» она
 * от «одного» отличит только если совпадение хоть раз было.
 */
function label(text: string, key: UiKey): string {
  const entry = UI[key];
  const found = [entry.uk, entry.ru].find((variant) => text.includes(variant));
  expect(found, `в неделе правки нет строки «${entry.ru}» (ключ ${key})`).toBeDefined();
  return found!;
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

const WEEKDAY_KEYS: UiKey[] = [
  "sched.mon",
  "sched.tue",
  "sched.wed",
  "sched.thu",
  "sched.fri",
  "sched.sat",
  "sched.sun",
];

/** Неделя с обедом в понедельник и короткой пятницей — ровно тот случай, где день повторялся */
const WEEK_WITH_LUNCH = [
  { weekday: 1, startsAt: "09:00", endsAt: "13:00", slotMinutes: 50 },
  { weekday: 1, startsAt: "14:00", endsAt: "18:00", slotMinutes: 50 },
  { weekday: 3, startsAt: "09:00", endsAt: "17:00", slotMinutes: 30 },
  { weekday: 5, startsAt: "09:00", endsAt: "12:00", slotMinutes: 50 },
];

describe("правка обычной недели", () => {
  test("день назван один раз, даже когда приёмов в нём несколько", () => {
    const text = onScreen(draw(<WeekEdit rows={WEEK_WITH_LUNCH} onChange={() => {}} />));
    for (const key of WEEKDAY_KEYS) {
      const name = label(text, key);
      expect(
        occurrences(text, name),
        `«${name}» стоит на экране правки ${occurrences(text, name)} раза: день должен быть ` +
          `заголовком группы, а не ячейкой в каждой строке`,
      ).toBe(1);
    }
  });

  test("в неделе стоят все семь дней, включая те, в которые приёма нет", () => {
    /*
     * «Принимаю ли я в субботу» — вопрос, на который отсутствие строки не
     * отвечает: её приходится искать, чтобы убедиться, что не нашёл.
     */
    const text = onScreen(draw(<WeekEdit rows={WEEK_WITH_LUNCH} onChange={() => {}} />));
    for (const key of WEEKDAY_KEYS) label(text, key);
    label(text, "sched.dayOff");
  });

  test("выбора дня в строке нет вовсе", () => {
    /*
     * Пока день выбирается списком, его можно выбрать неверно: человек метил
     * в четверг, а строка осталась понедельником. Внутри группы дня выбирать
     * нечего — промежуток принадлежит своему дню по построению.
     */
    const html = draw(<WeekEdit rows={WEEK_WITH_LUNCH} onChange={() => {}} />);
    expect(
      html.includes("<select"),
      "в строке промежутка снова появился выпадающий список дня",
    ).toBe(false);
  });

  test("подпись столбца одна на всю неделю и стоит выше всех полей", () => {
    /*
     * Два условия вместе, потому что поодиночке каждое обходится.
     *
     * «Стоит раньше первого поля» пропускает подпись, повторённую в каждой
     * группе дня: у понедельника она всё равно окажется выше его полей.
     * «Встречается один раз» пропускает единственную подпись, приклеенную
     * сбоку к полям пятницы. Вместе они описывают ровно шапку: один узел, и
     * он выше всей недели.
     *
     * Ищется `>подпись<` — текстовый узел целиком, а не вхождение строки:
     * «З» сидит внутри «Зняти», «До» — внутри «Додати години», и счёт по
     * подстроке считал бы кнопки.
     */
    const html = draw(<WeekEdit rows={WEEK_WITH_LUNCH} onChange={() => {}} />);
    const firstInput = html.indexOf("<input");
    expect(firstInput, "в неделе правки не осталось ни одного поля").toBeGreaterThan(-1);
    for (const key of ["sched.weekday", "sched.from", "sched.to", "sched.slotMinutes"] as UiKey[]) {
      const name = label(onScreen(html), key);
      const node = `>${name}<`;
      expect(
        occurrences(html, node),
        `подпись столбца «${name}» стоит на экране ${occurrences(html, node)} раз: ` +
          `у столбца она должна быть одна, в шапке`,
      ).toBe(1);
      expect(
        html.indexOf(node),
        `подпись столбца «${name}» стоит после первого поля — значит она не над столбцом, а сбоку`,
      ).toBeLessThan(firstInput);
    }
  });
});

describe("часы для нового промежутка в дне", () => {
  test("в пустом дне — часы по умолчанию", () => {
    expect(nextHours([])).toEqual({ startsAt: "09:00", endsAt: "13:00", slotMinutes: 50 });
  });

  test("после утреннего приёма — обеденный перерыв, а не второй такой же промежуток", () => {
    /*
     * Прежняя кнопка подставляла 09:00–13:00 независимо ни от чего, и в дне
     * с приёмом до часу это давало второй промежуток поверх первого: сначала
     * сотри, потом заполни.
     */
    const next = nextHours([{ weekday: 1, startsAt: "09:00", endsAt: "13:00", slotMinutes: 30 }]);
    expect(next.startsAt).toBe("14:00");
    expect(next.endsAt).toBe("18:00");
    // длительность приёма у человека одна на весь день, спрашивать её заново незачем
    expect(next.slotMinutes).toBe(30);
  });

  test("день, упёршийся в полночь, не даёт промежутка нулевой длины", () => {
    /*
     * Сервер отвергает такой промежуток вместе со всей неделей: у него
     * endsAt > startsAt стоит проверкой на каждую строку шаблона. Кнопка,
     * подставляющая заведомо непринимаемое, стоила бы человеку сохранения.
     */
    const next = nextHours([{ weekday: 1, startsAt: "09:00", endsAt: "23:30", slotMinutes: 50 }]);
    expect(next.endsAt > next.startsAt, `${next.startsAt}–${next.endsAt} — не промежуток`).toBe(true);
  });
});
