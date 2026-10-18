import { useState } from "react";
import { api } from "../../api";
import { useResource } from "../../useResource";
import { Callout, Drawer, DrawerSection } from "../../ui";
import { Button, ErrorText, Field, Input, Select } from "../../ui/primitives";
import { useLang } from "../../lang";
import { pastDeadline, today } from "../../components/deadline";
import { CnIc } from "./icons";

/**
 * «Призначити групі» — ящик, а не окно: назначение — действие, и экран
 * конструктора под ним остаётся на месте.
 *
 * Групповое назначение на сервере есть: POST /api/patient-groups/:id/surveys
 * разворачивает его в поимённые назначения со своим сроком у каждого, и в
 * карте человека видно, что методика пришла через группу. Права те же, что у
 * поимённой выдачи (assignments.manage), и их проверяет сервер: отказ
 * показывается как есть. Пустая группа — тоже отказ, а не тихий успех:
 * «назначено» при нуле адресатов читалось бы как сделанная работа.
 */
export function AssignGroup({
  surveyId,
  open,
  onClose,
  sub,
}: {
  surveyId: string;
  open: boolean;
  onClose: () => void;
  /** Подпись под заголовком: название методики */
  sub?: string;
}) {
  const { ut } = useLang();
  const groups = useResource(() => api.patientGroups(), [], { enabled: open });
  const [groupId, setGroupId] = useState("");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; recipients: number } | null>(null);
  /* срок в прошлом не отправляется: доступ всей группы истёк бы сразу (components/deadline.ts) */
  const expiresInPast = pastDeadline(expires, today());

  async function assign() {
    const group = groups.data?.find((g) => g.id === groupId);
    if (!group || expiresInPast) return;
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

  const close = () => {
    onClose();
    /* следующее открытие — с чистого листа, а не с прошлым «призначено» */
    setDone(null);
    setError(null);
  };

  return (
    <Drawer
      open={open}
      onClose={close}
      title={ut("cn.assignGroup")}
      sub={sub}
      icon={<CnIc.userPlus size={18} />}
      footer={
        done ? (
          <Button variant="primary" onClick={close}>
            {ut("bp.close")}
          </Button>
        ) : (
          <>
            <Button variant="primary" onClick={assign} disabled={!groupId || busy || expiresInPast}>
              {busy ? ut("co.saving") : ut("acc.grant")}
            </Button>
            <Button onClick={close}>{ut("common.cancel")}</Button>
          </>
        )
      }
    >
      <DrawerSection>
        {done ? (
          /* число адресатов — после тире: слово не склоняется по числу */
          <Callout kind="good" role="status" title={`${ut("cn.assignedToGroup")} «${done.title}»`}>
            {ut("cn.recipients")} — {done.recipients}
          </Callout>
        ) : (
          <>
            <p className="m-0 mb-3 text-small text-text-2">{ut("cn.assignGroupHint")}</p>
            {groups.data && groups.data.length === 0 ? (
              <p className="m-0 mb-3 text-small text-text">{ut("cn.noPatientGroups")}</p>
            ) : (
              /* число в скобках — кто получит методику: состав, видимый читателю, а не «сколько в группе» */
              <Field label={ut("cn.patientGroup")} hint={ut("cn.groupCountHint")}>
                <Select data-autofocus value={groupId} onChange={(e) => setGroupId(e.target.value)} disabled={!groups.data}>
                  <option value="">{ut("sel.pick")}</option>
                  {(groups.data ?? []).map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title} ({g.memberCount})
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label={ut("acc.until")} error={expiresInPast ? ut("uit.form.pastDeadline") : undefined}>
              <Input type="date" value={expires} min={today()} onChange={(e) => setExpires(e.target.value)} />
            </Field>
            {error || groups.error ? <ErrorText>{error ?? groups.error}</ErrorText> : null}
          </>
        )}
      </DrawerSection>
    </Drawer>
  );
}
