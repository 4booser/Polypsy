import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { dateTime } from "../format";
import { useAction } from "../ui";
import { Button } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { cx } from "../ui/cx";
import { IconClock, IconPerson } from "./icons";

/**
 * Запись на приём в три шага: к кому, когда, с чем.
 *
 * Специалист выбирается первым и необязателен: «любой свободный» стоит
 * первым в списке, потому что человеку, который записывается впервые, имя
 * специалиста ничего не говорит, а требование выбрать останавливает.
 *
 * Причина обращения — последняя и необязательная. Заставлять формулировать
 * проблему до встречи неверно: половина не запишется вовсе, а вторая
 * половина напишет «не знаю». Но кто написал — тому специалист успеет
 * подготовиться, и ради этого поле стоит.
 */
export default function PatientBooking() {
  const { ut } = useLang();
  const navigate = useNavigate();
  const { run, busy } = useAction();

  const [specialistId, setSpecialistId] = useState<string | null>(null);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const specialists = useResource(() => api.specialists(), []);
  const slots = useResource(
    () => api.freeSlots(specialistId ? { specialistId } : {}),
    [specialistId],
  );

  const people = specialists.data?.items ?? [];
  const times = (slots.data?.items ?? []).slice(0, 40);

  return (
    <div className="flex flex-col gap-5 p-4">
      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-caption uppercase tracking-[var(--tracking-label)] text-faint">
          <IconPerson /> {ut("pt.pickSpecialist")}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Choice active={specialistId === null} onClick={() => setSpecialistId(null)}>
            {ut("pt.anySpecialist")}
          </Choice>
          {people.map((p) => (
            <Choice
              key={p.userId}
              active={specialistId === p.userId}
              onClick={() => {
                setSpecialistId(p.userId);
                setSlotId(null);
              }}
            >
              {/* свой специалист помечен: преемственность важнее, чем ближайшее время */}
              {p.isLead ? "★ " : ""}
              {p.fullName}
            </Choice>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-caption uppercase tracking-[var(--tracking-label)] text-faint">
          <IconClock /> {ut("pt.pickTime")}
        </h2>
        {times.length === 0 ? (
          <p className="text-muted">{ut("pt.noSlots")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {times.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={slotId === s.id}
                onClick={() => setSlotId(s.id)}
                className={cx(
                  "flex min-h-[52px] items-center justify-between rounded-sm border px-4 py-3 text-left text-small",
                  "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                  slotId === s.id
                    ? "border-primary bg-surface-3 font-medium"
                    : "border-border bg-surface",
                )}
              >
                <span>{dateTime(s.startsAt)}</span>
                <span className="text-caption text-muted">{s.specialistName}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-caption uppercase tracking-[var(--tracking-label)] text-faint">
          {ut("pt.reason")}
        </h2>
        <p className="mb-2 text-caption text-muted">{ut("pt.reasonHint")}</p>
        <textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-sm border border-border bg-surface p-3 text-small"
        />
      </section>

      <Button
        variant="primary"
        disabled={!slotId || busy}
        onClick={() =>
          run(async () => {
            await api.book({ slotId: slotId!, reason: reason.trim() || null });
            navigate("/me");
          }, ut("pt.booked"))
        }
      >
        {ut("pt.bookNow")}
      </Button>
    </div>
  );
}

function Choice({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "min-h-[44px] rounded-sm border px-3 text-small",
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        active ? "border-primary bg-surface-3 font-medium" : "border-border bg-surface text-muted",
      )}
    >
      {children}
    </button>
  );
}
