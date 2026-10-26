import { useState } from "react";
import type { PatientGroupWithCounts } from "@quizzy/shared";
import { useLang } from "../../lang";
import { Modal } from "../../ui";
import { Button, Field, Select } from "../../ui/primitives";

/*
 * Окно, которое раздел «Групи» отдаёт другим экранам: положить выборку в
 * группу («Добір людей», карточка группы). Свои действия группы — правка,
 * назначение группе, добавление людей — живут в ящиках (drawers.tsx);
 * назначить методику человеку из карточки — общий ящик назначения
 * (components/AssignDrawer.tsx).
 *
 * Окно — Modal из общего набора, а не свой слой: ловушка фокуса, Esc и
 * возврат фокуса на кнопку-открывашку там уже есть.
 *
 * Отказ сервера печатается как есть, а не переписывается: право на
 * назначение (assignments.manage) и на состав группы (patients.read) —
 * разные, и человек должен прочитать, какого именно ему не хватило.
 */

/* ─────────── положить выборку в группу ─────────── */

/**
 * «Додати до групи» для выбранных: селект группы и одна кнопка. Что именно
 * отправить, решает вызывающий экран (`onPick`); сервер повторное добавление
 * читает как «уже там», так что пересечение выборки с составом группы не
 * даёт ошибок.
 */
export function PickGroupDialog({
  groups,
  count,
  onPick,
  onClose,
}: {
  groups: PatientGroupWithCounts[];
  /** Сколько человек в выборке — чтобы кнопка говорила, что сделает */
  count: number;
  onPick: (groupId: string) => Promise<void>;
  onClose: () => void;
}) {
  const { ut } = useLang();
  const [groupId, setGroupId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick() {
    if (!groupId) return;
    setBusy(true);
    setError(null);
    try {
      await onPick(groupId);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("ui.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={ut("pg.addToGroup")} onClose={onClose}>
      <div className="flex flex-col">
        {groups.length === 0 ? (
          <p className="m-0 text-small text-text">{ut("cn.noPatientGroups")}</p>
        ) : (
          <Field label={ut("cn.patientGroup")}>
            <Select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">{ut("sel.pick")}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title} ({g.memberCount})
                </option>
              ))}
            </Select>
          </Field>
        )}
        {error ? <p className="m-0 mt-[15px] text-[13px] text-danger">{error}</p> : null}
        <div className="mt-[15px] flex justify-end gap-[14px]">
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
          <Button onClick={() => void pick()} disabled={!groupId || busy}>
            {busy ? ut("co.saving") : `${ut("pg.addToGroup")} · ${count}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
