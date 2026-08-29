import { Link, useParams } from "react-router-dom";
import type { Respondent, UiKey } from "@quizzy/shared";
import { api, openInTab } from "../api";
import { Chart, LineChart } from "../charts";
import { versionMarks } from "../charts/marks";
import { Radar, SeverityTag } from "../charts/advanced";
import { day, severityColor } from "../format";
import { Avatar, DataTable, Loading, PageHead, Search, useAction, useUrlState } from "../ui";
import { useLang } from "../lang";
import { SavedViews } from "../ui/SavedViews";
import { usePagedResource, useResource } from "../useResource";

export function PatientList() {
  // поиск в адресе: «вот этот пациент» отправляется ссылкой
  const [query, setQuery] = useUrlState("q");
  const { ut } = useLang();

  /*
   * Поиск ушёл на сервер: список упорядочен по ФИО, а оно зашифровано, и
   * фильтровать на клиенте можно было только то, что уже приехало. На
   * реальном объёме приезжала бы не вся выборка.
   */
  const page = usePagedResource<Respondent>(
    (cursor) => api.respondents({ search: query || undefined, cursor: cursor ?? undefined }),
    [query],
    { debounceMs: 300 },
  );
  const { items: rows, total } = page;

  if (!rows) return <Loading rows={6} error={page.error} />;

  const filtered = rows;

  return (
    <>
      <PageHead
        title={ut("patients.title")}
        sub={`${ut("patients.sub")}${total ? ` · ${total}` : ""}`}
        actions={<Search value={query} onChange={setQuery} placeholder={ut("ui.search")} />}
      />
      <div className="card">
        <div className="table-tools">
          <SavedViews scope="patients" />
        </div>
        <DataTable
          rows={filtered}
          csvName={ut("pt.patients")}
          stateKey="patients"
          initialSort={{ key: "last", desc: true }}
          facetNote={
            page.hasMore ? `${ut("tbl.facetsOnLoaded")} ${rows.length}` : undefined
          }
          facets={[
            { key: "unit", label: ut("person.unit"), valueOf: (r) => r.unit },
            {
              key: "sex",
              label: ut("person.sex"),
              valueOf: (r) =>
                r.sex === "male" ? ut("adm.male") : r.sex === "female" ? ut("adm.female") : null,
            },
            {
              key: "act",
              label: ut("pt.activity"),
              /*
               * Порог в тридцать дней, а не «последний месяц»: рубеж должен
               * быть один и тот же, из какого бы дня месяца на него ни
               * смотрели.
               */
              valueOf: (r) =>
                !r.last
                  ? null
                  : Date.now() - new Date(r.last).getTime() < 30 * 86_400_000
                    ? ut("pt.recent")
                    : ut("pt.stale"),
            },
          ]}
          empty={<p className="muted">{ut("pt.nobodyFound")}</p>}
          columns={[
            {
              key: "name",
              header: ut("patients.name"),
              required: true,
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
              key: "unit",
              header: ut("person.unit"),
              sort: (r) => r.unit ?? "",
              render: (r) => <span className="muted">{r.unit ?? "—"}</span>,
            },
            {
              key: "email",
              header: "Email",
              hiddenByDefault: true,
              sort: (r) => r.email,
              render: (r) => <span className="muted">{r.email}</span>,
            },
            {
              key: "count",
              header: ut("patients.measurements"),
              num: true,
              sort: (r) => r.count,
              render: (r) => r.count,
            },
            {
              key: "last",
              header: ut("patients.last"),
              sort: (r) => r.last ?? "",
              csv: (r) => r.last?.slice(0, 10) ?? "",
              render: (r) => <span className="muted">{r.last?.slice(0, 10) ?? "—"}</span>,
            },
          ]}
        />
      </div>
      {page.hasMore ? (
        <button style={{ width: "100%" }} disabled={page.loadingMore} onClick={page.loadMore}>
          {page.loadingMore ? ut("ui.loading") : ut("ui.loadMore")}
        </button>
      ) : null}
    </>
  );
}

export function PatientDynamics() {
  const { ut } = useLang();
  const { userId } = useParams<{ userId: string }>();
  const { run } = useAction();
  const { data, error } = useResource(() => api.dynamics(userId!), [userId], { enabled: !!userId });

  if (error) return <p className="error">{error}</p>;
  if (!data) return <Loading rows={5} />;

  return (
    <>
      <PageHead
        title={data.fullName}
        sub={data.email}
        crumbs={<Link to="/patients">{ut("patients.all")}</Link>}
        actions={<Link className="btn primary" to={`/patients/${data.userId}/summary`}>{ut("patients.summary")}</Link>}
      />

      {data.surveys.length === 0 ? <p className="muted">{ut("pt.noCompleted")}</p> : null}

      {data.surveys.map((sv) => (
        <div key={sv.surveyId}>
          <div className="card">
            <h2>{sv.title}</h2>
            <p className="hint">
              {sv.responseCount} замеров · с {sv.firstAt?.slice(0, 10)} по {sv.lastAt?.slice(0, 10)}
            </p>
          </div>

          {sv.scales.length >= 3 ? (
            <Chart title={ut("pt.profileBySubscales")} hint={ut("pt.lastVsFirst")}>
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
                  hint={rciHint(sc, ut)}
                >
                  <LineChart
                    /*
                     * Отметки смены версии методики. Скачок сразу после
                     * правки ключей — артефакт, а не динамика, и прочесть
                     * его как улучшение стоит дороже, чем лишний пунктир.
                     */
                    marks={versionMarks(sc.points)}
                    yMax={last?.maxScore}
                    series={[{
                      label: sc.title,
                      points: sc.points.map((p) => ({
                        x: day(p.submittedAt),
                        y: p.rawScore,
                        tone: p.severity ? severityColor[p.severity] : undefined,
                        /*
                         * Полоса ошибки измерения. Без неё 62 и 65 выглядят
                         * как разные числа, хотя при SEM = 4 это одно и то же
                         * измерение. Если SEM посчитать не из чего, полоса не
                         * рисуется: придуманный интервал выглядит как знание.
                         */
                        err: sc.sem ?? null,
                      })),
                    }]}
                  />
                  {last ? (
                    <table style={{ marginTop: 10 }}>
                      <tbody>
                        <tr><td>{ut("pt.lastMeasure")}</td><td className="num">{last.rawScore} из {last.maxScore}</td></tr>
                        {last.severity ? <tr><td>{ut("pt.interpretation")}</td><td className="num"><SeverityTag severity={last.severity} label={last.bandLabel ?? undefined} /></td></tr> : null}
                        {sc.reliableChange ? (
                          <tr>
                            <td>{ut("pt.rciTitle")}</td>
                            <td className="num">
                              {sc.reliableChange.significant ? (
                                <strong style={{ color: "var(--accent)" }}>
                                  достоверный ({sc.reliableChange.direction === "up" ? ut("pt.growth") : ut("pt.decline")}, RCI {sc.reliableChange.rci})
                                </strong>
                              ) : (
                                <span className="muted">в пределах ошибки (RCI {sc.reliableChange.rci})</span>
                              )}
                            </td>
                          </tr>
                        ) : null}
                        <tr>
                          <td>{ut("pt.percentile")}</td>
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
function rciHint(
  sc: {
    delta: number | null;
    reliableChange: { rci: number; significant: boolean; basis: { sd: number; alpha: number; sampleN: number } } | null;
  },
  // переводчик аргументом: функция чистая и живёт вне компонента
  ut: (k: UiKey) => string,
): string {
  if (sc.delta === null) return ut("pt.needSecond");
  const base = `${ut("pt.change")}: ${sc.delta > 0 ? "+" : ""}${sc.delta}`;
  const rc = sc.reliableChange;
  if (!rc) return `${base} · ${ut("pt.rciUnknown")}`;
  const verdict = rc.significant ? ut("pt.rciAbove") : ut("pt.rciWithin");
  return `${base} · ${verdict} (RCI ${rc.rci}, α ${rc.basis.alpha})`;
}
