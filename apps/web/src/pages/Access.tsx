import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { dateTime } from "../format";
import { Screen } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button, Field, Input, Select } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";

/** Назначение методики конкретным пациентам */
export default function Access() {
  const { ut } = useLang();
  const { id } = useParams<{ id: string }>();
  const [selected, setSelected] = useState("");
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const res = useResource(
    async () => {
      const [survey, grants, patients] = await Promise.all([
        api.survey(id!),
        api.grants(id!),
        api.patients().then((p) => p.items),
      ]);
      return { survey, grants, patients };
    },
    [id],
    { enabled: !!id },
  );
  const load = async () => res.reload();

  async function grant() {
    if (!id || !selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.grant(id, selected, note.trim() || undefined, expires || null);
      setSelected("");
      setNote("");
      setExpires("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("acc.grantFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen res={res}>
      {({ survey, grants, patients }) => {
        const free = patients.filter((p) => !grants.some((g) => g.userId === p.id));
        return (
          <Page
            title={ut("acc.title")}
            crumbs={<Link to={`/surveys/${survey.id}`}>← {survey.title}</Link>}
            sub={survey.visibility === "restricted" ? ut("acc.visibilityRestricted") : ut("acc.visibilityPublic")}
          >
            <Stack>
              {survey.visibility === "public" ? (
                <Panel>
                  <p className="m-0 text-small">
                    {ut("acc.publicHint")} {ut("acc.restrictHint")}
                  </p>
                </Panel>
              ) : null}

              <Panel title={ut("acc.grantTo")} hint={ut("acc.grantHint")}>
                <div className="flex flex-wrap items-end gap-3">
                  <Field label={ut("acc.patient")} className="min-w-[240px] flex-[2]">
                    <Select value={selected} onChange={(e) => setSelected(e.target.value)}>
                      <option value="">{ut("sel.pick")}</option>
                      {free.map((p) => (
                        <option key={p.id} value={p.id}>{p.fullName} · {p.email}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={ut("acc.comment")} className="min-w-[200px] flex-[2]">
                    <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={ut("acc.commentExample")} />
                  </Field>
                  <Field label={ut("acc.until")} className="min-w-[170px] flex-1">
                    <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
                  </Field>
                  <Button variant="primary" onClick={grant} disabled={!selected || busy}>{ut("acc.grant")}</Button>
                </div>
                {error ? <p className="mt-2 text-caption text-danger">{error}</p> : null}
              </Panel>

              <Panel title={`${ut("acc.granted")} (${grants.length})`} flush>
                {grants.length === 0 ? (
                  <p className="m-0 px-5 pb-5 text-caption text-muted">{ut("acc.nobody")}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table>
                      <thead>
                        <tr><th>{ut("acc.patient")}</th><th>Email</th><th>{ut("acc.grantedBy")}</th><th>{ut("acc.when")}</th><th>{ut("cs.to")}</th><th>{ut("acc.passed")}</th><th>{ut("acc.comment")}</th><th /></tr>
                      </thead>
                      <tbody>
                        {grants.map((g) => (
                          <tr key={g.userId}>
                            <td>{g.fullName}</td>
                            <td className="text-muted">{g.email}</td>
                            <td className="text-muted">{g.grantedByName ?? "—"}</td>
                            <td className="text-muted">{dateTime(g.grantedAt)}</td>
                            <td className="text-muted">{g.expiresAt ? g.expiresAt.slice(0, 10) : ut("acc.forever")}</td>
                            <td>{g.completed ? ut("acc.yes") : ut("acc.no")}</td>
                            <td className="text-muted">{g.note ?? "—"}</td>
                            <td>
                              <Button
                                variant="danger"
                                size="sm"
                                onClick={async () => {
                                  await api.revoke(survey.id, g.userId).catch(() => null);
                                  await load();
                                }}
                              >
                                {ut("inv.revoke")}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </Stack>
          </Page>
        );
      }}
    </Screen>
  );
}
