import type { PatientCard, PatientCardConclusion, PatientCardResponse } from "@quizzy/shared";
import type { ConclusionState } from "../../api";
import { shownValue } from "../patients/model";

/**
 * Чистая часть карточки пациента: что печатается в столбцах вкладки
 * «Заміри», как зовётся заключение и какое из двух действий закрепления
 * («Підписатись / Відписатись») стоит в меню шапки.
 *
 * Вынесено ради проверки без React и сервера (apps/web/test/patientCard.test.ts):
 * подпись закрепления — это право, и разъехаться с ответом сервера она не
 * должна молча. Клиника карточки (методики, пункты, приёмы) — в clinical.ts,
 * колонка «Мої пацієнти» — в listModel.ts.
 */

/**
 * «Результат»: по каждой содержательной шкале — название, балл и полоса
 * интерпретации, каждая шкала своей строкой: «Тривожність: 14 — підвищена»,
 * «Депресія: 3». Балл — как его читают: доля — процентом («57%», а не
 * «0.571»), дробь — запятой языка («64,2»).
 *
 * Прежде рядом стояла «Статистика»: ещё раз дата и служебные коды шкал с
 * долей от максимума («anxiety 68,2%») — без подписи, что это за процент,
 * и английскими кодами. Дата есть в первой колонке, балл и полоса — здесь;
 * недостоверный протокол строка называет сама (вкладка «Заміри»).
 */
export function resultRows(scales: PatientCardResponse["scales"]): { title: string; value: string; band: string | null }[] {
  return scales.map((s) => {
    const v = shownValue(s.value, s.normalization);
    return { title: s.title, value: `${v.text}${v.unit}`, band: s.bandLabel ?? null };
  });
}

/**
 * Имя заключения — методика, по которой оно написано: своего названия у
 * заключения нет (conclusions привязаны к прохождению). Черновик помечен
 * словом: рядом с подписанными его «Висновки» читались бы как документ.
 */
export function conclusionName(c: Pick<PatientCardConclusion, "surveyTitle" | "status">, t: { draft: string }): string {
  return c.status === "draft" ? `${c.surveyTitle} (${t.draft})` : c.surveyTitle;
}

/**
 * Какое действие закрепления предложить. «Відписатись» — только когда
 * пациент закреплён за читателем: закрепление другого специалиста отпустить
 * нельзя (сервер ответит отказом), а взять на себя — можно, и это «Підписатись».
 */
export function leadAction(card: Pick<PatientCard, "lead">): "subscribe" | "unsubscribe" {
  return card.lead?.mine ? "unsubscribe" : "subscribe";
}

/**
 * Строки «Заключення» карточки после сохранения или подписи — из ответа
 * самого действия, без нового чтения карточки (волна 27).
 *
 * Чтение карточки журналируется (patient.card_read), и каждое действие в
 * ящике прежде перечитывало её целиком: строка журнала на каждое «Зберегти
 * чернетку». Журнал отвечает «кто открывал карточку», и открытие одно.
 *
 * Правило — то же, что у сервера (routes/patients.ts, GET /:id/card): по
 * прохождению — последняя подписанная версия любого автора и, если поверх
 * неё начат, свой черновик. В ответе сохранения черновик — свой: сохранение
 * пишет автором черновика сохранившего (routes/conclusions.ts); после
 * подписи черновика нет. Версии в ответе — от новой к старой. Порядок
 * строк — как у сервера: по времени создания, новые сверху.
 */
export function withConclusion(card: PatientCard, responseId: string, state: ConclusionState): PatientCard {
  const response = card.responses.find((r) => r.responseId === responseId);
  const known = card.conclusions.find((c) => c.responseId === responseId);
  const signed = state.versions.find((v) => v.status === "signed") ?? null;
  const draft =
    state.current?.status === "draft" && (!signed || state.current.version > signed.version) ? state.current : null;
  const rows: PatientCardConclusion[] = [signed, draft]
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .map((v) => ({
      id: v.id,
      responseId,
      surveyId: response?.surveyId ?? known?.surveyId ?? "",
      surveyTitle: response?.surveyTitle ?? known?.surveyTitle ?? "—",
      version: v.version,
      status: v.status,
      text: v.text,
      createdAt: v.createdAt,
      signedAt: v.signedAt,
      authorName: v.authorName,
    }));
  const conclusions = [...card.conclusions.filter((c) => c.responseId !== responseId), ...rows].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1,
  );
  return { ...card, conclusions };
}

/**
 * Ведущий после «Підписатись / Відписатись» — тем же правилом, что пишет
 * сервер (routes/clinic.ts, POST /patients/:userId/lead): взял — ведущий
 * читатель, отпустил — никто. Без нового чтения карточки — см. withConclusion.
 */
export function withLead(card: PatientCard, take: boolean, me: { id: string; fullName: string }): PatientCard {
  return { ...card, lead: take ? { specialistId: me.id, name: me.fullName, mine: true } : null };
}
