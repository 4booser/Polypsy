import { useRef, useState, type KeyboardEvent } from "react";
import { api, type Patient } from "../../api";
import { usePatientSearch } from "../../components/PatientPicker";
import { Avatar, DrawerSection, Loading, useAction, type DrawerPaneProps } from "../../ui";
import { Ic } from "../../ui/icons";
import { Button, Field, Input, Segmented } from "../../ui/primitives";
import { useLang } from "../../lang";
import { initialsName } from "../patients/model";
import { moveAndReload } from "../visitModel";
import { useDayLabel } from "./Exceptions";
import { G } from "./glyphs";
import { clock, wallOf } from "./model";
import { MoveSlots } from "./MoveSlots";

/** Окно, в которое записывают: из календаря недели или из списка свободных */
export interface BookSlot {
  id: string;
  startsAt: string;
  endsAt: string;
}

/** Сколько найденных показывать: дальше — «звузьте пошук», листать список в ящике незачем */
const SHOWN = 8;

/**
 * Запись пациента с экрана расписания.
 *
 * Прежде записать человека можно было только из его карточки — с экрана,
 * где неделя видна целиком, специалист уходил искать карточку и терял
 * окно, на которое смотрел. Теперь окно выбирается в календаре (нажатие на
 * свободное) или в ящике, человек — поиском по зоне (usePatientSearch, тот же
 * поиск, что в выборе пациента у методик), а записывает та же POST
 * /api/clinic/appointments, что в карточке: за другого — с правом вести
 * приёмы (экран без права ни кнопки, ни свободных окон не показывает).
 *
 * Вид приёма (первичный или повторный) сервер определяет по истории
 * человека сам — выбирать его здесь нечего. Набранное живёт, пока экран
 * открыт: закрытый ящик скажет «чернетку збережено», а нажатие на другое
 * окно поменяет только время.
 *
 * Хук отдаёт свойства вида ящика (DrawerPane) вместе с телом: Drawer узнаёт
 * виды по типу ребёнка, поэтому сам <DrawerPane> стоит на экране.
 */
export function useBookingPane({
  specialistId,
  tz,
  onBooked,
  onDone,
}: {
  specialistId: string;
  tz: string;
  /** Запись ушла (или отказала) — неделю перечитать: окно заняли или заняли раньше нас */
  onBooked: () => void;
  /** Записано или «Скасувати» — закрыть ящик */
  onDone: () => void;
}): { pane: DrawerPaneProps; start: (slot: BookSlot | null) => void } {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const dayLabel = useDayLabel();
  const [slot, setSlot] = useState<BookSlot | null>(null);
  /* выбор окна раскрыт: окна не было или его меняют */
  const [picking, setPicking] = useState(true);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [mode, setMode] = useState<"onsite" | "remote">("onsite");
  const [reason, setReason] = useState("");
  /* окна перечитываются после отказа: занятое окно не должно стоять выбранным */
  const [slotsRev, setSlotsRev] = useState(0);

  const start = (s: BookSlot | null) => {
    setSlot(s);
    setPicking(!s);
  };
  const when = (s: BookSlot) => {
    const a = wallOf(s.startsAt, tz);
    const b = wallOf(s.endsAt, tz);
    return `${dayLabel(a.date)}, ${clock(a.minutes)}–${clock(b.minutes)}`;
  };

  const book = () => {
    if (!slot || !patient) return;
    const target = { slot, patient };
    void run(
      async () => {
        try {
          await moveAndReload(
            () => api.book({ slotId: target.slot.id, patientId: target.patient.id, mode, reason: reason.trim() || null }),
            onBooked,
          );
        } catch (e) {
          /* окно, скорее всего, уже занято: выбор окна — заново, по свежему списку */
          setSlot(null);
          setPicking(true);
          setSlotsRev((n) => n + 1);
          throw e;
        }
        setSlot(null);
        setPicking(true);
        setPatient(null);
        setMode("onsite");
        setReason("");
        onDone();
      },
      ut("v2s.bookedToast").replace("{name}", initialsName(target.patient.fullName)).replace("{when}", when(target.slot)),
    );
  };

  const body = (
    <>
      <DrawerSection title={ut("ref.patient")}>
        <PatientChooser value={patient} onChange={setPatient} />
      </DrawerSection>
      <DrawerSection title={ut("v2s.moveTime")} sub={picking ? ut("v2s.moveNewSub") : undefined}>
        {slot && !picking ? (
          <div className="flex items-center gap-3 rounded-[12px] bg-sunk px-3 py-2.5">
            <G.calendarCheck size={18} className="text-violet-ink" />
            <b className="min-w-0 flex-1 font-extrabold tabular-nums text-text">{when(slot)}</b>
            <Button size="xs" variant="ghost" onClick={() => setPicking(true)}>
              {ut("v2s.change")}
            </Button>
          </div>
        ) : (
          <MoveSlots key={slotsRev} specialistId={specialistId} tz={tz} picked={slot} onPick={setSlot} />
        )}
      </DrawerSection>
      <DrawerSection title={ut("card.mode")}>
        <Segmented
          wide
          label={ut("card.mode")}
          value={mode}
          onChange={setMode}
          items={[
            { key: "onsite", label: ut("card.onsite") },
            { key: "remote", label: ut("card.online") },
          ]}
        />
      </DrawerSection>
      <DrawerSection>
        <Field label={ut("v2s.bookReason")} optional>
          <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </DrawerSection>
    </>
  );

  return {
    start,
    pane: {
      mode: "book",
      title: ut("v2s.book"),
      sub: slot ? when(slot) : undefined,
      icon: <G.calendarPlus />,
      dirty: patient !== null || reason.trim() !== "",
      draftName: ut("v2s.draftBook"),
      note:
        patient && slot
          ? `${initialsName(patient.fullName)}, ${when(slot)}, ${ut(mode === "remote" ? "card.online" : "card.onsite")}`
          : undefined,
      noteIcon: <Ic.calendar />,
      footer: (
        <>
          <Button variant="primary" icon={<G.calendarCheck />} disabled={busy || !slot || !patient} onClick={book}>
            {ut("card.book")}
          </Button>
          <Button onClick={onDone}>{ut("visit.cancel")}</Button>
        </>
      ),
      children: body,
    },
  };
}

/**
 * Кого записать: поиск по зоне и найденные строками; выбранный — плашкой с
 * «Змінити». Одно поле, а не поиск и отдельный выпадающий список: набрал —
 * выбрал. Стрелка вниз из поля переводит на найденных, стрелки ходят по ним.
 */
export function PatientChooser({ value, onChange }: { value: Patient | null; onChange: (p: Patient | null) => void }) {
  const { ut } = useLang();
  const [query, setQuery] = useState("");
  const found = usePatientSearch(query, { onlyTyped: true });
  const listRef = useRef<HTMLUListElement>(null);

  if (value) {
    return (
      <div className="flex items-center gap-3 rounded-[12px] bg-sunk px-3 py-2.5" data-patient-chosen="">
        <Avatar name={value.fullName} size={34} />
        <span className="min-w-0 flex-1">
          <b className="block truncate font-extrabold text-text">{value.fullName}</b>
          {value.unit ? <small className="block truncate text-caption text-muted">{value.unit}</small> : null}
        </span>
        <Button size="xs" variant="ghost" onClick={() => onChange(null)}>
          {ut("v2s.change")}
        </Button>
      </div>
    );
  }

  const items = found.data?.items.slice(0, SHOWN) ?? [];
  const more = !!found.data && (found.data.truncated || found.data.items.length > SHOWN);
  const options = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
  const step = (e: KeyboardEvent<HTMLElement>, from: number) => {
    const all = options();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = all[Math.min(Math.max(from + (e.key === "ArrowDown" ? 1 : -1), 0), all.length - 1)];
      next?.focus();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* подпись — заголовок раздела «Пацієнт»; в поле она подсказкой */}
      <Field label={ut("pg.patientSearch")} inline>
        <Input
          data-autofocus
          value={query}
          autoComplete="off"
          maxLength={120}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") step(e, -1);
            /* один найденный — Enter берёт его сразу */
            if (e.key === "Enter" && items.length === 1) {
              e.preventDefault();
              onChange(items[0]!);
            }
          }}
        />
      </Field>
      {!query.trim() ? null : found.error ? (
        <p className="m-0 text-caption text-danger">{found.error}</p>
      ) : !found.data ? (
        <Loading rows={2} bare />
      ) : items.length ? (
        <ul ref={listRef} aria-label={ut("pg.patientSearch")} className="m-0 flex list-none flex-col gap-1 p-0">
          {items.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onChange(p)}
                onKeyDown={(e) => step(e, i)}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] border-0 bg-transparent px-2.5 py-2 text-left hover:bg-sunk focus-visible:bg-violet-tint focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
              >
                <Avatar name={p.fullName} size={28} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-bold text-text">{p.fullName}</span>
                {p.unit ? <span className="max-w-[40%] shrink-0 truncate text-caption text-muted">{p.unit}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-small text-muted">{ut("pt.nobodyFound")}</p>
      )}
      {more ? <p className="m-0 text-caption text-muted">{ut("pg.truncated")}</p> : null}
    </div>
  );
}
