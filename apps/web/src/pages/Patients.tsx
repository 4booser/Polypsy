import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Respondent, RespondentDynamics } from "@quizzy/shared";
import { api, openInTab } from "../api";
import { Chart, LineChart } from "../charts";
import { Radar, SeverityTag } from "../charts/advanced";
import { day, severityColor } from "../format";
import { Avatar, DataTable, PageHead, Search, useAction, useUrlState } from "../ui";

export function PatientList() {
  const [rows, setRows] = useState<Respondent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // поиск в адресе: «вот этот пациент» отправляется ссылкой
  const [query, setQuery] = useUrlState("q");

  /*
   * Поиск ушёл на сервер: список упорядочен по ФИО, а оно зашифровано, и
   * фильтровать на клиенте можно было только то, что уже приехало. На
   * реальном объёме приезжала бы не вся выборка.
   */
  const load = (more = false) => {
    setBusy(true);
    api
      .respondents({ search: query || undefined, cursor: more ? (cursor ?? undefined) : undefined })
      .then((page) => {
        setRows((prev) => (more && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        if (!more) setTotal(page.total ?? page.items.length);
      })
      .catch(() => setRows([]))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      setCursor(null);
      load(false);
    }, query ? 300 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  if (!rows) return <p className="muted">Загрузка…</p>;

  const filtered = rows;

  return (
    <>
      <PageHead
        title="Пациенты"
        sub={`Проходившие методики ваших групп${total ? ` · ${total}` : ""}`}
        actions={<Search value={query} onChange={setQuery} placeholder="Имя или email" />}
      />
      <div className="card">
        <DataTable
          rows={filtered}
          csvName="пациенты"
          stateKey="patients"
          initialSort={{ key: "last", desc: true }}
          empty={<p className="muted">Никого не найдено</p>}
          columns={[
            {
              key: "name",
              header: "ФИО",
              sort: (r) => r.fullName,
              csv: (r) => r.fullName,
              render: (r) => (
                <Link className="row tight" to={`/patients/${r.userId}`}>
                  <Avatar name={r.fullName} />
                  {r.fullName}
                </Link>
              ),
            },
            {
              key: "email",
              header: "Email",
              sort: (r) => r.email,
              render: (r) => <span className="muted">{r.email}</span>,
            },
            {
              key: "count",
              header: "Прохождений",
              num: true,
              sort: (r) => r.count,
              render: (r) => r.count,
            },
            {
              key: "last",
              header: "Последнее",
              sort: (r) => r.last ?? "",
              csv: (r) => r.last?.slice(0, 10) ?? "",
              render: (r) => <span className="muted">{r.last?.slice(0, 10) ?? "—"}</span>,
            },
          ]}
        />
      </div>
      {cursor ? (
        <button style={{ width: "100%" }} disabled={busy} onClick={() => load(true)}>
          {busy ? "Загружаю…" : "Показать ещё"}
        </button>
      ) : null}
    </>
  );
}

export function PatientDynamics() {
  const { userId } = useParams<{ userId: string }>();
  const [data, setData] = useState<RespondentDynamics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useAction();

  useEffect(() => {
    if (!userId) return;
    api.dynamics(userId).then(setData).catch((e) => setError(e.message));
  }, [userId]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Загрузка…</p>;

  return (
    <>
      <PageHead
        title={data.fullName}
        sub={data.email}
        crumbs={<Link to="/patients">← Все пациенты</Link>}
        actions={<Link className="btn primary" to={`/patients/${data.userId}/summary`}>Сводка для консилиума</Link>}
      />

      {data.surveys.length === 0 ? <p className="muted">Завершённых прохождений нет</p> : null}

      {data.surveys.map((sv) => (
        <div key={sv.surveyId}>
          <div className="card">
            <h2>{sv.title}</h2>
            <p className="hint">
              {sv.responseCount} замеров · с {sv.firstAt?.slice(0, 10)} по {sv.lastAt?.slice(0, 10)}
            </p>
          </div>

          {sv.scales.length >= 3 ? (
            <Chart title="Профиль по субшкалам" hint="Последний замер против первого">
              <Radar
                axes={sv.scales.map((sc) => {
                  const p = sc.points.at(-1);
                  return { label: sc.title, value: p && p.maxScore > 0 ? p.rawScore / p.maxScore : 0 };
                })}
                compare={
                  sv.scales.some((sc) => sc.points.length > 1)
                    ? sv.scales.map((sc) => {
                        const p = sc.points[0];
                        return { label: sc.title, value: p && p.maxScore > 0 ? p.rawScore / p.maxScore : 0 };
                      })
                    : undefined
                }
              />
            </Chart>
          ) : null}

          <div className="grid cols-2">
            {sv.scales.map((sc) => {
              const last = sc.points.at(-1);
              return (
                <Chart
                  key={sc.scaleId}
                  title={sc.title}
                  hint={rciHint(sc)}
                >
                  <LineChart
                    yMax={last?.maxScore}
                    series={[{
                      label: sc.title,
                      points: sc.points.map((p) => ({
                        x: day(p.submittedAt),
                        y: p.rawScore,
                        tone: p.severity ? severityColor[p.severity] : undefined,
                      })),
                    }]}
                  />
                  {last ? (
                    <table style={{ marginTop: 10 }}>
                      <tbody>
                        <tr><td>Последний замер</td><td className="num">{last.rawScore} из {last.maxScore}</td></tr>
                        {last.severity ? <tr><td>Интерпретация</td><td className="num"><SeverityTag severity={last.severity} label={last.bandLabel ?? undefined} /></td></tr> : null}
                        {sc.reliableChange ? (
                          <tr>
                            <td>Достоверность сдвига</td>
                            <td className="num">
                              {sc.reliableChange.significant ? (
                                <strong style={{ color: "var(--accent)" }}>
                                  достоверный ({sc.reliableChange.direction === "up" ? "рост" : "снижение"}, RCI {sc.reliableChange.rci})
                                </strong>
                              ) : (
                                <span className="muted">в пределах ошибки (RCI {sc.reliableChange.rci})</span>
                              )}
                            </td>
                          </tr>
                        ) : null}
                        <tr>
                          <td>Перцентиль</td>
                          <td className="num">
                            {last.percentile === null ? <span className="muted">выборка мала</span> : `выше, чем у ${last.percentile}%`}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  ) : null}
                  {last ? (
                    <button style={{ marginTop: 10 }} onClick={() => run(() => openInTab(api.reportUrl(last.responseId)))}>
                      Заключение
                    </button>
                  ) : null}
                </Chart>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * Подпись под графиком: сырая дельта плюс вердикт достоверности.
 *
 * Дельта без RCI вводит в заблуждение: сдвиг на 13 T-баллов при широком
 * разбросе выборки — шум, а на 0.23 доли при α=0.92 — реальное изменение.
 */
function rciHint(sc: {
  delta: number | null;
  reliableChange: { rci: number; significant: boolean; basis: { sd: number; alpha: number; sampleN: number } } | null;
}): string {
  if (sc.delta === null) return "нужен второй замер для динамики";
  const base = `изменение: ${sc.delta > 0 ? "+" : ""}${sc.delta}`;
  const rc = sc.reliableChange;
  if (!rc) return `${base} · достоверность не оценить (мало выборки или одно-пунктовая шкала)`;
  return rc.significant
    ? `${base} · превышает ошибку измерения (RCI ${rc.rci}, α ${rc.basis.alpha})`
    : `${base} · в пределах ошибки измерения (RCI ${rc.rci}, α ${rc.basis.alpha})`;
}
