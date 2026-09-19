import { useState } from "react";
import { api } from "../../api";
import { useResource } from "../../useResource";
import { Modal } from "../../ui";
import { Button, Field, Input, Select } from "../../ui/primitives";
import { useLang } from "../../lang";

/**
 * «Призначити групі» — второй значок кадра f17.
 *
 * Групповое назначение на сервере есть: POST /api/patient-groups/:id/surveys
 * разворачивает его в поимённые назначения со своим сроком у каждого, и в
 * карте человека видно, что методика пришла через группу. Экран группы
 * пациентов делает другая волна, поэтому значок не ведёт туда, а открывает
 * окно здесь: группа, срок — и назначить. Одно действие не стоит перехода на
 * другой экран.
 *
 * Права те же, что у поимённой выдачи (assignments.manage), и их проверяет
 * сервер: отказ показывается как есть. Пустая группа — тоже отказ, а не тихий
 * успех: «назначено» при нуле адресатов читалось бы как сделанная работа.
 */
export function AssignGroup({ surveyId, onClose }: { surveyId: string; onClose: () => void }) {
  const { ut } = useLang();
  const groups = useResource(() => api.patientGroups(), []);
  const [groupId, setGroupId] = useState("");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; recipients: number } | null>(null);

  async function assign() {
    const group = groups.data?.find((g) => g.id === groupId);
    if (!group) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.assignSurveyToPatientGroup(group.id, { surveyId, expiresAt: expires || null });
      setDone({ title: group.title, recipients: res.recipients });
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("acc.grantFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={ut("cn.assignGroup")} onClose={onClose}>
      {done ? (
        <div className="flex flex-col gap-[15px]">
          {/* число адресатов — после тире: слово не склоняется по числу */}
          <p className="m-0 text-small text-text">
            {ut("cn.assignedToGroup")} «{done.title}»: {ut("cn.recipients")} — {done.recipients}
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>{ut("bp.close")}</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-[15px]">
          <p className="m-0 text-[13px] text-muted">{ut("cn.assignGroupHint")}</p>
          {groups.data && groups.data.length === 0 ? (
            <p className="m-0 text-small text-text">{ut("cn.noPatientGroups")}</p>
          ) : (
            /* число в скобках — кто получит методику: состав, видимый читателю, а не «сколько в группе» */
            <Field label={ut("cn.patientGroup")} hint={ut("cn.groupCountHint")}>
              <Select value={groupId} onChange={(e) => setGroupId(e.target.value)} disabled={!groups.data}>
                <option value="">{ut("sel.pick")}</option>
                {(groups.data ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title} ({g.memberCount})
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={ut("acc.until")}>
            <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
          {error || groups.error ? <p className="m-0 text-[13px] text-danger">{error ?? groups.error}</p> : null}
          <div className="flex justify-end gap-[14px]">
            <Button variant="ghost" onClick={onClose}>{ut("common.cancel")}</Button>
            <Button onClick={assign} disabled={!groupId || busy}>
              {busy ? ut("co.saving") : ut("acc.grant")}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
