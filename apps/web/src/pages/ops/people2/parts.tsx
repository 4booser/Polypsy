/*
 * Общие детали раздела «Люди й безпека»: загрузка файла из памяти (пароли
 * импорта, отчёт «хто переглядав», коды восстановления). Прежние раздел с
 * линией, флажок строки и графики сводок ушли вместе с экранами волны 11:
 * в Polypsy 2.0 их заменили панели и таблица набора.
 */

/** Отдать текст файлом — из памяти, без похода на сервер (пароли, отчёт) */
export function saveText(text: string, name: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
