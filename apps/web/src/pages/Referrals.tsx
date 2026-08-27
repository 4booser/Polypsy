import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Referral } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { DataTable, Empty, Loading, PageHead, useAction } from "../ui";

export const DESTINATION_LABEL: Record<string, string> = {
  psychiatrist: "Психиатр",
  inpatient: "Стационар",
  outpatient: "Амбулаторно",
  commander: "Командиру",
  other: "Иное",
};
export const URGENCY_LABEL: Record<string, string> = {
  routine: "планово",
  urgent: "срочно",
  immediate: "немедленно",
};
export const STATUS_LABEL: Record<string, string> = {
  created: "выписано",
  accepted: "принято",
  completed: "завершено",
  declined: "отклонено",
};
export const NEXT_STATUS: Record<string, { value: string; label: string }[]> = {
  created: [
    { value: "accepted", label: "Принято" },
    { value: "declined", label: "Отклонено" },
  ],
  accepted: [
    { value: "completed", label: "Завершено" },
    { value: "declined", label: "Отклонено" },
  ],
  completed: [],
  declined: [],
};

/**
 * Реестр направлений.
 *
 * Смысл экрана — не в самих записях, а в том, что незакрытое направление
 * видно и через месяц: «отправили к психиатру» без обратной связи — самый
 * частый разрыв клинического контура.
 */
export default function ReferralsPage() {
  const [rows, setRows] = useState<Referral[] | null>(null);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useAction();

  const reload = (withClosed = all) => {
    api.referrals(withClosed).then(setRows).catch((e) => setError(e.message));
  };
  useEffect(() => {
    reload(all);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all]);

  if (error) return <p className="error">{error}</p>;
  if (!rows) return <Loading />;

  return (
    <>
      <PageHead
        title="Направления"
        sub={all ? "Все направления" : "Открытые: выписанные и принятые"}
        actions={
          <button onClick={() => setAll((v) => !v)}>
            {all ? "Только открытые" : "Показать завершённые"}
          </button>
        }
      />
      <div className="card">
        {rows.length === 0 ? (
          <Empty
            title={all ? "Направлений нет" : "Открытых направлений нет"}
            hint="Направление выписывается со сводки пациента"
          />
        ) : (
          <DataTable
            rows={rows}
            csvName="направления"
            initialSort={{ key: "createdAt", desc: true }}
            columns={[
              {
                key: "userName",
                header: "Пациент",
                render: (r: Referral) => <Link to={`/patients/${r.userId}/summary`}>{r.userName}</Link>,
                sort: (r: Referral) => r.userName,
              },
              {
                key: "destination",
                header: "Куда",
                render: (r: Referral) => DESTINATION_LABEL[r.destination] ?? r.destination,
                sort: (r: Referral) => r.destination,
              },
              {
                key: "urgency",
                header: "Срочность",
                render: (r: Referral) => (
                  <span className={r.urgency === "immediate" ? "bad" : undefined}>
                    {URGENCY_LABEL[r.urgency]}
                  </span>
                ),
                sort: (r: Referral) => r.urgency,
              },
              {
                key: "status",
                header: "Статус",
                render: (r: Referral) => STATUS_LABEL[r.status] ?? r.status,
                sort: (r: Referral) => r.status,
              },
              {
                key: "reason",
                header: "Основание",
                render: (r: Referral) => <span className="muted">{r.reason ?? "—"}</span>,
                sort: (r: Referral) => r.reason ?? "",
              },
              {
                key: "createdAt",
                header: "Выписано",
                render: (r: Referral) => (
                  <span className="muted">
                    {day(r.createdAt)}, {r.createdByName}
                  </span>
                ),
                sort: (r: Referral) => r.createdAt,
              },
              {
                key: "act",
                header: "",
                render: (r: Referral) => (
                  <div className="row tight">
                    {(NEXT_STATUS[r.status] ?? []).map((n) => (
                      <button
                        key={n.value}
                        onClick={() =>
                          run(async () => {
                            await api.updateReferral(r.id, n.value);
                            reload();
                          }, `Направление: ${n.label.toLowerCase()}`)
                        }
                      >
                        {n.label}
                      </button>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        )}
      </div>
    </>
  );
}
