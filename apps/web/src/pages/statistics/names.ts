import { PATIENT_NAMES_MAX } from "@quizzy/shared";
import { api } from "../../api";

/**
 * Имя человека по идентификатору — без карточки, и одним запросом на всех,
 * кого спросили в один такт (волна 27).
 *
 * Поле «Пацієнт» стоит в условиях каждой выборки, и все поля страницы
 * спрашивают имена разом — при открытии. Прежде каждое читало карточку
 * человека (GET /api/patients/:id/card: «Тести», «Групи», «Заключення»,
 * телефон и строка patient.card_read) ради одной подписи. Теперь —
 * GET /api/patients/names: только имена, журнал — как у выбора пациента.
 *
 * Запрос уходит в микрозадаче, вне загрузки одного поля: отмена загрузки
 * одного поля (ушли со страницы, сменили фильтр) не обрывает общий запрос
 * остальным. Ответ без человека — null: вне зоны или не пациент.
 */
type Waiter = { resolve: (name: string | null) => void; reject: (error: unknown) => void };

let pending = new Map<string, Waiter[]>();
let scheduled = false;

async function flush(): Promise<void> {
  scheduled = false;
  const batch = pending;
  pending = new Map();
  try {
    const ids = [...batch.keys()];
    const parts = await Promise.all(
      Array.from({ length: Math.ceil(ids.length / PATIENT_NAMES_MAX) }, (_, i) =>
        api.patientNames(ids.slice(i * PATIENT_NAMES_MAX, (i + 1) * PATIENT_NAMES_MAX)),
      ),
    );
    const nameOf = new Map(parts.flatMap((p) => p.items).map((p) => [p.id, p.fullName]));
    for (const [id, waiters] of batch) for (const w of waiters) w.resolve(nameOf.get(id) ?? null);
  } catch (error) {
    for (const waiters of batch.values()) for (const w of waiters) w.reject(error);
  }
}

export function patientName(id: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    pending.set(id, [...(pending.get(id) ?? []), { resolve, reject }]);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => void flush());
  });
}
