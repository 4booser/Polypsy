/** Склейка классов: отбрасывает false, undefined и пустые строки. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
