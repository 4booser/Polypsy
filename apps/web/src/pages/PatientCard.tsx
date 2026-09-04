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
 * Карта пациента.
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

export function usePatientCard(): CardContext {
  return useOutletContext<CardContext>();
}

export default function PatientCard() {
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
                  { to: `/patients/${data.userId}`, label: ut("pc.overview"), end: true },
                  { to: `/patients/${data.userId}/dynamics`, label: ut("pc.dynamics") },
                  { to: `/patients/${data.userId}/timeline`, label: ut("tl.title") },
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
