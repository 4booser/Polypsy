/**
 * Пункты выбора с уже выбранным значением, которое выбрать заново нельзя.
 *
 * Волна 12, разбор кода: «селект методики скрывал выбранную снятую или
 * недоступную методику». Списки выбора строятся из того, что можно выбрать
 * СЕЙЧАС: без снятых с использования, без чужих групп, без архивных батарей.
 * А сохранённое значение — назначение, состав батареи, отбор, каскад
 * полосы — пережило свою методику. Управляемый <select> без совпадающего
 * пункта рисует первый («любая методика», «без каскада»), и человек видит
 * одно, а сохраняется другое: правка названия молча оставляет в силе то,
 * чего на экране нет, или — если нажать «сохранить» после выбора первого
 * пункта — молча стирает.
 *
 * Правило одно на все такие места: выбранное остаётся в списке, первым и с
 * пометкой — «знято з використання», если мы знаем, что его сняли, и
 * «недоступна», если сервер его не отдал (чужая группа, удалена). Заново
 * его не предложат: пометка есть только у уже выбранного.
 *
 * Селект правил аналитики (analytics/Editor.tsx, SurveyOptions) делал это
 * раньше своим кодом; здесь то же правило для остальных.
 */

export type ChoiceState = "live" | "retired" | "unavailable";

export interface Choice {
  id: string;
  title: string;
  state: ChoiceState;
}

/** Что известно о выбранном значении, которого нет среди доступных */
export interface Known {
  title: string;
  retired: boolean;
}

/**
 * Доступные пункты и — впереди — выбранные, которых среди доступных нет.
 *
 * `known(id)` отвечает, что мы знаем о таком значении: название и снято ли
 * оно, или null — не знаем ничего (сервер не отдал). Пустое значение
 * («не выбрано») пунктом не становится.
 */
export function keepChosen(
  live: readonly { id: string; title: string }[],
  chosen: string | readonly string[],
  known: (id: string) => Known | null,
): Choice[] {
  const ids = (typeof chosen === "string" ? [chosen] : chosen).filter(Boolean);
  const liveIds = new Set(live.map((x) => x.id));
  const kept: Choice[] = [];
  for (const id of new Set(ids)) {
    if (liveIds.has(id)) continue;
    const k = known(id);
    kept.push(
      k
        ? { id, title: k.title, state: k.retired ? "retired" : "unavailable" }
        : { id, title: "", state: "unavailable" },
    );
  }
  return [...kept, ...live.map((x) => ({ id: x.id, title: x.title, state: "live" as const }))];
}

/**
 * Подпись пункта: название и пометка словами.
 *
 * Пометка — текстом, а не цветом или курсивом: <option> почти не принимает
 * оформления, а диктор читает только текст. Недоступное без названия —
 * общей фразой: голый идентификатор человек не узнает.
 */
export function choiceLabel(
  c: Choice,
  words: { retired: string; unavailable: string; unknown: string },
): string {
  if (c.state === "live") return c.title;
  if (!c.title) return words.unknown;
  return `${c.title} (${c.state === "retired" ? words.retired : words.unavailable})`;
}
