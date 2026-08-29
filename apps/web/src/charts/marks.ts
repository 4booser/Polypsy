import { day } from "../format";

/**
 * Где менялась версия методики.
 *
 * Отмечается первый замер каждой новой версии, кроме самого первого замера
 * вообще: «версия 1» в начале ряда — не событие, а условие задачи.
 */
export function versionMarks(
  points: { submittedAt: string; versionNo?: number | null }[],
): { x: string; label: string }[] {
  const marks: { x: string; label: string }[] = [];
  let previous: number | null = null;

  for (const p of points) {
    const version = p.versionNo ?? null;
    if (version !== null && previous !== null && version !== previous) {
      marks.push({ x: day(p.submittedAt), label: `v${version}` });
    }
    if (version !== null) previous = version;
  }
  return marks;
}

