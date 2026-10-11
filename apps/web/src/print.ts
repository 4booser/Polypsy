/**
 * Печать одного блока страницы (#180).
 *
 * «Друк» плана безопасности звал голый window.print(): на лист, который
 * отдают самому человеку, ложилась вся карта — тревоги, баллы, черновик
 * заметки, заключения. Теперь блок на время печати помечается, и печатное
 * правило (styles/legacy.css, @media print) убирает всё, что его не
 * содержит и в нём не лежит. Пометки снимаются по afterprint.
 *
 * Без DOM-типов в подписи: проверяется на подставных объектах
 * (test/printScope.test.ts).
 */

/** Блок, который печатается */
export const PRINT_SCOPE = "data-print-scope";
/** Страница печатает только помеченный блок */
export const PRINTING_SCOPE = "data-printing-scope";

interface Marked {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface PrintWindow {
  document: { body: Marked };
  print(): void;
  addEventListener(type: "afterprint", fn: () => void): void;
  removeEventListener(type: "afterprint", fn: () => void): void;
}

/** Напечатать только `el`; нет блока — не печатать ничего (не всю страницу) */
export function printOnly(el: Marked | null, win: PrintWindow = window): boolean {
  if (!el) return false;
  const body = win.document.body;
  el.setAttribute(PRINT_SCOPE, "");
  body.setAttribute(PRINTING_SCOPE, "");
  const done = () => {
    el.removeAttribute(PRINT_SCOPE);
    body.removeAttribute(PRINTING_SCOPE);
    win.removeEventListener("afterprint", done);
  };
  win.addEventListener("afterprint", done);
  win.print();
  return true;
}
