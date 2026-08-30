import { useState } from "react";
import type { InformantRole, SurveyListItem } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { useAction } from "../ui";
import { Panel } from "../ui/layout";
import { Button, Input, Select } from "../ui/primitives";

/**
 * Взгляд со стороны.
 *
 * В военной психодиагностике расхождение между самоотчётом и наблюдением
 * командира — самостоятельный сигнал, а не помеха. Поэтому здесь показывается
 * не «ещё одно прохождение», а именно пара чисел и разница между ними.
 *
 * Имя информанта не спрашивается и не хранится: оценка командира не должна
 * превращаться в личное дело того, кто её дал.
 */
const ROLE_KEY = {
  commander: "inf.role.commander",
  peer: "inf.role.peer",
  family: "inf.role.family",
  clinician: "inf.role.clinician",
} as const;

export function Informants({ userId }: { userId: string }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const requests = useResource(() => api.informants(userId), [userId]);
  const compare = useResource(() => api.informantCompare(userId), [userId]);
  const forms = useResource(
    () => api.surveys().then((rows) => rows.filter((s) => s.administration === "informant")),
    [],
  );

  const [adding, setAdding] = useState(false);
  const [surveyId, setSurveyId] = useState("");
  const [role, setRole] = useState<InformantRole>("commander");
  const [fresh, setFresh] = useState<string | null>(null);

  const available: SurveyListItem[] = forms.data ?? [];
  const rows = requests.data ?? [];
  const perspectives = compare.data ?? [];

  return (
    <Panel
      title={ut("inf.title")}
      hint={ut("inf.sub")}
      actions={
        <Button disabled={!available.length} onClick={() => setAdding((v) => !v)}>
          {adding ? ut("common.cancel") : ut("inf.ask")}
        </Button>
      }
    >
      {adding ? (
        <div className="row tight mb-2.5">
          <Select value={surveyId} onChange={(e) => setSurveyId(e.target.value)}>
            <option value="">—</option>
            {available.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </Select>
          <Select value={role} onChange={(e) => setRole(e.target.value as InformantRole)}>
            {(Object.keys(ROLE_KEY) as InformantRole[]).map((r) => (
              <option key={r} value={r}>
                {ut(ROLE_KEY[r])}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            disabled={busy || !surveyId}
            onClick={() =>
              void run(async () => {
                const made = await api.askInformant(userId, surveyId, role);
                setFresh(`${location.origin}/informant/${made.token}`);
                setAdding(false);
                requests.reload();
              })
            }
          >
            {ut("inf.ask")}
          </Button>
        </div>
      ) : null}

      {fresh ? (
        /*
         * Ссылка показывается один раз: в базе только отпечаток. Поэтому она
         * не прячется в подсказку, а лежит в поле, откуда её видно и можно
         * скопировать целиком.
         */
        <div className="row tight mb-2.5">
          <Input readOnly value={fresh} onFocus={(e) => e.currentTarget.select()} />
          <Button onClick={() => void navigator.clipboard?.writeText(fresh)}>⧉</Button>
          <span className="text-caption text-muted">{ut("inf.link")}</span>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="m-0 text-muted">{ut("inf.nobody")}</p>
      ) : (
        <ul className="inf-list">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="badge">{ut(ROLE_KEY[r.role])}</span>
              <span>{r.surveyTitle}</span>
              <span className="text-muted">
                {r.revokedAt
                  ? ut("inf.revoked")
                  : r.usedAt
                    ? `${ut("inf.answered")} ${day(r.usedAt)}`
                    : `${ut("inf.waiting")} · ${day(r.expiresAt)}`}
              </span>
              {!r.usedAt && !r.revokedAt ? (
                <Button
                  variant="quiet"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.revokeInformant(r.id);
                      requests.reload();
                    })
                  }
                >
                  {ut("inf.revoke")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {perspectives.map((p) => (
        <div key={p.requestId} className="nested mt-3">
          <div className="row tight">
            <strong>{ut(ROLE_KEY[p.role])}</strong>
            <span className="text-muted">{p.at ? day(p.at) : ""}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>{ut("sum.scale")}</th>
                <th className="num">{ut("inf.self")}</th>
                <th className="num">{ut("inf.side")}</th>
                <th className="num">{ut("inf.gap")}</th>
              </tr>
            </thead>
            <tbody>
              {p.scales.map((s) => (
                <tr key={s.code}>
                  <td>{s.title}</td>
                  <td className="num">{s.self ?? "—"}</td>
                  <td className="num">{s.informant}</td>
                  <td className="num">
                    {/*
                      Прочерк, а не ноль: ноль означал бы «человек оценил себя
                      на ноль», а он просто не отвечал на эту шкалу.
                    */}
                    {s.gap === null ? (
                      <span className="text-muted" title={ut("inf.noSelf")}>—</span>
                    ) : (
                      <strong>{s.gap > 0 ? `+${s.gap}` : s.gap}</strong>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </Panel>
  );
}
