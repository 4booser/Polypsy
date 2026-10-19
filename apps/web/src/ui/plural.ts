/**
 * Число со словом — одно правило на всю консоль.
 *
 * Было девять копий одного и того же (волна 27, perf-bundle): у сводки
 * (byCount/withCount), людей (plural), пациентов (plural с другим порядком
 * аргументов), методик, групп, рассылок и разделов техпанели. Правило везде
 * одно — Intl.PluralRules языка, своих таблиц нет, — а разъехаться копии
 * успели в мелочах: порядок аргументов, «локаль» или «язык» на входе.
 *
 * Записи словаря бывают двух видов:
 *  - строка с формами через «|»: «{n} людина|{n} людини|{n} людей» —
 *    byCount выбирает форму, withCount ещё и ставит число на место {n};
 *  - семья ключей `….one`, `….few`, `….many` — pluralForm даёт окончание
 *    ключа, а ключ экран собирает шаблоном с буквальным началом
 *    (`mc.n.${noun}.${pluralForm(n, lang)}`), чтобы проверка словаря видела
 *    семью в ходу.
 */

/** Окончание ключа семьи `….one|few|many` */
export type PluralForm = "one" | "few" | "many";

/**
 * Форма для семьи ключей `….one|few|many`: «1 день», «2 дні», «5 днів».
 * Дробное и «other» — как many; few у английского не бывает.
 */
export function pluralForm(n: number, lang: string): PluralForm {
  const cat = new Intl.PluralRules(lang).select(n);
  return cat === "one" ? "one" : cat === "few" ? "few" : "many";
}

/**
 * Форма строки словаря по числу: «1 сесія», «3 сесії», «5 сесій».
 *
 * Формы — через «|», в порядке категорий Intl.PluralRules: украинский и
 * русский — one|few|many|other, английский — one|other. Не хватило формы —
 * берётся последняя (три формы «один|несколько|много» отдают дробному
 * «много»). Строка без «|» возвращается целиком. Подстановки остаются как
 * есть: число, по которому выбрана форма, не обязано быть {n} — у «0 з 1
 * входу» форма идёт по {of}.
 */
export function byCount(template: string, n: number, lang: string): string {
  const forms = template.split("|");
  const order = lang.startsWith("en") ? ["one", "other"] : ["one", "few", "many", "other"];
  const at = order.indexOf(new Intl.PluralRules(lang).select(n));
  return forms[Math.min(at < 0 ? forms.length - 1 : at, forms.length - 1)] ?? template;
}

/** Число со словом в нужной форме: byCount и {n} — тем же числом */
export function withCount(template: string, n: number, lang: string): string {
  return byCount(template, n, lang).replace(/\{n\}/g, String(n));
}
