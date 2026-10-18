import { useState } from "react";
import type { PatientGroupWithCounts, SurveyListItem } from "@quizzy/shared";
import { api } from "../../api";
import { useLang } from "../../lang";
import { Modal } from "../../ui";
import { Button, Field, Input, Select } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { pastDeadline, today } from "../../components/deadline";

/*
 * Окна, которые раздел «Групи» отдаёт другим экранам: назначить тест (список
 * пациентов, карточка пациента) и положить выборку в группу (список
 * пациентов, «Добір людей», карточка группы). Свои действия группы —
 * правка, назначение группе, добавление людей — живут в ящиках (drawers.tsx).
 *
 * Оба окна — Modal из общего набора, а не свои слои: ловушка фокуса, Esc и
 * возврат фокуса на кнопку-открывашку там уже есть.
 *
 * Отказ сервера печатается как есть, а не переписывается: право на
 * назначение (assignments.manage) и на состав группы (patients.read) —
 * разные, и человек должен прочитать, какого именно ему не хватило.
 */

/* ─────────── назначить тест ─────────── */

/**
 * Выбор теста и срока; само назначение делает вызывающий экран.
 *
 * Окно одно на два адресата — группу целиком (POST /api/patient-groups/:id/
 * surveys) и выборку людей поимённо (POST /api/access/surveys/:id/grants на
 * каждого), — поэтому оно не знает, кому назначает: получает `onAssign` и
 * печатает то, что тот вернул. Иначе было бы два окна с одним селектом.
 *
 * В списке — только опубликованные и не снятые: черновик назначить нельзя,
 * сервер откажет, и предлагать его значило бы обещать отказ.
 */
export function AssignSurveyDialog({
  title,
  onAssign,
  onClose,
}: {
  title: string;
  /** Назначить; возвращает строку итога для показа («адресатів — 8») */
  onAssign: (surveyId: string, expiresAt: string | null) => Promise<string>;
  onClose: () => void;
}) {
  const { ut } = useLang();
  const surveys = useResource(() => api.surveys(), []);
  const [surveyId, setSurveyId] = useState("");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const usable = (surveys.data ?? []).filter((s: SurveyListItem) => s.status === "published" && !s.archivedAt);
  /* срок в прошлом не отправляется: доступ истёк бы раньше, чем человек о нём узнал (components/deadline.ts) */
  const expiresInPast = pastDeadline(expires, today());

  async function assign() {
    if (!surveyId || expiresInPast) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await onAssign(surveyId, expires || null));
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("acc.grantFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      {done ? (
        <div className="flex flex-col gap-[15px]">
          <p className="m-0 text-small text-text">{done}</p>
          <div className="flex justify-end">
            <Button onClick={onClose}>{ut("bp.close")}</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          <Field label={ut("pg.test")}>
            <Select value={surveyId} onChange={(e) => setSurveyId(e.target.value)} disabled={!surveys.data}>
              <option value="">{ut("sel.pick")}</option>
              {usable.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={ut("acc.until")} error={expiresInPast ? ut("uit.form.pastDeadline") : undefined}>
            <Input type="date" value={expires} min={today()} onChange={(e) => setExpires(e.target.value)} />
          </Field>
          {error || surveys.error ? (
            <p className="m-0 mt-[15px] text-[13px] text-danger">{error ?? surveys.error}</p>
          ) : null}
          <div className="mt-[15px] flex justify-end gap-[14px]">
            <Button variant="ghost" onClick={onClose}>
              {ut("common.cancel")}
            </Button>
            <Button onClick={() => void assign()} disabled={!surveyId || busy || expiresInPast}>
              {busy ? ut("co.saving") : ut("acc.grant")}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ─────────── положить выборку в группу ─────────── */

/**
 * «Додати до групи» для выбранных на списке пациентов: селект группы и одна
 * кнопка. Добавляет по одному запросу на человека — маршрута «пачкой» нет
 * (api_gaps), а сервер повторное добавление читает как «уже там», так что
 * пересечение выборки с составом группы не даёт ошибок.
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
