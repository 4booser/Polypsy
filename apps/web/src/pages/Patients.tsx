import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Respondent, UiKey } from "@quizzy/shared";
import { api, openInTab } from "../api";
import { Chart, LineChart } from "../charts";
import { versionMarks } from "../charts/marks";
import { Hint } from "../components/Hint";
import { Radar, SeverityTag } from "../charts/advanced";
import { day, severityColor } from "../format";
import { Avatar, DataTable, Loading, Search, useAction, useUrlState } from "../ui";
import { Page, Panel } from "../ui/layout";
import { PatientContext } from "../components/PatientContext";
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
  /*
   * Выбранная строка хранится целиком, а не одним идентификатором: панель
   * справа рисуется сразу из того, что уже приехало со списком, и не мигает
   * пустотой, пока летит запрос за подробностями.
   */
  const [selected, setSelected] = useState<Respondent | null>(null);

  if (!rows) return <Loading rows={6} error={page.error} />;

  const filtered = rows;

  return (
    <Page
      title={ut("patients.title")}
      sub={ut("patients.sub")}
      count={total ?? null}
      actions={<Search value={query} onChange={setQuery} placeholder={ut("ui.search")} />}
      toolbar={<SavedViews scope="patients" />}
      contextTitle={ut("pt.whoIsThis")}
      context={
        selected ? (
          <PatientContext person={selected} />
        ) : (
          <p className="m-0 text-caption text-muted">{ut("pt.pickRow")}</p>
        )
      }
    >
      <Panel flush>
        <DataTable
          onRowClick={setSelected}
          isRowActive={(r) => r.userId === selected?.userId}
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
              /*
                Год рождения стоит сразу за именем.
                В списке из сотни человек тёзки встречаются — имена в стране
                не бесконечны, — и различить их было нечем: одинаковые
                строки, разные люди. Открыть карту не того человека в
                поликлинике стоит дорого, а в регистратуре их различают
                именно годом.
              */
              key: "birthYear",
              header: ut("person.birthYear"),
              num: true,
              sort: (r) => r.birthYear ?? 0,
              csv: (r) => (r.birthYear ? String(r.birthYear) : ""),
              render: (r) =>
                r.birthYear ? (
                  <span className="tabular-nums">{r.birthYear}</span>
                ) : (
                  <span className="text-faint">—</span>
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
              render: (r) => <span className="muted">{r.last ? day(r.last) : "—"}</span>,
            },
          ]}
        />
      </Panel>
      {page.hasMore ? (
        <button className="mt-4 w-full justify-center" disabled={page.loadingMore} onClick={page.loadMore}>
          {page.loadingMore ? ut("ui.loading") : ut("ui.loadMore")}
        </button>
      ) : null}
    </Page>
  );
}

/**
 * Вкладка «Динамика» карты пациента: как менялось.
 *
 * Была отдельным экраном со своим заголовком и кнопкой перехода на сводку.
 * Имя, подразделение и действия переехали в шапку карты — здесь остались
 * только графики, ради которых на неё и заходят.
 */
export function PatientDynamics() {
  const { ut } = useLang();
  const [equating, setEquating] = useState(false);
  const { userId } = useParams<{ userId: string }>();
  const { run } = useAction();
  const { data, error } = useResource(() => api.dynamics(userId!), [userId], { enabled: !!userId });

  if (error) return <p className="error">{error}</p>;
  if (!data) return <Loading rows={5} />;

  return (
    <>
      {data.surveys.length === 0 ? <p className="text-muted">{ut("pt.noCompleted")}</p> : null}

      {data.surveys.map((sv) => (
        <div key={sv.surveyId}>
          <div className="card">
            <h2>{sv.title}</h2>
            <p className="hint">
              {sv.responseCount} {ut("sum.measurements")} · {ut("ec.since")}{" "}
              {sv.firstAt ? day(sv.firstAt) : "—"} {ut("sch.to")}{" "}
              {sv.lastAt ? day(sv.lastAt) : "—"}
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

          <Hint id="stens" text="hint.stens" />

          {/*
            Сведение версий предлагается только там, где версии действительно
            разные, и никогда не включается само: оно опирается на допущение о
            сопоставимости выборок, а знает о нём человек, а не программа.
          */}
          {sv.scales.some((sc) => sc.equated?.length) ? (
            <div className="card">
              <label className="row tight">
                <input
                  type="checkbox"
                  checked={equating}
                  onChange={(e) => setEquating(e.target.checked)}
                />
                <strong>{ut("eq.title")}</strong>
              </label>
              <p className="hint" style={{ marginBottom: 0 }}>{ut("eq.hint")}</p>
            </div>
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
                    /*
                     * Полная шкала уходит в подпись, а не в ось. Ось,
                     * растянутая до максимума методики, прижимала все замеры к
                     * низу поля: на демонстрационной базе данные занимали
                     * пятую часть высоты, и динамика любой шкалы у любого
                     * человека выглядела одинаково — плоской чертой внизу.
                     */
                    fullRange={last?.maxScore}
                    series={[{
                      label: sc.title,
                      points: sc.points.map((p) => ({
                        x: day(p.submittedAt),
                        y: equating ? equatedValue(p, sc.equated) : p.rawScore,
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
                        <tr><td>{ut("pt.lastMeasure")}</td><td className="num">{last.rawScore} {ut("an.of")} {last.maxScore}</td></tr>
                        {last.severity ? <tr><td>{ut("pt.interpretation")}</td><td className="num"><SeverityTag severity={last.severity} label={last.bandLabel ?? undefined} /></td></tr> : null}
                        {sc.reliableChange ? (
                          <tr>
                            <td>{ut("pt.rciTitle")}</td>
                            <td className="num">
                              {sc.reliableChange.significant ? (
                                <strong style={{ color: "var(--accent)" }}>
                                  {ut("pt.reliable")} ({sc.reliableChange.direction === "up" ? ut("pt.growth") : ut("pt.decline")}, RCI {sc.reliableChange.rci})
                                </strong>
                              ) : (
                                <span className="muted">{ut("sum.withinError")} (RCI {sc.reliableChange.rci})</span>
                              )}
                            </td>
                          </tr>
                        ) : null}
                        <tr>
                          <td>{ut("pt.percentile")}</td>
                          <td className="num">
                            {last.percentile === null ? <span className="muted">{ut("mark.smallSample")}</span> : `${ut("pt.higherThanPct")} ${last.percentile}%`}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  ) : null}
                  {last ? (
                    <button style={{ marginTop: 10 }} onClick={() => run(() => openInTab(api.reportUrl(last.responseId)))}>
                      {ut("an.conclusion")}
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
/**
 * Балл, приведённый к версии последнего замера.
 *
 * Если для версии этой точки коэффициентов нет — балл остаётся своим. Это
 * лучше, чем прятать точку: пропуск в ряду читается как «замера не было», а
 * замер был, просто свести его не из чего.
 */
function equatedValue(
  point: { rawScore: number; versionNo?: number | null },
  rules: { fromVersion: number; slope: number; intercept: number }[] | null | undefined,
): number {
  const rule = rules?.find((r) => r.fromVersion === point.versionNo);
  if (!rule) return point.rawScore;
  return Math.round((rule.slope * point.rawScore + rule.intercept) * 100) / 100;
}

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
