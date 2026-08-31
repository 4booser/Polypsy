import { Fragment, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SurveyResponse } from "@quizzy/shared";
import { api, download, openInTab, type VersionDiffResult } from "../api";
import { BarList, Chart, Donut, LineChart } from "../charts";
import { ItemHeatmap } from "../components/ItemHeatmap";
import { BoxPlot, DivergingBar, Funnel, Heatmap, Scatter, SeverityTag, boxOf } from "../charts/advanced";
import { duration, day, severityColor } from "../format";
import { Loading, OfflineBar, useAction } from "../ui";
import { Page, Panel, Grid, Stack } from "../ui/layout";
import { Button } from "../ui/primitives";
import { ConclusionEditor } from "../components/ConclusionEditor";
import { DifPanel } from "../components/DifPanel";
import { CalibrationPanel } from "../components/CalibrationPanel";
import { DataQualityPanel } from "../components/DataQualityPanel";
import { useLang } from "../lang";
import { useResource } from "../useResource";

type Tab = "overview" | "questions" | "scales" | "quality" | "dif" | "calibration" | "responses";

export default function SurveyAnalyticsPage() {
  const { ut } = useLang();
  const { id } = useParams<{ id: string }>();
  const [versionId, setVersionId] = useState<string | undefined>();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { run } = useAction();
  const downloadCsv = (sid: string) => run(() => download(api.exportUrl(sid), "data.csv"), ut("an.fileExported"));
  const [profile, setProfile] = useState<"full" | "deidentified" | "anonymous">("full");
  const [purpose, setPurpose] = useState("");
  const downloadSpssData = (sid: string) =>
    run(() => download(api.spssDataUrl(sid, profile), "spss-data.csv"), ut("an.matrixExported"));
  const downloadSpssSyntax = (sid: string) =>
    run(() => download(api.spssSyntaxUrl(sid, profile), "syntax.sps"), ut("an.syntaxExported"));
  const downloadCodebook = (sid: string) =>
    run(() => download(api.codebookUrl(sid, profile), "codebook.csv"), "Codebook выгружен");
  const downloadManifest = (sid: string) =>
    run(() => download(api.manifestUrl(sid, profile, purpose), "manifest.json"), ut("rep.manifestDone"));
  const downloadScript = (sid: string, ext: "r" | "py") =>
    run(() => download(api.loadScriptUrl(sid, ext, profile), `load.${ext}`), ut("rep.scriptDone"));
  const downloadLong = (sid: string) =>
    run(() => download(api.longUrl(sid, profile), "long.csv"), "Long-format выгружен");
  const [tab, setTab] = useState<Tab>("overview");

  /*
   * Через useResource, а не useEffect: поле периода шлёт запрос на каждое
   * нажатие, запросы разной тяжести идут разное время, и ответ по широкому
   * периоду успевал затереть данные по узкому. Человек видел аналитику за
   * период, который не запрашивал.
   */
  const res = useResource(
    () => api.analytics(id!, versionId, { from: from || undefined, to: to || undefined }),
    [id, versionId, from, to],
    { enabled: !!id },
  );
  const data = res.data;

  if (res.error) return <p className="text-danger text-small">{res.error}</p>;
  if (!data) return res.offline ? <OfflineBar onRetry={res.reload} /> : <Loading rows={5} />;

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
    <Page
      title={data.title}
      crumbs={<Link to="/">{ut("back.toDashboard")}</Link>}
      sub={`${ut("an.version")} ${data.versionNumber} · ${ut("an.completedOf")} ${data.completed} ${ut("an.of")} ${data.started}`}
      actions={
        /*
         * Период — часть заголовка, а не отдельная строка под ним: он
         * определяет, о каком срезе весь экран, и стоять должен рядом с
         * названием, а не теряться между заголовком и первым графиком.
         */
        <div className="date-range">
          <label>
            <span>с</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={ut("unit.chooseHint")} />
          </label>
          <label>
            <span>по</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label={ut("an.periodEnd")} />
          </label>
          {from || to ? (
            <Button variant="quiet" onClick={() => { setFrom(""); setTo(""); }}>
              {ut("an.allHistory")}
            </Button>
          ) : null}
        </div>
      }
    >
      {res.offline ? <OfflineBar onRetry={res.reload} busy={res.refreshing} /> : null}
      <Stack>
      {/*
        Живой список «сейчас проходят» — сведения, а не сигнал. Янтарная
        рамка здесь досталась от прежней вёрстки и означала бы «требует
        внимания»: человек, спокойно отвечающий на вопросы, внимания не
        требует. Отмечено бирюзой — тем же цветом, что и всё живое в
        интерфейсе.
      */}
      {data.inProgressNow.length ? (
        <Panel className="border border-[color-mix(in_srgb,var(--primary)_45%,transparent)]">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h2 className="m-0 flex items-center gap-2 font-display text-section font-medium">
              <i className="dot live" />
              Сейчас проходят: {data.inProgressNow.length}
            </h2>
            <span className="text-caption text-muted">{ut("an.draftsAutosaved")}</span>
          </div>
          <div className="row tight">
            {data.inProgressNow.map((p, i) => (
              <span key={i} className="chip static">
                {p.userName ?? ut("an.anon")} · {p.answered} отв.
              </span>
            ))}
          </div>
        </Panel>
      ) : null}

      {data.versions.length > 1 ? (
        <Panel title={ut("an.versionOfSurvey")} hint={ut("an.versionHint")}>
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
          <VersionDiffPanel surveyId={id!} versions={data.versions} />
        </Panel>
      ) : null}

      <div className="tabs">
        {([
          ["overview", ut("an.tabOverview")],
          ["questions", `${ut("an.tabQuestions")} ${data.questions.length}`],
          ["scales", `${ut("an.tabScales")} ${data.scales.length}`],
          ["quality", `${ut("an.tabQuality")} ${data.quality.length || ""}`],
          ["responses", ut("an.tabResponses")],
        ] as [Tab, string][]).map(([v, label]) => (
          <button key={v} className={tab === v ? "active" : ""} onClick={() => setTab(v)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <Stack>
          <Grid min={196} className="mb-4">
            <div className="tile"><div className="label">{ut("an.completed")}</div><div className="value">{data.completed}</div><div className="hint">{ut("an.started")} {data.started}</div></div>
            {/*
              Доходимость была ещё и кольцевой диаграммой на четверть экрана —
              ради двух чисел, которые и так стоят в плитке. Место отдано
              распределениям, где картинка действительно нужна.
            */}
            <div className="tile"><div className="label">{ut("an.completion")}</div><div className="value">{data.completionRate}%</div><div className="hint">{ut("an.abandoned")} {data.abandoned}</div></div>
            <div className="tile"><div className="label">{ut("dash.avgTime")}</div><div className="value">{duration(data.avgDurationMs)}</div></div>
            <div className="tile"><div className="label">{ut("an.median")}</div><div className="value">{duration(data.medianDurationMs)}</div></div>
          </Grid>

          <Chart title={ut("an.dynamics")} hint={ut("dash.timelineHint")}>
            <LineChart area series={[{ label: ut("an.responses"), points: data.timeline.map((t) => ({ x: day(t.date), y: t.count })) }]} />
          </Chart>

          <Chart
            title={ut("an.dropOff")}
            hint={
              dropOffStages.length < data.dropOff.length
                ? `Показаны первый, последний и шаги с потерями — всего вопросов ${data.dropOff.length}`
                : ut("an.dropOffHint")
            }
          >
            <Funnel stages={dropOffStages} />
          </Chart>

          <Panel title={ut("an.exports")} hint={ut("an.exportsHint")}>
            <div className="row">
              {/*
                Цель выгрузки — не формальность: «кто и когда» без «зачем» не
                отвечает ни на один вопрос разбора через год.
              */}
              <label className="field m-0 min-w-[220px]">
                <span>{ut("rep.purpose")}</span>
                <input
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder={ut("rep.purposePlaceholder")}
                />
              </label>
              <label className="field m-0">
                <span>{ut("an.profile")}</span>
                <select value={profile} onChange={(e) => setProfile(e.target.value as never)}>
                  <option value="full">{ut("an.exportFull")}</option>
                  <option value="deidentified">{ut("an.exportDeid")}</option>
                  <option value="anonymous">{ut("an.exportAnon")}</option>
                </select>
              </label>
              <button onClick={() => downloadCsv(data.surveyId)}>{ut("an.dataCsv")}</button>
              <button onClick={() => downloadSpssData(data.surveyId)}>{ut("an.spssMatrix")}</button>
              <button onClick={() => downloadSpssSyntax(data.surveyId)}>{ut("an.spssSyntax")}</button>
              <button onClick={() => downloadCodebook(data.surveyId)}>Codebook</button>
              <button onClick={() => downloadLong(data.surveyId)} title={ut("an.longHint")}>
                Long-format
              </button>
              {/*
                Манифест и скрипты загрузки — рядом с выгрузкой, а не в
                документации: воспроизводимость обеспечивают тем, что забирают
                вместе с данными, а не тем, о чём вспоминают через год.
              */}
              <button onClick={() => downloadManifest(data.surveyId)} title={ut("rep.manifestHint")}>
                {ut("rep.manifest")}
              </button>
              <button onClick={() => downloadScript(data.surveyId, "r")}>R</button>
              <button onClick={() => downloadScript(data.surveyId, "py")}>Python</button>
              <Link className="btn" to={`/surveys/${data.surveyId}/blank`}>{ut("an.blank")}</Link>
              <Link className="btn" to={`/surveys/${data.surveyId}/key`}>{ut("an.keys")}</Link>
            </div>
            <p className="mt-2.5 text-caption text-muted">
              Матрица и синтаксис — пара: положите их рядом и запустите синтаксис, он подставит
              метки переменных и значений. Пропуски закодированы как −99. Деидентифицированный
              профиль заменяет субъектов необратимыми кодами (стабильными между выгрузками —
              лонгитюд склеивается), возраст полосами, дату месяцем; подразделение и звание
              не выгружаются. Каждая выгрузка фиксируется в журнале с SHA-256 датасета.
            </p>
          </Panel>

          <div className="row">
            <Link className="btn" to={`/surveys/${data.surveyId}/norms`}>{ut("an.localNorms")}</Link>
            <Link className="btn" to={`/surveys/${data.surveyId}/access`}>{ut("an.assignments")}</Link>
            <Link className="btn" to={`/constructor/${data.surveyId}`}>{ut("an.edit")}</Link>
            <Link className="btn" to={`/surveys/${data.surveyId}/administer`}>{ut("an.administer")}</Link>
          </div>
        </Stack>
      ) : null}

      {tab === "questions" ? (
        <Stack>
          <Chart title={ut("an.timePerQuestion")} hint={ut("an.spreadNotMean")}>
            <BoxPlot
              boxes={data.questions
                .filter((q) => q.answered > 0)
                .map((q) => boxOf(`В${q.position + 1}`, [q.minDurationMs / 1000, q.medianDurationMs / 1000, q.avgDurationMs / 1000, q.maxDurationMs / 1000]))
                .filter((b): b is NonNullable<typeof b> => !!b)}
            />
          </Chart>

          {heat.length ? (
            <Chart title={ut("an.optionSpread")} hint={ut("an.optionSpreadHint")}>
              <Heatmap
                columns={heat[0]!.options!.map((o) => o.text)}
                rows={heat.map((q) => ({ label: `${q.position + 1}. ${q.title}`, cells: q.options!.map((o) => o.percent) }))}
              />
            </Chart>
          ) : null}

          <Grid min={400}>
            <Chart title={ut("an.doubts")} hint={ut("an.doubtsHint")}>
              <BarList unit="%" items={data.questions.map((q) => ({ label: `${q.position + 1}. ${q.title}`, value: q.changedShare }))} />
            </Chart>
            <Chart title={ut("an.firstChoice")} hint={ut("an.firstChoiceHint")}>
              <BarList
                unit=" с"
                items={data.questions.map((q) => ({
                  label: `${q.position + 1}. ${q.title}`,
                  value: Math.round(q.avgTimeToFirstAnswerMs / 100) / 10,
                }))}
              />
            </Chart>
          </Grid>

          <Panel title={ut("an.perQuestion")} hint={ut("an.perQuestionHint")}>
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>#</th><th>{ut("an.question")}</th><th>{ut("an.type")}</th>
                    <th className="num">{ut("an.shown")}</th><th className="num">{ut("an.answers")}</th><th className="num">{ut("an.skipped")}</th>
                    <th className="num">{ut("an.avgTime")}</th><th className="num">{ut("an.median")}</th><th className="num">{ut("an.spread")}</th>
                    <th className="num">{ut("an.toChoice")}</th><th className="num">{ut("an.edits")}</th><th className="num">{ut("an.changedShare")}</th><th className="num">{ut("an.fast")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.questions.map((q) => (
                    <tr key={q.questionId}>
                      <td className="num">{q.position + 1}</td>
                      <td className="max-w-[320px]">{q.title}</td>
                      <td className="text-muted">{q.type}</td>
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
          </Panel>

          {data.questions.filter((q) => q.numeric).map((q) => (
            <Chart key={q.questionId} title={`${q.position + 1}. ${q.title}`} hint={`среднее ${q.numeric!.average} · медиана ${q.numeric!.median} · диапазон ${q.numeric!.min}–${q.numeric!.max}`}>
                <BarList items={q.numeric!.distribution.map((d) => ({ label: String(d.value), value: d.count }))} />
            </Chart>
          ))}

          {data.questions.filter((q) => q.texts?.length).map((q) => (
            <Panel key={q.questionId} title={`${q.position + 1}. ${q.title}`}>
              <p className="text-caption text-muted">{ut("an.freeText")}: {q.texts!.length}</p>
              <ul className="m-0 pl-[18px] text-muted">
                {q.texts!.slice(0, 40).map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </Panel>
          ))}
        </Stack>
      ) : null}

      {tab === "scales" ? (
        <Stack>
          {data.scales.length > 1 ? (
            <Chart title={ut("an.subscales")} hint={ut("an.subscalesHint")}>
              <BoxPlot
                categorical
                boxes={data.scales.map((s) => boxOf(s.code, [s.min, s.average, s.median, s.max])).filter((b): b is NonNullable<typeof b> => !!b)}
              />
            </Chart>
          ) : null}

          {data.scales.map((s) => (
            <Panel key={s.scaleId} title={s.title} hint={`среднее ${s.average} · медиана ${s.median} · диапазон ${s.min}–${s.max} из ${s.maxPossible}`}>
              <Grid min={400}>
                <div>
                  {s.bands.length === 0 ? (
                    <p className="text-muted">
                      У шкалы нет интерпретационных норм — она используется как служебная
                    </p>
                  ) : (
                  <Donut
                    center={String(s.bands.reduce((a, b) => a + b.count, 0))}
                    centerLabel={ut("an.results")}
                    slices={s.bands.map((b) => ({ label: b.label, value: b.count, color: severityColor[b.severity] }))}
                  />
                  )}
                </div>
                <div>
                  {s.reliability ? (
                    <>
                      <p className="mb-1.5">
                        <strong>{ut("an.alpha")}: {s.reliability.alpha}</strong>{" "}
                        <span className="text-muted">
                          ({s.reliability.alpha >= 0.8 ? ut("an.reliabilityGood") : s.reliability.alpha >= 0.7 ? ut("an.reliabilityOk") : ut("an.reliabilityLow")} согласованность по {s.reliability.itemCount} пунктам)
                        </span>
                      </p>
                      <DivergingBar
                        goodThreshold={0.3}
                        items={s.reliability.items.map((it) => ({ label: it.title, value: it.itemTotalCorrelation }))}
                      />
                      <table className="mt-3">
                        <thead><tr><th>{ut("an.item")}</th><th className="num">{ut("an.link")}</th><th className="num">{ut("an.alphaWithout")}</th><th className="num">{ut("an.variance")}</th></tr></thead>
                        <tbody>
                          {s.reliability.items.map((it) => (
                            <tr key={it.questionId}>
                              <td className="max-w-[300px]">{it.title}</td>
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
                    <p className="text-muted">{ut("an.noReliability")}</p>
                  )}
                </div>
              </Grid>
            </Panel>
          ))}
        </Stack>
      ) : null}

      {tab === "quality" ? (
        <Stack>
          <Panel title={ut("an.carelessTitle")}>
            <p className="text-caption text-muted">
              Помечено {data.quality.length} из {data.completed}. Порог «слишком быстро» — {Math.round(data.tooFastThresholdMs / 1000)} с
              на вопрос. Это флаг для проверки специалистом, а не основание исключать данные.
            </p>
          </Panel>

          {/*
            Карта пунктов стоит выше сводных графиков: небрежное заполнение
            выдаёт себя формой, а не средним, и полоса одинаковых ответов от
            сорокового пункта до конца видна только здесь.
          */}
          <Panel title={ut("qh.title")}>
            <ItemHeatmap surveyId={data.surveyId} />
          </Panel>
          {data.quality.length ? (
            <>
              <Chart title={ut("an.timeVsFast")} hint={ut("an.timeVsFastHint")}>
                <Scatter
                  xLabel={ut("an.durationAxis")}
                  yLabel="% быстрых"
                  xThreshold={(data.questions.length * data.tooFastThresholdMs) / 1000}
                  points={data.quality.map((q) => ({ x: Math.round(q.durationMs / 1000), y: q.tooFastShare, flagged: q.flagged }))}
                />
              </Chart>
              <Panel>
                <div className="scroll-x">
                  <table>
                    <thead><tr><th>{ut("an.respondent")}</th><th className="num">{ut("an.time")}</th><th className="num">{ut("an.fast")}</th><th className="num">{ut("an.streak")}</th><th>{ut("an.reasons")}</th></tr></thead>
                    <tbody>
                      {data.quality.map((q) => (
                        <tr key={q.responseId}>
                          <td>{q.respondent ?? ut("an.anonCap")}</td>
                          <td className="num">{duration(q.durationMs)}</td>
                          <td className="num">{q.tooFastShare}%</td>
                          <td className="num">{q.longestStraightLine}</td>
                          <td className="text-muted">{q.reasons.join("; ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </>
          ) : (
            <p className="text-muted">{ut("an.noSuspicious")}</p>
          )}
        </Stack>
      ) : null}

      {tab === "dif" ? <DifPanel surveyId={data.surveyId} /> : null}
      {tab === "calibration" ? <CalibrationPanel surveyId={data.surveyId} /> : null}
      {tab === "quality" ? <DataQualityPanel surveyId={data.surveyId} /> : null}
      {tab === "responses" ? <Responses surveyId={data.surveyId} /> : null}
      </Stack>
    </Page>
  );
}

function Responses({ surveyId }: { surveyId: string }) {
  const { ut } = useLang();
  const [rows, setRows] = useState<SurveyResponse[] | null>(null);
  const [openConclusion, setOpenConclusion] = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const { run } = useAction();
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

  if (!rows) return <Loading rows={6} />;

  return (
    <Panel title={ut("an.tabResponses")} hint={ut("an.responsesHint")}>
      <div className="scroll-x">
        <table>
          <thead>
            <tr><th>{ut("an.respondent")}</th><th>{ut("an.completed")}</th><th className="num">{ut("an.time")}</th><th>{ut("an.status")}</th><th>{ut("an.scores")}</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
              <tr>
                <td>{r.userName ?? ut("an.anonCap")}</td>
                <td className="text-muted">{r.submittedAt ? r.submittedAt.slice(0, 16).replace("T", " ") : "—"}</td>
                <td className="num">{duration(r.durationMs)}</td>
                <td className="text-muted">{r.status}</td>
                <td>
                  {r.scores.map((s) => (
                    <div key={s.scaleId} className="flex items-center gap-2">
                      <span className="min-w-[150px]">{s.scaleTitle}</span>
                      <span className="text-muted [font-variant-numeric:tabular-nums]">{s.rawScore}/{s.maxScore}</span>
                      {s.band ? <SeverityTag severity={s.band.severity} label={s.band.label} /> : null}
                    </div>
                  ))}
                </td>
                <td>
                  <div className="row tight">
                    <button onClick={() => setOpenConclusion(openConclusion === r.id ? null : r.id)}>
                      {openConclusion === r.id ? ut("an.collapse") : ut("an.conclusion")}
                    </button>
                    <button onClick={() => openReport(r.id)}>{ut("an.print")}</button>
                  </div>
                </td>
              </tr>
              {openConclusion === r.id ? (
                <tr>
                  <td colSpan={6} className="bg-surface-2">
                    <ConclusionEditor responseId={r.id} />
                  </td>
                </tr>
              ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore ? (
        <button className="mt-3" onClick={() => run(loadMore)}>
          {ut("ui.loadMore")}
        </button>
      ) : null}
    </Panel>
  );
}


/**
 * Что изменилось между двумя версиями.
 *
 * Главный ответ здесь один: сопоставимы ли баллы. Перечень правок — лишь
 * обоснование этого ответа, поэтому вывод стоит первым и крупно, а список
 * изменений — под ним и мелко.
 */
function VersionDiffPanel({
  surveyId,
  versions,
}: {
  surveyId: string;
  versions: { id: string; version: number }[];
}) {
  const { ut } = useLang();
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const [a, setA] = useState(sorted[sorted.length - 2]?.id ?? sorted[0]!.id);
  const [b, setB] = useState(sorted[sorted.length - 1]!.id);
  const [diff, setDiff] = useState<VersionDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || a === b) return;
    setDiff(null);
    api.versionDiff(surveyId, a, b).then(setDiff).catch((e) => setError(e.message));
  }, [open, surveyId, a, b]);

  if (!open) {
    return (
      <button className="mt-2.5" onClick={() => setOpen(true)}>
        {ut("an.compareVersions")}
      </button>
    );
  }

  const pick = (value: string, onChange: (v: string) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="max-w-[120px]">
      {sorted.map((v) => (
        <option key={v.id} value={v.id}>
          v{v.version}
        </option>
      ))}
    </select>
  );

  return (
    <div className="mt-3">
      <div className="row tight items-center">
        {pick(a, setA)}
        <span className="text-muted">→</span>
        {pick(b, setB)}
        <Button variant="quiet" onClick={() => setOpen(false)}>{ut("an.collapse")}</Button>
      </div>

      {error ? <p className="text-danger text-small">{error}</p> : null}
      {a === b ? <p className="text-caption text-muted">{ut("an.pickDifferent")}</p> : null}
      {diff ? (
        <>
          <p className="mt-2.5 mb-1">
            {diff.comparable ? (
              <strong className="text-[var(--sev-none-text)]">{ut("an.comparable")}</strong>
            ) : (
              <strong className="text-[var(--sev-moderate)]">
                {ut("an.notComparable")}
              </strong>
            )}
          </p>
          {diff.reasons.length ? (
            <p className="text-caption text-muted">{diff.reasons.join(" · ")}</p>
          ) : (
            <p className="text-caption text-muted">
              {ut("an.noScoringChange")}
            </p>
          )}

          {diff.scales.map((sc) => (
            <div key={sc.code} className="diff-block">
              <strong>{ut("an.scaleWord")} {sc.code}</strong>{" "}
              <span className="text-muted">{ut(DIFF_KIND[sc.kind])}</span>
              {sc.changes.map((ch) => (
                <ChangeLine key={ch.field} change={ch} />
              ))}
            </div>
          ))}

          {diff.questions.map((q, i) => (
            <div key={`${q.position}-${i}`} className="diff-block">
              <strong>{ut("an.item")} {q.position}</strong> <span className="text-muted">{ut(DIFF_KIND[q.kind])}</span>
              <div className="text-muted text-[12.5px]">{q.title}</div>
              {q.changes.map((ch) => (
                <ChangeLine key={ch.field} change={ch} />
              ))}
            </div>
          ))}

          {!diff.scales.length && !diff.questions.length ? (
            <p className="text-muted text-small">{ut("an.sameContent")}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

const DIFF_KIND = {
  added: "an.added",
  removed: "an.removed",
  changed: "an.changed",
} as const;

function ChangeLine({ change }: { change: VersionDiffResult["questions"][number]["changes"][number] }) {
  return (
    <div className="diff-line">
      <span className={change.scoring ? "diff-field scoring" : "diff-field"}>{change.field}</span>
      <span className="diff-before">{change.before ?? "—"}</span>
      <span className="text-muted">→</span>
      <span className="diff-after">{change.after ?? "—"}</span>
    </div>
  );
}
