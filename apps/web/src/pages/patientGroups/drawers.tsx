import { useEffect, useRef, useState } from "react";
import type { PatientGroup } from "@quizzy/shared";
import { api, type Patient } from "../../api";
import { useLang } from "../../lang";
import { Avatar, Drawer, DrawerSection, Loading, useToast } from "../../ui";
import { cx } from "../../ui/cx";
import { SearchField } from "../../ui/filters";
import { Ic } from "../../ui/icons";
import { submitOnCtrlEnter } from "../../ui/keys";
import { Button, Field, Input, Switch, Tag, Textarea } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { Pi } from "./icons";
import { fill } from "./model";

/*
 * Ящики раздела «Групи пацієнтів»: правка группы и добавление людей в группу.
 * Назначение теста группе или выбранным людям — общий ящик
 * (components/AssignDrawer.tsx, choose="test").
 *
 * Действия — в ящике, а не окном и не переходом (KIT.md §2): карточка группы
 * и таблица остаются на месте, Esc закрывает ящик и сохраняет набранное
 * («Чернетку … збережено» с «Повернутися»). Каждый ящик — свой Drawer со
 * своим состоянием: Drawer различает виды только по прямым детям DrawerPane,
 * а форма вида живёт здесь, рядом со своими полями.
 *
 * Отказ сервера печатается как есть: право на назначение (assignments.manage)
 * и на состав группы (patients.read) — разные, и человек должен прочитать,
 * какого именно ему не хватило.
 */

/* потолки — из patientGroupInputSchema: длиннее сервер вернёт 400, а не обрежет */
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;

/* ─────────── правка группы ─────────── */

export interface GroupDraftSource extends Pick<PatientGroup, "id" | "title" | "description"> {
  memberCount: number;
  favourite: boolean;
}

/**
 * «Редагувати групу» — и «Нова група» тем же ящиком: поля одни и те же
 * (название, опис-питання до групи), и два ящика с одинаковым содержимым
 * разошлись бы на первой же правке потолка длины.
 *
 * Предпросмотр вкладки — как группа встанет в ряд вкладок реестра пациентов:
 * название там обрезается, и длинное имя лучше увидеть до сохранения.
 *
 * «Обрана група» — закладка читателя (PUT/DELETE …/favourite), а не поле
 * группы: она ставится отдельным запросом после сохранения. «Веде» здесь нет:
 * владельца группы сменить нельзя (routes/patientGroups.ts, PATCH) — передача
 * списка коллеге означала бы ответственность за чужие назначения.
 */
export function GroupEditDrawer({
  open,
  group,
  neighbours,
  onClose,
  onReturn,
  onSaved,
}: {
  open: boolean;
  /** null — завести новую */
  group: GroupDraftSource | null;
  /** Соседние вкладки для предпросмотра: «Усі» и следующая группа */
  neighbours: { all: number | null; next: { title: string; memberCount: number } | null };
  onClose: () => void;
  onReturn: () => void;
  onSaved: (saved: PatientGroup, favourite: boolean) => void;
}) {
  const { ut } = useLang();
  const toast = useToast();
  const [title, setTitle] = useState(group?.title ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [favourite, setFavourite] = useState(group?.favourite ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* другая группа (или «нова» после сохранения) — форма с её значений; черновик той же группы живёт */
  const sourceKey = group ? `${group.id}|${group.title}|${group.description ?? ""}|${group.favourite}` : "new";
  const lastKey = useRef(sourceKey);
  useEffect(() => {
    if (lastKey.current === sourceKey) return;
    lastKey.current = sourceKey;
    setTitle(group?.title ?? "");
    setDescription(group?.description ?? "");
    setFavourite(group?.favourite ?? false);
    setError(null);
  }, [sourceKey, group]);

  const clean = title.trim();
  const dirty =
    clean !== (group?.title ?? "") ||
    description.trim() !== (group?.description ?? "") ||
    favourite !== (group?.favourite ?? false);

  async function save() {
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = { title: clean, description: description.trim() || null };
      const saved = group ? await api.updatePatientGroup(group.id, body) : await api.createPatientGroup(body);
      if (favourite !== (group?.favourite ?? false)) await api.favouritePatientGroup(saved.id, favourite);
      toast(fill(ut("pg2.savedToast"), { name: saved.title }), "ok");
      onSaved(saved, favourite);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("ui.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const name = clean || ut("pg2.newGroup");
  return (
    <Drawer
      open={open}
      onClose={onClose}
      onReturn={onReturn}
      title={group ? ut("pg.edit") : ut("pg2.newGroup")}
      sub={group ? fill(ut("pg2.editSub"), { name: group.title, n: group.memberCount }) : ut("pg2.newSub")}
      icon={group ? <Pi.pencilLine /> : <Ic.plus />}
      dirty={dirty}
      draftName={ut("pg2.editDraft")}
      kbd={group ? "E" : "N"}
      note={group ? ut("pg2.editNote") : ut("pg2.newNote")}
      noteIcon={<Pi.usersRound />}
      footer={
        <>
          <Button variant="primary" disabled={busy || !clean} onClick={() => void save()}>
            {busy ? ut("co.saving") : group ? ut("common.save") : ut("pg.create")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <div onKeyDown={(e) => submitOnCtrlEnter(e, () => void save())}>
        <DrawerSection>
          <Field label={ut("pg.name")} hint={ut("pg2.nameHint")}>
            <Input
              data-autofocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={TITLE_MAX}
              required
              suffix={`${title.length} / ${TITLE_MAX}`}
            />
          </Field>
          <Field
            label={ut("pg2.descriptionLabel")}
            hint={`${ut("pg2.descriptionHint")} ${description.length} / ${DESCRIPTION_MAX}`}
          >
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} maxLength={DESCRIPTION_MAX} />
          </Field>
          {error ? (
            <p role="alert" className="m-0 text-small font-semibold text-risk-ink">
              {error}
            </p>
          ) : null}
        </DrawerSection>
        <DrawerSection title={ut("pg2.tabPreview")}>
          {/* предпросмотр — картинка, а не вкладки: нажимать в нём нечего */}
          <div aria-hidden className="flex items-center gap-1 overflow-hidden rounded-[12px] bg-sunk p-2.5">
            <PreviewTab label={ut("pg.allTab")} count={neighbours.all} />
            <PreviewTab label={name} count={group?.memberCount ?? 0} on />
            {neighbours.next ? <PreviewTab label={neighbours.next.title} count={neighbours.next.memberCount} /> : null}
          </div>
        </DrawerSection>
        <DrawerSection title={ut("pg2.other")}>
          <Switch checked={favourite} onChange={setFavourite} label={ut("pg.favorite")} sub={ut("pg2.favouriteSub")} />
        </DrawerSection>
      </div>
    </Drawer>
  );
}

function PreviewTab({ label, count, on }: { label: string; count: number | null; on?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-[9px] px-2.5 text-[13px] font-bold",
        on ? "max-w-[220px] bg-panel text-violet-ink shadow-tile" : "max-w-[160px] text-text-2",
      )}
    >
      <span className="truncate">{label}</span>
      {count !== null ? (
        <span className="inline-grid h-5 min-w-5 place-items-center rounded-[10px] bg-sunk-2 px-1.5 text-[11.5px] tabular-nums text-text-2">
          {count}
        </span>
      ) : null}
    </span>
  );
}

/* ─────────── додати пацієнта ─────────── */

/**
 * «Додати пацієнта» — поиск по людям зоны и добавление по одному.
 *
 * Источник — GET /api/access/patients: единственный маршрут, который отдаёт
 * всех обследуемых зоны, включая ни разу не тестированных, — а в группу
 * кладут как раз тех, кого только собираются тестировать. Маршрут закрыт
 * правом assignments.manage и отдаёт не больше ста человек: первое печатается
 * отказом сервера, второе — подсказкой «звузьте пошук».
 *
 * Добавление — кнопкой у строки: специалист ищет конкретного человека по
 * фамилии, добавляет и ищет следующего. Накопить выборку негде — поиск её
 * сбросит.
 */
export function AddMembersDrawer({
  open,
  groupId,
  groupTitle,
  members,
  onAdded,
  onClose,
}: {
  open: boolean;
  groupId: string;
  groupTitle: string;
  /** Кто уже в группе: у них вместо кнопки — пометка */
  members: ReadonlySet<string>;
  onAdded: (userId: string) => void;
  onClose: () => void;
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

  const found = useResource(() => api.patients({ search: dq || undefined }), [dq], { enabled: open });

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
    <Drawer
      open={open}
      onClose={onClose}
      title={ut("pg.addPatient")}
      sub={groupTitle}
      icon={<Pi.userPlus />}
      note={added.size ? fill(ut("pg2.addedN"), { n: added.size }) : ut("pg2.addNote")}
      noteIcon={<Pi.usersRound />}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {ut("bp.close")}
        </Button>
      }
    >
      <DrawerSection>
        <SearchField value={q} onChange={setQ} placeholder={ut("pg.patientSearch")} width={0} className="w-full" />
        {found.error ? (
          <Loading error={found.error} onRetry={found.reload} bare />
        ) : !found.data ? (
          open ? <Loading rows={4} bare /> : null
        ) : found.data.items.length === 0 ? (
          <p className="m-0 mt-3 text-small text-muted">{ut("pt.nobodyFound")}</p>
        ) : (
          <ul className="m-0 mt-2.5 flex list-none flex-col p-0">
            {found.data.items.map((p) => {
              const inGroup = members.has(p.id) || added.has(p.id);
              return (
                <li key={p.id} className="flex min-h-[52px] items-center gap-2.5 border-b border-divider py-1.5 last:border-b-0">
                  <Avatar name={p.fullName} size={34} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body font-bold text-text">{p.fullName}</div>
                    <div className="truncate text-caption text-muted">{p.unit ?? p.email}</div>
                  </div>
                  {inGroup ? (
                    <Tag tone="good" icon={<Ic.check />}>
                      {ut("pg.alreadyIn")}
                    </Tag>
                  ) : (
                    <Button size="xs" disabled={busyId !== null} onClick={() => void add(p)} icon={<Ic.plus />}>
                      {busyId === p.id ? ut("co.saving") : ut("pg.addOne")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {found.data?.truncated ? <p className="m-0 mt-2 text-small text-muted">{ut("pg.truncated")}</p> : null}
        {error ? (
          <p role="alert" className="m-0 mt-2 text-small font-semibold text-risk-ink">
            {error}
          </p>
        ) : null}
      </DrawerSection>
    </Drawer>
  );
}
