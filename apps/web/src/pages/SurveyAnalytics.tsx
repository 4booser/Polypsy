import { Fragment, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SurveyAnalytics as Analytics, SurveyResponse } from "@quizzy/shared";
import { api, download, openInTab } from "../api";
import { BarList, Chart, Donut, LineChart } from "../charts";
import { BoxPlot, DivergingBar, Funnel, Heatmap, Scatter, SeverityTag, boxOf } from "../charts/advanced";
import { duration, day, severityColor } from "../format";
import { useAction } from "../ui";
import { ConclusionEditor } from "../components/ConclusionEditor";

type Tab = "overview" | "questions" | "scales" | "quality" | "responses";

export default function SurveyAnalyticsPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Analytics | null>(null);
  const [versionId, setVersionId] = useState<string | undefined>();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const run = useAction();
  const downloadCsv = (sid: string) => run(() => download(api.exportUrl(sid), "data.csv"), "Файл выгружен");
  const downloadSpssData = (sid: string) => run(() => download(api.spssDataUrl(sid), "spss-data.csv"), "Матрица выгружена");
  const downloadSpssSyntax = (sid: string) => run(() => download(api.spssSyntaxUrl(sid), "syntax.sps"), "Синтаксис выгружен");
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api
      .analytics(id, versionId, { from: from || undefined, to: to || undefined })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [id, versionId, from, to]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Загрузка…</p>;

  // тепловая карта строится только по вопросам с одинаковым набором вариантов:
  // иначе столбцы означали бы разное в разных строках
  const withOptions = data.questions.filter((q) => (q.options?.length ?? 0) > 0);
  const key = (q: (typeof withOptions)[number]) => (q.options ?? []).map((o) => o.text).join("|");
  const counts = withOptions.reduce<Record<string, number>>((acc, q) => {
    acc[key(q)] = (acc[key(q)] ?? 0) + 1;
    return acc;
  }, {});
  const bestKey = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const heat = withOptions.filter((q) => key(q) === bestKey && (counts[bestKey!] ?? 0) > 1);

  /*
   * Воронка из полусотни одинаковых ступеней ничего не сообщает и ломает вёрстку.
   * Для длинных методик показываем только края и шаги, на которых кто-то отвалился.
   */
  const allStages = data.dropOff.map((d) => ({
    label: `${d.position + 1}. ${d.title}`,
    value: d.reached,
    lost: d.lost,
  }));
  const dropOffStages =
    allStages.length <= 15
      ? allStages
      : allStages.filter((s, i) => i === 0 || i === allStages.length - 1 || s.lost > 0);

  return (
    <>
      <h1>{data.title}</h1>
      <p className="sub">
        <Link to="/">Сводка</Link> · версия {data.versionNumber} · завершено {data.completed} из {data.started}
      </p>

      <div className="row" style={{ marginBottom: 14 }}>
        <label className="field" style={{ margin: 0 }}>
          <span>С даты</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>По дату</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {from || to ? (
          <button style={{ alignSelf: "flex-end" }} onClick={() => { setFrom(""); setTo(""); }}>
            Вся история
          </button>
        ) : null}
      </div>

      {data.inProgressNow.length ? (
        <div className="card" style={{ borderColor: "var(--accent)" }}>
          <div className="card-head">
            <h2>
              <i className="dot live" style={{ marginRight: 8 }} />
              Сейчас проходят: {data.inProgressNow.length}
            </h2>
            <span className="hint">черновики с автосохранением за последние 30 минут</span>
          </div>
          <div className="row tight">
            {data.inProgressNow.map((p, i) => (
              <span key={i} className="chip static">
                {p.userName ?? "аноним"} · {p.answered} отв.
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {data.versions.length > 1 ? (
        <div className="card">
          <h2>Версия методики</h2>
          <p className="hint">
            Прохождения разных версий не смешиваются — вопросы у них разные. Открыта версия с наибольшим объёмом данных.
          </p>
          <div className="row">
            {data.versions.map((v) => (
              <button
                key={v.id}
                className={`chip ${v.id === data.versionId ? "active" : ""}`}
                onClick={() => setVersionId(v.id)}
              >
                v{v.version} · {v.responseCount}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="tabs">
        {([
          ["overview", "Общее"],
          ["questions", `Вопросы ${data.questions.length}`],
          ["scales", `Шкалы ${data.scales.length}`],
          ["quality", `Качество ${data.quality.length || ""}`],
          ["responses", "Прохождения"],
        ] as [Tab, string][]).map(([v, label]) => (
          <button key={v} className={tab === v ? "active" : ""} onClick={() => setTab(v)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <>
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <div className="tile"><div className="label">Завершено</div><div className="value">{data.completed}</div><div className="hint">начато {data.started}</div></div>
            <div className="tile"><div className="label">Доходимость</div><div className="value">{data.completionRate}%</div><div className="hint">брошено {data.abandoned}</div></div>
            <div className="tile"><div className="label">Среднее время</div><div className="value">{duration(data.avgDurationMs)}</div></div>
            <div className="tile"><div className="label">Медиана</div><div className="value">{duration(data.medianDurationMs)}</div></div>
          </div>

          <Chart title="Динамика" hint="Завершённые прохождения по дням">
            <LineChart area series={[{ label: "Прохождений", points: data.timeline.map((t) => ({ x: day(t.date), y: t.count })) }]} />
          </Chart>

          <Chart title="Доходимость" hint="Завершённые против брошенных">
            <Donut
              center={`${data.completionRate}%`}
              centerLabel="дошли до конца"
              slices={[
                { label: "Завершено", value: data.completed, color: severityColor.none },
                { label: "Брошено", value: data.abandoned, color: severityColor.severe },
              ]}
            />
          </Chart>

          <Chart
            title="Где теряются респонденты"
            hint={
              dropOffStages.length < data.dropOff.length
                ? `Показаны первый, последний и шаги с потерями — всего вопросов ${data.dropOff.length}`
                : "Сколько человек дошло до каждого вопроса"
            }
          >
            <Funnel stages={dropOffStages} />
          </Chart>

          <div className="card">
            <div className="card-head">
              <h2>Выгрузки и печать</h2>
              <span className="hint">Выгрузка увозит персональные данные за пределы системы и записывается в журнал доступа</span>
            </div>
            <div className="row">
              <button onClick={() => downloadCsv(data.surveyId)}>Данные, CSV</button>
              <button onClick={() => downloadSpssData(data.surveyId)}>Матрица для SPSS</button>
              <button onClick={() => downloadSpssSyntax(data.surveyId)}>Синтаксис .sps</button>
              <Link className="btn" to={`/surveys/${data.surveyId}/blank`}>Пустой бланк</Link>
              <Link className="btn" to={`/surveys/${data.surveyId}/key`}>Ключи для сверки</Link>
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              Матрица и синтаксис — пара: положите их рядом и запустите синтаксис, он подставит
              метки переменных и значений. Пропуски закодированы как −99.
            </p>
          </div>

          <div className="row">
            <Link className="btn" to={`/surveys/${data.surveyId}/norms`}>Локальные нормы</Link>
            <Link className="btn" to={`/surveys/${data.surveyId}/access`}>Назначения пациентам</Link>
            <Link className="btn" to={`/constructor/${data.surveyId}`}>Править методику</Link>
            <Link className="btn" to={`/surveys/${data.surveyId}/administer`}>Заполнить за пациента</Link>
          </div>
        </>
      ) : null}

      {tab === "questions" ? (
        <>
          <Chart title="Время ответа по вопросам" hint="Разброс, а не только среднее">
            <BoxPlot
              boxes={data.questions
                .filter((q) => q.answered > 0)
                .map((q) => boxOf(`В${q.position + 1}`, [q.minDurationMs / 1000, q.medianDurationMs / 1000, q.avgDurationMs / 1000, q.maxDurationMs / 1000]))
                .filter((b): b is NonNullable<typeof b> => !!b)}
            />
          </Chart>

          {heat.length ? (
            <Chart title="Распределение выборов" hint="Доля респондентов по каждому варианту">
              <Heatmap
                columns={heat[0]!.options!.map((o) => o.text)}
                rows={heat.map((q) => ({ label: `${q.position + 1}. ${q.title}`, cells: q.options!.map((o) => o.percent) }))}
              />
            </Chart>
          ) : null}

          <div className="grid cols-2">
            <Chart title="Сомнения при ответе" hint="Доля респондентов, менявших ответ">
              <BarList unit="%" items={data.questions.map((q) => ({ label: `${q.position + 1}. ${q.title}`, value: q.changedShare }))} />
            </Chart>
            <Chart title="Время до первого выбора" hint="Сколько думали, прежде чем ответить">
              <BarList
                unit=" с"
                items={data.questions.map((q) => ({
                  label: `${q.position + 1}. ${q.title}`,
                  value: Math.round(q.avgTimeToFirstAnswerMs / 100) / 10,
                }))}
              />
            </Chart>
          </div>

          <div className="card scroll-x">
            <h2>Подробно по вопросам</h2>
            <p className="hint">Полная таблица метрик — сортируйте глазами, всё в одном месте</p>
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Вопрос</th><th>Тип</th>
                  <th className="num">Показан</th><th className="num">Ответов</th><th className="num">Пропуск</th>
                  <th className="num">Ср. время</th><th className="num">Медиана</th><th className="num">Разброс</th>
                  <th className="num">До выбора</th><th className="num">Правок</th><th className="num">Меняли</th><th className="num">Быстрых</th>
                </tr>
              </thead>
              <tbody>
                {data.questions.map((q) => (
                  <tr key={q.questionId}>
                    <td className="num">{q.position + 1}</td>
                    <td style={{ maxWidth: 320 }}>{q.title}</td>
                    <td className="muted">{q.type}</td>
                    <td className="num">{q.shown}</td>
                    <td className="num">{q.answered}</td>
                    <td className="num">{q.skipRate}%</td>
                    <td className="num">{duration(q.avgDurationMs)}</td>
                    <td className="num">{duration(q.medianDurationMs)}</td>
                    <td className="num">{duration(q.minDurationMs)}–{duration(q.maxDurationMs)}</td>
                    <td className="num">{duration(q.avgTimeToFirstAnswerMs)}</td>
                    <td className="num">{q.avgChangeCount}</td>
                    <td className="num">{q.changedShare}%</td>
                    <td className="num" style={{ color: q.tooFastShare > 20 ? "var(--danger)" : undefined }}>{q.tooFastShare}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.questions.filter((q) => q.numeric).map((q) => (
            <Chart key={q.questionId} title={`${q.position + 1}. ${q.title}`} hint={`среднее ${q.numeric!.average} · медиана ${q.numeric!.median} · диапазон ${q.numeric!.min}–${q.numeric!.max}`}>
                <BarList items={q.numeric!.distribution.map((d) => ({ label: String(d.value), value: d.count }))} />
            </Chart>
          ))}

          {data.questions.filter((q) => q.texts?.length).map((q) => (
            <div className="card" key={q.questionId}>
              <h2>{q.position + 1}. {q.title}</h2>
              <p className="hint">Свободные ответы: {q.texts!.length}</p>
              <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
                {q.texts!.slice(0, 40).map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>
          ))}
        </>
      ) : null}

      {tab === "scales" ? (
        <>
          {data.scales.length > 1 ? (
            <Chart title="Сравнение субшкал" hint="Разброс баллов по каждой шкале">
              <BoxPlot
                categorical
                boxes={data.scales.map((s) => boxOf(s.code, [s.min, s.average, s.median, s.max])).filter((b): b is NonNullable<typeof b> => !!b)}
              />
            </Chart>
          ) : null}

          {data.scales.map((s) => (
            <div className="card" key={s.scaleId}>
              <h2>{s.title}</h2>
              <p className="hint">среднее {s.average} · медиана {s.median} · диапазон {s.min}–{s.max} из {s.maxPossible}</p>

              <div className="grid cols-2">
                <div>
                  {s.bands.length === 0 ? (
                    <p className="muted">
                      У шкалы нет интерпретационных норм — она используется как служебная
                    </p>
                  ) : (
                  <Donut
                    center={String(s.bands.reduce((a, b) => a + b.count, 0))}
                    centerLabel="результатов"
                    slices={s.bands.map((b) => ({ label: b.label, value: b.count, color: severityColor[b.severity] }))}
                  />
                  )}
                </div>
                <div>
                  {s.reliability ? (
                    <>
                      <p style={{ margin: "0 0 6px" }}>
                        <strong>Альфа Кронбаха: {s.reliability.alpha}</strong>{" "}
                        <span className="muted">
                          ({s.reliability.alpha >= 0.8 ? "хорошая" : s.reliability.alpha >= 0.7 ? "приемлемая" : "низкая"} согласованность по {s.reliability.itemCount} пунктам)
                        </span>
                      </p>
                      <DivergingBar
                        goodThreshold={0.3}
                        items={s.reliability.items.map((it) => ({ label: it.title, value: it.itemTotalCorrelation }))}
                      />
                      <table style={{ marginTop: 12 }}>
                        <thead><tr><th>Пункт</th><th className="num">Связь</th><th className="num">α без него</th><th className="num">Дисперсия</th></tr></thead>
                        <tbody>
                          {s.reliability.items.map((it) => (
                            <tr key={it.questionId}>
                              <td style={{ maxWidth: 300 }}>{it.title}</td>
                              <td className="num">{it.itemTotalCorrelation}</td>
                              <td className="num" style={{ color: it.alphaIfDeleted !== null && it.alphaIfDeleted > s.reliability!.alpha ? "var(--danger)" : undefined }}>
                                {it.alphaIfDeleted ?? "—"}
                              </td>
                              <td className="num">{it.variance}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  ) : (
                    <p className="muted">Надёжность не считается: меньше двух пунктов или нет разброса ответов</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </>
      ) : null}

      {tab === "quality" ? (
        <>
          <div className="card">
            <h2>Признаки небрежного заполнения</h2>
            <p className="hint">
              Помечено {data.quality.length} из {data.completed}. Порог «слишком быстро» — {Math.round(data.tooFastThresholdMs / 1000)} с
              на вопрос. Это флаг для проверки специалистом, а не основание исключать данные.
            </p>
          </div>
          {data.quality.length ? (
            <>
              <Chart title="Время против доли быстрых ответов" hint="Точки у левого края прошли методику быстрее, чем её можно прочесть">
                <Scatter
                  xLabel="время прохождения, с"
                  yLabel="% быстрых"
                  xThreshold={(data.questions.length * data.tooFastThresholdMs) / 1000}
                  points={data.quality.map((q) => ({ x: Math.round(q.durationMs / 1000), y: q.tooFastShare, flagged: q.flagged }))}
                />
              </Chart>
              <div className="card scroll-x">
                <table>
                  <thead><tr><th>Респондент</th><th className="num">Время</th><th className="num">Быстрых</th><th className="num">Серия</th><th>Причины</th></tr></thead>
                  <tbody>
                    {data.quality.map((q) => (
                      <tr key={q.responseId}>
                        <td>{q.respondent ?? "Аноним"}</td>
                        <td className="num">{duration(q.durationMs)}</td>
                        <td className="num">{q.tooFastShare}%</td>
                        <td className="num">{q.longestStraightLine}</td>
                        <td className="muted">{q.reasons.join("; ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="muted">Подозрительных прохождений не найдено</p>
          )}
        </>
      ) : null}

      {tab === "responses" ? <Responses surveyId={data.surveyId} /> : null}
    </>
  );
}

function Responses({ surveyId }: { surveyId: string }) {
  const [rows, setRows] = useState<SurveyResponse[] | null>(null);
  const [openConclusion, setOpenConclusion] = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const run = useAction();
  const openReport = (rid: string) => run(() => openInTab(api.reportUrl(rid)));

  useEffect(() => {
    api
      .responses(surveyId)
      .then((page) => {
        setRows(page.rows);
        setHasMore(page.hasMore);
        setNextBefore(page.nextBefore);
      })
      .catch(() => setRows([]));
  }, [surveyId]);

  async function loadMore() {
    const page = await api.responses(surveyId, nextBefore);
    setRows((prev) => [...(prev ?? []), ...page.rows]);
    setHasMore(page.hasMore);
    setNextBefore(page.nextBefore);
  }

  if (!rows) return <p className="muted">Загрузка…</p>;

  return (
    <div className="card scroll-x">
      <h2>Прохождения</h2>
      <p className="hint">Каждая строка — отдельное обследование; заключение открывается в новой вкладке</p>
      <table>
        <thead>
          <tr><th>Респондент</th><th>Завершено</th><th className="num">Время</th><th>Статус</th><th>Баллы</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.id}>
            <tr>
              <td>{r.userName ?? "Аноним"}</td>
              <td className="muted">{r.submittedAt ? r.submittedAt.slice(0, 16).replace("T", " ") : "—"}</td>
              <td className="num">{duration(r.durationMs)}</td>
              <td className="muted">{r.status}</td>
              <td>
                {r.scores.map((s) => (
                  <div key={s.scaleId} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ minWidth: 150 }}>{s.scaleTitle}</span>
                    <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>{s.rawScore}/{s.maxScore}</span>
                    {s.band ? <SeverityTag severity={s.band.severity} label={s.band.label} /> : null}
                  </div>
                ))}
              </td>
              <td>
                <div className="row tight">
                  <button onClick={() => setOpenConclusion(openConclusion === r.id ? null : r.id)}>
                    {openConclusion === r.id ? "Свернуть" : "Заключение"}
                  </button>
                  <button onClick={() => openReport(r.id)}>Печать</button>
                </div>
              </td>
            </tr>
            {openConclusion === r.id ? (
              <tr>
                <td colSpan={6} style={{ background: "var(--surface-2)" }}>
                  <ConclusionEditor responseId={r.id} />
                </td>
              </tr>
            ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
      {hasMore ? (
        <button style={{ marginTop: 12 }} onClick={() => run(loadMore)}>
          Показать ещё
        </button>
      ) : null}
    </div>
  );
}
