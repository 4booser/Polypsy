import { useEffect, useState } from "react";
import type { PatientGroup, PatientGroupWithCounts, SurveyListItem } from "@quizzy/shared";
import { api, type Patient } from "../../api";
import { useLang } from "../../lang";
import { Loading, Modal } from "../../ui";
import { Button, Field, Input, Select, Textarea } from "../../ui/primitives";
import { useResource } from "../../useResource";

/*
 * Окна раздела «Групи»: завести/переименовать группу, добавить человека,
 * назначить тест, положить выборку в группу.
 *
 * Все четыре — Modal из общего набора, а не свои слои: ловушка фокуса, Esc и
 * возврат фокуса на кнопку-открывашку там уже есть, и четвёртая копия этой
 * логики в проекте была бы ровно тем местом, где она однажды разойдётся.
 *
 * Отказ сервера печатается как есть, а не переписывается: право на
 * назначение (assignments.manage) и на состав группы (patients.read) —
 * разные, и человек должен прочитать, какого именно ему не хватило.
 */

/* ─────────── группа: завести или переименовать ─────────── */

/**
 * Одна форма на два случая. Разница — только в заголовке и в подписи кнопки:
 * поля те же (название и «опис групи (питання до групи)»), и два окна с
 * одинаковым содержимым разошлись бы на первой же правке потолка длины.
 *
 * Цвета вкладки здесь нет, хотя сервер его принимает: на макете вкладки
 * одноцветные, и палитра из пяти кружков была бы элементом, которого на
 * кадре нет.
 */
export function GroupForm({
  group,
  onClose,
  onSaved,
}: {
  /** null — завести новую */
  group: PatientGroup | null;
  onClose: () => void;
  onSaved: (saved: PatientGroup) => void;
}) {
  const { ut } = useLang();
  const [title, setTitle] = useState(group?.title ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const t = title.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      const body = { title: t, description: description.trim() || null };
      const saved = group ? await api.updatePatientGroup(group.id, body) : await api.createPatientGroup(body);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("ui.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={group ? ut("pg.edit") : ut("pg.add")} onClose={onClose}>
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {/* потолки — из patientGroupInputSchema: длиннее сервер вернёт 400, а не обрежет */}
        <Field label={ut("pg.name")}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus required />
        </Field>
        <Field label={ut("pg.descriptionField")}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} maxLength={4000} />
        </Field>
        {error ? <p className="m-0 mt-[15px] text-[13px] text-danger">{error}</p> : null}
        <div className="mt-[15px] flex justify-end gap-[14px]">
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || !title.trim()}>
            {busy ? ut("co.saving") : group ? ut("common.save") : ut("pg.create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ─────────── «Додати пацієнта» ─────────── */

/**
 * Поиск по людям в зоне ответственности и добавление в группу по одному.
 *
 * Источник — GET /api/access/patients: единственный маршрут, который отдаёт
 * всех обследуемых зоны, включая ни разу не тестированных, — а в группу
 * кладут как раз тех, кого только собираются тестировать. Цена: маршрут
 * закрыт правом assignments.manage, а не patients.read, и отдаёт не больше
 * ста человек. Первое печатается отказом сервера, второе — подсказкой
 * «звузьте пошук»; оба названы в api_gaps отчёта.
 *
 * Добавление — по одному, кнопкой у строки, а не галочками с общим «Додати»:
 * специалист ищет конкретного человека по фамилии, находит, добавляет и
 * ищет следующего. Накопить выборку в окне ему негде — поиск её сбросит.
 */
export function AddMemberDialog({
  groupId,
  members,
  onClose,
  onAdded,
}: {
  groupId: string;
  /** Кто уже в группе: у них вместо кнопки — пометка */
  members: ReadonlySet<string>;
  onClose: () => void;
  onAdded: (userId: string) => void;
}) {
  const { ut } = useLang();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* сервер расшифровывает ФИО на каждый запрос — не на каждую букву */
  useEffect(() => {
    const timer = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const found = useResource(() => api.patients({ search: dq || undefined }), [dq]);

  async function add(p: Patient) {
    setBusyId(p.id);
    setError(null);
    try {
      await api.addPatientGroupMember(groupId, p.id);
      setAdded((prev) => new Set(prev).add(p.id));
      onAdded(p.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("ui.actionFailed"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal title={ut("pg.addPatient")} onClose={onClose}>
      <div className="flex flex-col gap-[15px]">
        <Field label={ut("pg.patientSearch")} inline>
          <Input value={q} onChange={(e) => setQ(e.target.value)} autoFocus autoComplete="off" maxLength={120} />
        </Field>
        {found.error ? (
          <Loading error={found.error} onRetry={found.reload} />
        ) : !found.data ? (
          <Loading rows={3} />
        ) : found.data.items.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">{ut("pt.nobodyFound")}</p>
        ) : (
          <ul className="m-0 flex max-h-[50vh] list-none flex-col gap-[6px] overflow-y-auto p-0">
            {found.data.items.map((p) => {
              const inGroup = members.has(p.id) || added.has(p.id);
              return (
                <li key={p.id} className="flex items-center gap-[10px]">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-bold leading-[18px] text-primary">{p.fullName}</div>
                    <div className="truncate text-[13px] leading-[18px] text-muted">
                      {[p.email, p.unit].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  {inGroup ? (
                    <span className="text-[13px] text-muted">{ut("pg.alreadyIn")}</span>
                  ) : (
                    <Button variant="ghost" disabled={busyId !== null} onClick={() => void add(p)}>
                      {busyId === p.id ? ut("co.saving") : ut("pg.addOne")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {found.data?.truncated ? <p className="m-0 text-[13px] text-muted">{ut("pg.truncated")}</p> : null}
        {error ? <p className="m-0 text-[13px] text-danger">{error}</p> : null}
        <div className="flex justify-end">
          <Button onClick={onClose}>{ut("bp.close")}</Button>
        </div>
      </div>
    </Modal>
  );
}

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

  async function assign() {
    if (!surveyId) return;
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
          <Field label={ut("acc.until")}>
            <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
          {error || surveys.error ? (
            <p className="m-0 mt-[15px] text-[13px] text-danger">{error ?? surveys.error}</p>
          ) : null}
          <div className="mt-[15px] flex justify-end gap-[14px]">
            <Button variant="ghost" onClick={onClose}>
              {ut("common.cancel")}
            </Button>
            <Button onClick={() => void assign()} disabled={!surveyId || busy}>
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
