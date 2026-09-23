import { useState } from "react";
import { Link, Outlet, useOutletContext, useParams } from "react-router-dom";
import type { CaseSummary } from "@quizzy/shared";
import { api } from "../api";
import { dateTime } from "../format";
import { useAuth } from "../auth";
import { Screen } from "../ui";
import { Page } from "../ui/layout";
import { Tabs } from "../ui/primitives";
import { useLang } from "../lang";
import { Here } from "../components/Here";
import { ReferralForm } from "./CaseSummary";
import { useResource } from "../useResource";

/**
 * Клиническая карта пациента: сводка, динамика, хронология.
 *
 * Адрес — /patients/:id/case. Сам /patients/:id занят карточкой по кадру
 * f19 заказчика (pages/patientCard/PatientCard.tsx): персональные данные,
 * «Тести», «Групи», «Заключення». Эта карта с кадра не убрана намеренно —
 * план безопасности, записи приёма, направления и графики с RCI живут
 * только здесь, и терять их ради буквы макета нельзя; дверь сюда — меню за
 * шестерёнкой в шапке карточки, прежние адреса (/summary, /dynamics,
 * /timeline) перенаправляются (App.tsx).
 *
 * До этого один человек жил на трёх экранах: `/patients/:id` — динамика,
 * `/patients/:id/summary` — сводка, `/patients/:id/timeline` — хронология.
 * Каждый со своим заголовком, своими хлебными крошками и своей кнопкой
 * перехода на два соседних. Открыть человека значило выбрать, каким из трёх
 * его сегодня посмотреть, а посмотреть целиком — обойти все три и сложить
 * картину в голове.
 *
 * Теперь это один экран с тремя вкладками, и делятся они не по источникам
 * данных, а по вопросам, которые задают о человеке:
 *
 *   • **Обзор** — что с ним сейчас: незакрытые тревоги, последние измерения,
 *     план безопасности, записи приёма, направления;
 *   • **Динамика** — как менялось: графики по шкалам с полосой ошибки
 *     измерения и надёжностью изменения;
 *   • **Хронология** — что происходило и в каком порядке.
 *
 * Шапка общая и не перерисовывается при переключении: имя, пол, возраст,
 * подразделение и действия — это свойства человека, а не вкладки.
 *
 * Вкладка стоит в адресе, а не в состоянии компонента. Карту пересылают
 * коллеге и кладут в закладку; вкладка на состоянии открывалась бы не на
 * том, что человек смотрел, и молча.
 */

/** Данные шапки, чтобы вкладка «Обзор» не запрашивала их второй раз */
export interface CardContext {
  data: CaseSummary;
  reload: () => void;
}

export function useCaseCard(): CardContext {
  return useOutletContext<CardContext>();
}

export default function CaseCard() {
  const { userId } = useParams<{ userId: string }>();
  const { user } = useAuth();
  const { ut } = useLang();
  const [showForm, setShowForm] = useState(false);

  const res = useResource(() => api.caseSummary(userId!), [userId], { enabled: !!userId });
  const reload = res.reload;

  return (
    <Screen res={res}>
      {(data) => (
        <>
          {/* штамп для подшивки: без «кто и когда распечатал» лист в деле безымянный */}
          <p className="print-only hint">
            {ut("sum.formedAt")} {dateTime(new Date().toISOString())}
            {user ? ` · ${user.lastName ?? ""} ${user.firstName ?? ""}`.trimEnd() : ""}
          </p>
          <Page
            title={data.fullName}
            crumbs={<Link to="/patients">{ut("patients.all")}</Link>}
            sub={[
              data.sex === "male" ? ut("adm.male") : data.sex === "female" ? ut("adm.female") : null,
              data.age !== null ? `${data.age}` : null,
              data.unit,
            ]
              .filter(Boolean)
              .join(" · ")}
            actions={
              <>
                <Here resource={`patient:${data.userId}`} />
                <button onClick={() => setShowForm((v) => !v)}>{ut("ref.new")}</button>
                <button onClick={() => window.print()}>{ut("sum.print")}</button>
              </>
            }
            toolbar={
              /*
               * Вкладки в панели инструментов, а не отдельной полосой над
               * содержимым: они относятся к экрану целиком и должны стоять
               * там же, где стоят фильтры на остальных экранах.
               */
              <Tabs
                items={[
                  { to: `/patients/${data.userId}/case`, label: ut("pc.overview"), end: true },
                  { to: `/patients/${data.userId}/case/dynamics`, label: ut("pc.dynamics") },
                  { to: `/patients/${data.userId}/case/timeline`, label: ut("tl.title") },
                ]}
              />
            }
          >
            {showForm ? (
              <ReferralForm
                userId={data.userId}
                onDone={() => {
                  setShowForm(false);
                  reload();
                }}
              />
            ) : null}

            <Outlet context={{ data, reload } satisfies CardContext} />
          </Page>
        </>
      )}
    </Screen>
  );
}
