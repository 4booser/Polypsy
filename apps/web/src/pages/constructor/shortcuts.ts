/**
 * Сочетания редакторов (конструктор, заключение): Ctrl/⌘+S — сохранить,
 * Ctrl/⌘+Z — отменить, Ctrl/⌘+Shift+Z и Ctrl/⌘+Y — вернуть.
 *
 * По физической клавише (e.code), а не по знаку (e.key). В украинской и
 * русской раскладке Ctrl+S приходит со знаком «і» / «ы», Ctrl+Z — с «я», и
 * сочетание молча не срабатывало: вместо черновика браузер открывал
 * «Сохранить страницу как». Знак — только запасной путь, когда клавиша не
 * названа (экранная клавиатура, часть IME).
 *
 * С Alt — не сочетание: Ctrl+Alt — это AltGr, которым в польской раскладке
 * набирают «ś».
 */
export type EditorShortcut = "save" | "undo" | "redo";

type Keys = Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

export function editorShortcut(e: Keys): EditorShortcut | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const named = e.code && e.code !== "Unidentified";
  const is = (code: string, letter: string) => (named ? e.code === code : e.key.toLowerCase() === letter);
  if (is("KeyS", "s")) return "save";
  if (is("KeyZ", "z")) return e.shiftKey ? "redo" : "undo";
  if (is("KeyY", "y")) return "redo";
  return null;
}
