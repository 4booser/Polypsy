import { api } from "../api";
import { Loading } from "../ui";
import { useResource } from "../useResource";
import { useLang } from "../lang";
import { Panel, Stack } from "../ui/layout";
import { SeverityTag } from "../ui/primitives";

// ключи, а не строки: карты живут вне компонента, перевод берётся при отрисовке
const FACTOR_KEY = { sex: "dif.sex", age: "dif.age", lang: "dif.lang" } as const;
const CLASS_KEY = { A: "dif.same", B: "dif.moderate", C: "dif.large" } as const;

/**
 * DIF: работает ли пункт одинаково у людей с ОДИНАКОВЫМ уровнем черты, но
 * разного пола, возраста или языка предъявления.
 *
 * Класс C — не приговор пункту: это указание сесть с формулировкой и решить,
 * различие содержательное («мужчины реже признают слёзы») или переводческое.
 * Автоматически из ключа ничего не выбрасывается.
 */
export function DifPanel({ surveyId }: { surveyId: string }) {
  const { ut } = useLang();
  // через useResource: смена методики не должна оставлять ответ по прежней
  const res = useResource(() => api.dif(surveyId), [surveyId]);
  const { data, error } = res;

  if (error) return <p className="text-danger">{error}</p>;
  if (!data) return <Loading />;

  const flagged = data.scales.flatMap((s) =>
    s.items.flatMap((i) =>
      i.entries
        .filter((e) => e.result && e.result.etsClass !== "A")
        .map((e) => ({ scale: s.code, position: i.position, title: i.title, ...e })),
    ),
  );

  return (
    <Stack>
      <Panel
        title={ut("dif.title")}
        hint={
          <>
            Метод Mantel–Haenszel: сравниваются люди с одинаковым суммарным баллом. Группы меньше{" "}
            {data.minGroup} наблюдений не считаются вовсе; от {data.minGroup} до {data.solidGroup} —
            помечены как предварительные (мягкий критерий значимости). Различие в пункте — повод
            разобрать формулировку, а не выбросить пункт.
          </>
        }
        actions={<span className="text-caption text-muted">выборка {data.sample}</span>}
      >
        {flagged.length === 0 ? (
          <p className="m-0 text-muted">
            {data.scales.length
              ? ut("dif.none")
              : ut("dif.notEnough") + data.minGroup + " прохождений."}
          </p>
        ) : null}
      </Panel>

      {flagged.length ? (
        <Panel title={`${ut("dif.flaggedItems")}: ${flagged.length}`} className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th className="num">№</th>
                <th>{ut("dif.item")}</th>
                <th>{ut("dq.scale")}</th>
                <th>{ut("dif.factor")}</th>
                <th>{ut("dif.groupsN")}</th>
                <th className="num">ΔMH</th>
                <th>{ut("dif.class")}</th>
              </tr>
            </thead>
            <tbody>
              {flagged.map((f, i) => (
                <tr key={i}>
                  <td className="num">{f.position}</td>
                  <td className="max-w-[320px]">{f.title}</td>
                  <td className="text-muted">{f.scale}</td>
                  <td className="text-muted">{ut(FACTOR_KEY[f.factor as keyof typeof FACTOR_KEY])}</td>
                  <td className="text-caption text-muted">
                    {f.reference} ({f.refN}) ↔ {f.focal} ({f.focalN})
                    {f.preliminary ? " · предварительно" : ""}
                  </td>
                  <td className="num">{f.result!.deltaMH}</td>
                  <td>
                    {/*
                      Класс DIF — степень расхождения (B/C), а не факт
                      «есть/нет», поэтому цвет не несёт её один: SeverityTag
                      даёт форму точки и подпись рядом с буквой класса вместо
                      прежней подсказки, видимой только по наведению.
                    */}
                    <SeverityTag level={f.result!.etsClass === "C" ? "severe" : "moderate"}>
                      {f.result!.etsClass} · {ut(CLASS_KEY[f.result!.etsClass as keyof typeof CLASS_KEY])}
                    </SeverityTag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-caption text-muted">
            ΔMH в дельта-единицах ETS: |Δ| &lt; 1 — класс A, 1–1.5 — B, &gt; 1.5 — C. Знак
            показывает, какая группа чаще отвечает по ключу при равном уровне черты.
          </p>
        </Panel>
      ) : null}

      {data.reliability.length ? (
        <Panel
          title={ut("dif.reliabilityByGroup")}
          hint="Альфа Кронбаха отдельно у мужчин и женщин. Расхождение больше 0.10 означает, что шкала измеряет одну группу точнее другой — сравнивать их баллы нужно осторожнее."
          className="overflow-x-auto"
        >
          <table>
            <thead>
              <tr><th>{ut("dq.scale")}</th><th>{ut("dif.group")}</th><th className="num">n</th><th className="num">α</th><th className="num">{ut("dif.gap")}</th></tr>
            </thead>
            <tbody>
              {data.reliability.map((s) =>
                s.groups.map((g, gi) => (
                  <tr key={`${s.code}-${g.group}`}>
                    {gi === 0 ? <td rowSpan={s.groups.length}>{s.code} — {s.title}</td> : null}
                    <td className="text-muted">{g.group}</td>
                    <td className="num">{g.n}</td>
                    <td className="num">{g.alpha ?? "—"}</td>
                    {gi === 0 ? (
                      <td className="num" rowSpan={s.groups.length}>
                        {s.alphaSpread === null ? (
                          "—"
                        ) : s.alphaSpread > 0.1 ? (
                          <SeverityTag level="mild">{s.alphaSpread}</SeverityTag>
                        ) : (
                          s.alphaSpread
                        )}
                      </td>
                    ) : null}
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </Panel>
      ) : null}
    </Stack>
  );
}
