import { useLang } from "../../lang";
import { Tabs } from "../../ui/primitives";

/**
 * Вкладки прохождения: «Відповіді» (кадр f34, протокол) и «Графіки».
 *
 * Два адреса, а не состояние одного экрана: /surveys/:id/responses/:rid и
 * тот же адрес с /charts. Ссылку на графики пересылают коллеге так же, как
 * ссылку на протокол, и карточка пациента ведёт прямо на графики (решение
 * заказчика 2026-09-26, см. PatientCard.tsx) — у вкладки-состояния адреса
 * не было бы, и открыть её снаружи было бы нечем.
 *
 * Вкладки — ссылками (Tabs с `to`), под заголовком экрана, как на списке
 * пациентов: строка заголовка f34 занята названием теста и подписью языка, и
 * третий участник её бы переносил. «Відповіді» с `end`: иначе NavLink считал
 * бы её активной и на /charts — адрес графиков начинается с адреса ответов.
 */
export function ResponseTabs({ surveyId, responseId }: { surveyId: string; responseId: string }) {
  const { ut } = useLang();
  return (
    <div className="mb-[24px]">
      <Tabs
        label={ut("rch.tabsLabel")}
        items={[
          { to: `/surveys/${surveyId}/responses/${responseId}`, label: ut("rch.tabAnswers"), end: true },
          { to: `/surveys/${surveyId}/responses/${responseId}/charts`, label: ut("rch.tabCharts") },
        ]}
      />
    </div>
  );
}
