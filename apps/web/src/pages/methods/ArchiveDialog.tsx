import { useState, type ReactNode } from "react";
import { api } from "../../api";
import { useLang } from "../../lang";
import { Modal, useAction } from "../../ui";
import { Ic } from "../../ui/icons";
import { IconTile } from "../../ui/layout";
import { Button, Field, Input } from "../../ui/primitives";
import { Callout } from "../../ui/states";
import { useResource } from "../../useResource";
import { Mi } from "./icons";
import { grantState, splitCode } from "./model";

/*
 * «Зняти з використання» — окно (methods-archive-dialog), потому что шаг
 * обрывает выдачу: методика пропадает из списков, наборов и кабинетов.
 *
 * Что изменится — из настоящих данных: чинные назначения (сколько ещё не
 * прошли), наборы, в которых методика стоит шагом, и собранные прохождения,
 * которые остаются на месте. Ничего не удаляется — «Повернути в роботу» во
 * вкладке «Зняті». Подтверждение — кодом методики (или названием, если кода
 * нет): в списке однотипных методик легко снять соседнюю.
 *
 * Повторы по расписанию и правила аналитики, которые на методику ссылаются,
 * этот экран не перечисляет: сервер не отдаёт их по методике (см. отчёт
 * волны).
 */
export function ArchiveDialog({
  survey,
  onClose,
  onDone,
}: {
  survey: { id: string; title: string; versionNumber?: number | null; responseCount: number };
  onClose: () => void;
  onDone: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [typed, setTyped] = useState("");
  const { code, name } = splitCode(survey.title);
  const word = code ?? survey.title;
  const matches = typed.trim() === word;

  /* оба запроса закрыты правами — отказ значит «не знаем», и строка просто не рисуется */
  const impact = useResource(async () => {
    const [grants, batteries] = await Promise.all([
      api.grants(survey.id).catch(() => null),
      api.batteries().catch(() => null),
    ]);
    return { grants, batteries };
  }, [survey.id]);

  const now = new Date();
  const live = impact.data?.grants?.filter((g) => grantState(g, now) !== "late") ?? null;
  const waiting = live?.filter((g) => !g.completed).length ?? 0;
  const inBatteries = impact.data?.batteries?.filter((b) => !b.archived && b.items.some((i) => i.surveyId === survey.id)) ?? null;

  const rows: { icon: ReactNode; title: string; text: string; n: number }[] = [];
  if (live && live.length) {
    rows.push({
      icon: <Ic.users />,
      title: ut("mc.arGrants"),
      text: waiting ? ut("mc.arGrantsWaiting").replace("{n}", String(waiting)) : ut("mc.arGrantsAllDone"),
      n: live.length,
    });
  }
  if (inBatteries && inBatteries.length) {
    rows.push({
      icon: <Ic.layers />,
      title: ut("mc.arBatteries"),
      text: ut("mc.arBatteriesText").replace("{names}", inBatteries.map((b) => `«${b.title}»`).join(", ")),
      n: inBatteries.length,
    });
  }

  const sub = survey.versionNumber ? `${name}, ${ut("ant.versionN").replace("{n}", String(survey.versionNumber))}` : name;

  return (
    <Modal
      title={ut("mc.arTitle").replace("{code}", word)}
      sub={code ? sub : survey.versionNumber ? ut("ant.versionN").replace("{n}", String(survey.versionNumber)) : undefined}
      icon={<Ic.archive />}
      tone="warn"
      width={580}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            icon={<Ic.archive />}
            disabled={!matches || busy}
            onClick={() =>
              void run(async () => {
                await api.archiveSurvey(survey.id);
                onDone();
              }, ut("cl.archived"))
            }
          >
            {ut("cl.archive")}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {ut("ui.cancel")}
          </Button>
        </>
      }
    >
      <p className="m-0 text-body text-text-2">{ut("mc.arLead")}</p>
      {impact.data === null && !impact.error ? (
        <p className="m-0 mt-3 text-small text-muted">{ut("common.loading")}</p>
      ) : rows.length ? (
        <ul className="m-0 mt-3 list-none p-0">
          {rows.map((r) => (
            <li
              key={r.title}
              className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-2.5 border-t border-divider py-2.5 first:border-t-0 first:pt-1"
            >
              <IconTile icon={r.icon} tone="neutral" size={28} />
              <span className="text-small text-text-2">
                <b className="block text-body font-extrabold text-text">{r.title}</b>
                {r.text}
              </span>
              <span className="text-[15px] font-extrabold leading-7 tabular-nums text-text">{r.n}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 mt-3 text-small text-muted">{ut("mc.arNothingLive")}</p>
      )}
      <div className="mt-3">
        <Callout kind="info" icon={<Mi.archiveRestore />}>
          {ut("mc.arKept").replace("{n}", String(survey.responseCount))}
        </Callout>
      </div>
      <div className="mt-4">
        <Field
          label={ut("mc.arConfirm").replace("{code}", word)}
          hint={matches ? ut("mc.arConfirmOk") : ut("mc.arConfirmHint")}
        >
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
        </Field>
      </div>
    </Modal>
  );
}
