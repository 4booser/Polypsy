import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { Empty, Loading, Screen, useAction } from "../ui";
import { Page, Panel, Grid, Stack } from "../ui/layout";
import { Button } from "../ui/primitives";
import { useResource } from "../useResource";
import { useLang } from "../lang";

// ключи: карта вне компонента, перевод берётся при отрисовке
const SEX_KEY = { male: "nm.men", female: "nm.women", all: "nm.wholeSample" } as const;

/**
 * Локальные нормы: пересчёт M/SD по фактической выборке учреждения.
 *
 * Нормы пособий сняты с мирной популяции; на военной выборке они плывут.
 * Публикация создаёт новую версию методики — уже собранные прохождения
 * остаются на прежних нормах своей версии, а происхождение каждой нормы
 * («пособие» или «локальная выборка, N=…») печатается в подсказках и SPSS.
 */
type NormsTab = "table" | "curves";

export default function Norms() {
  const { ut } = useLang();
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<NormsTab>("table");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { run } = useAction();

  const res = useResource(() => api.normCandidates(id!), [id], { enabled: !!id });
  const reload = res.reload;

  return (
    <Screen res={res}>
      {(data) => {
        const publishableCodes = data.scales
          .filter((s) => s.candidate.some((g) => g.sex !== null && g.publishable))
          .map((s) => s.code);
        return (
    <Page
      title={ut("nm.title")}
      crumbs={<Link to={`/surveys/${id}`}>← Аналитика методики</Link>}
      sub="M и SD по фактической выборке учреждения против норм пособия"
      actions={
        picked.size ? (
          <Button
            variant="primary"
            onClick={() =>
              run(async () => {
                await api.applyNorms(id!, [...picked]);
                setPicked(new Set());
                reload();
              }, ut("nm.published"))
            }
          >
            Опубликовать для {picked.size} шкал
          </Button>
        ) : undefined
      }
    >
      <div className="tabs max-w-[420px]">
        <button className={tab === "table" ? "active" : ""} onClick={() => setTab("table")}>
          Пособие против выборки
        </button>
        <button className={tab === "curves" ? "active" : ""} onClick={() => setTab("curves")}>
          Возрастные кривые
        </button>
      </div>

      {tab === "curves" ? <AgeCurves surveyId={id!} /> : null}

      {tab === "table" && !data.scales.length ? (
        <Empty
          title={ut("nm.nothing")}
          hint={ut("nm.nothingHint")}
        />
      ) : null}

      {tab === "table" ? <Stack>{data.scales.map((s) => {
        const canPublish = publishableCodes.includes(s.code);
        return (
          <Panel
            key={s.code}
            title={`${s.code} — ${s.title}`}
            actions={
              canPublish ? (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={picked.has(s.code)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(s.code);
                      else next.delete(s.code);
                      setPicked(next);
                    }}
                  />
                  перевести на локальные
                </label>
              ) : (
                <span className="text-caption text-muted">выборка меньше {data.minGroup} — публиковать рано</span>
              )
            }
          >
            <table>
              <thead>
                <tr>
                  <th>{ut("nm.group")}</th>
                  <th className="num">{ut("nm.currentNorm")}</th>
                  <th>{ut("nm.source")}</th>
                  <th className="num">{ut("nm.candidate")}</th>
                  <th className="num">N</th>
                  <th className="num">{ut("nm.shift")}</th>
                </tr>
              </thead>
              <tbody>
                {(["male", "female"] as const).map((sex) => {
                  const cur = s.current.find((n) => n.sex === sex);
                  const cand = s.candidate.find((g) => g.sex === sex);
                  if (!cur && !cand) return null;
                  // средний T выборки под текущей нормой: 50 + 10(Mк − Mтек)/SDтек
                  const shift =
                    cur && cand && cur.sd > 0
                      ? Math.round((50 + (10 * (cand.mean - cur.mean)) / cur.sd - 50) * 10) / 10
                      : null;
                  return (
                    <tr key={sex}>
                      <td>{ut(SEX_KEY[sex as keyof typeof SEX_KEY])}</td>
                      <td className="num">{cur ? `${cur.mean} / ${cur.sd}` : "—"}</td>
                      <td className="text-muted text-[12px]">{cur?.source ?? "—"}</td>
                      <td className="num">
                        {cand ? `${cand.mean} / ${cand.sd}` : <span className="text-muted">мало данных</span>}
                      </td>
                      <td className="num">{cand?.n ?? "—"}</td>
                      <td className="num">
                        {shift === null ? (
                          "—"
                        ) : (
                          <span style={{ color: Math.abs(shift) >= 5 ? "var(--sev-mild)" : undefined }}>
                            {shift > 0 ? "+" : ""}
                            {shift} T
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-3 text-caption text-muted">
              «Сдвиг среднего T» — насколько средний человек выборки отклоняется от нормы пособия.
              Больше ±5 T — выборка систематически отличается от нормировочной популяции, и
              локальные нормы имеют смысл.
            </p>
          </Panel>
        );
      })}
      <Panel>
        <p className="text-caption text-muted">
          Публикация создаёт новую версию методики: собранные прохождения остаются на прежних
          нормах, происхождение каждой нормы фиксируется («локальная выборка, N=…»).
          <Link to={`/surveys/${id}/key`} className="ml-1.5">{ut("nm.checkKeys")}</Link>
        </p>
      </Panel>
      </Stack> : null}
    </Page>
        );
      }}
    </Screen>
  );
}

/**
 * Возрастные перцентильные кривые (5.3): формат карт роста — P10…P90 против
 * возраста, отдельно по полу. Ширина скользящего окна показывается честно:
 * там, где данных мало, окно шире, и кривая грубее.
 */
function AgeCurves({ surveyId }: { surveyId: string }) {
  const { ut } = useLang();
  const { data, error } = useResource(() => api.ageCurves(surveyId), [surveyId]);

  if (error) return <p className="text-danger text-small">{error}</p>;
  if (!data) return <Loading />;
  if (!data.scales.length) {
    return (
      <Empty
        title={ut("nm.noCurves")}
        hint={`Для кривой нужно минимум ${data.minWindow} прохождений одного пола с указанным возрастом. Накопится — появятся.`}
      />
    );
  }

  return (
    <Stack>
      {data.scales.map((scale) => (
        <Panel
          key={scale.code}
          title={`${scale.code} — ${scale.title}`}
          actions={<span className="text-caption text-muted">{scale.normalization === "tscore" ? "T-баллы" : scale.normalization}</span>}
        >
          <Grid min={400}>
            {scale.bySex.filter((b) => b.enough).map((b) => (
              <div key={b.sex}>
                <p className="text-caption text-muted">
                  {b.sex === "male" ? ut("nm.menCap") : ut("nm.womenCap")} · окно ±{b.points[0]?.halfWidth ?? "?"} лет
                </p>
                <CurveTable points={b.points} />
              </div>
            ))}
          </Grid>
        </Panel>
      ))}
    </Stack>
  );
}

function CurveTable({ points }: { points: { age: number; n: number; halfWidth: number; percentiles: { q: number; value: number }[] }[] }) {
  const { ut } = useLang();
  // показываем опорные возрасты: сплошная таблица по каждому году нечитаема
  const step = Math.max(1, Math.floor(points.length / 8));
  const shown = points.filter((_, i) => i % step === 0);
  return (
    <table>
      <thead>
        <tr>
          <th className="num">{ut("nm.age")}</th>
          {shown[0]?.percentiles.map((p) => (
            <th key={p.q} className="num">P{Math.round(p.q * 100)}</th>
          ))}
          <th className="num">n</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((pt) => (
          <tr key={pt.age}>
            <td className="num">{pt.age}</td>
            {pt.percentiles.map((p) => (
              <td key={p.q} className="num">{p.value}</td>
            ))}
            <td className="num text-muted">{pt.n}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
