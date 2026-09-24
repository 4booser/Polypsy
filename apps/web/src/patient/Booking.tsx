import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { dateTime } from "../format";
import { useAction } from "../ui";
import { Button, Field, Textarea } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { cx } from "../ui/cx";
import { IconStar } from "../ui/glyphs";
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
        {/*
          Размер значку задаёт подпись, а не сам значок.

          Значки кабинета нарисованы без width/height: размер им ставит тот,
          кто их вставляет. Здесь этого не сделали, и svg без размеров в
          потоке разворачивается до ширины колонки — экран записи открывался
          с человечком во весь телефон, и время приёма уезжало под него.
        */}
        <h2 className="mb-2 flex items-center gap-1.5 text-caption uppercase tracking-[var(--tracking-label)] text-faint [&>svg]:size-[15px]">
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
              {p.isLead ? <><IconStar />{" "}</> : null}
              {p.fullName}
            </Choice>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-caption uppercase tracking-[var(--tracking-label)] text-faint [&>svg]:size-[15px]">
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
        {/*
          Подпись через Field, а не заголовок рядом с полем.

          Здесь стоял <h2> с той же надписью и <textarea> под ним: человек
          зрячий связь видел, диктор — нет, и объявлял «поле ввода». Это
          нарушение 4.1.2, а не придирка: у поля не было имени вовсе.

          Заголовок связать с полем нельзя ничем, кроме aria-labelledby, то
          есть двух совпадающих строк в разных местах разметки, — а Field
          оборачивает поле подписью, и связь получается по построению.
          Подсказка ушла под поле: там её ставит Field, и до ошибки тоже.
        */}
        <Field label={ut("pt.reason")} hint={ut("pt.reasonHint")}>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
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
        /* высота не проставлена: кабинет — территория пальца, пол мишени даёт TouchArea */
        "rounded-sm border px-3 text-small",
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        active ? "border-primary bg-surface-3 font-medium" : "border-border bg-surface text-muted",
      )}
    >
      {children}
    </button>
  );
}
