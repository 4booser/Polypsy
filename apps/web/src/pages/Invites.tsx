import { useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import type { Battery, Invite, SurveyListItem } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { Empty, Loading, Screen, useAction } from "../ui";
import { Panel, Stack } from "../ui/layout";
import { Button, Field, Input, Select } from "../ui/primitives";
import { useLang } from "../lang";
import { usePagedResource, useResource } from "../useResource";
import { listBody, shownNote } from "../ui/paging";
import { inviteState } from "./invites/model";

/** Строка справочника специалистов — ровно то, что нужно выпадающему списку */
type Specialist = { userId: string; fullName: string };

/**
 * Приглашения: вход пациента по ссылке, QR или короткому коду.
 *
 * Токен показывается один раз при создании — в базе только хеш, и «посмотреть
 * ссылку ещё раз» невозможно намеренно. Код остаётся видимым: он для диктовки
 * по телефону и ввода руками, его перехват без пары email+пароль бесполезен.
 */
export default function Invites() {
  const { ut } = useLang();
  const [fresh, setFresh] = useState<{ token: string; code: string } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const { run, busy } = useAction();

  /*
   * Выписанные ссылки — страницами (волна 12): приглашения копятся годами, и
   * список целиком рос вместе с возрастом отделения. Справочники формы
   * грузятся отдельно и по-прежнему разом: их десятки, и страницы им ни к
   * чему.
   */
  const list = usePagedResource<Invite>((cursor) => api.invites(cursor), []);
  const rows = list.items;
  const reload = list.reload;
  const note = rows ? shownNote(ut, rows.length, list.total, list.hasMore) : null;
  const body = listBody(rows, list.error);
  const now = Date.now();

  /*
   * Справочники нужны только форме, и каждый падает молча по отдельности:
   * список выписанных ссылок важнее любого из них, а отказ в правах на
   * методики — их видит не всякий, кто выписывает приглашения — не должен
   * оставлять человека перед пустым экраном вместо его же ссылок.
   */
  const res = useResource(async () => {
    const [batteries, surveys, specialists] = await Promise.all([
      api.batteries().then((b) => b.filter((x) => !x.archived)).catch(() => [] as Battery[]),
      api.surveys().then((r) => r.filter((x) => !x.archivedAt)).catch(() => [] as SurveyListItem[]),
      api.specialists().then((r) => r.items).catch(() => [] as Specialist[]),
    ]);
    return { batteries, surveys, specialists };
  }, []);

  return (
    <Screen res={res}>
      {({ batteries, surveys, specialists }) => (
        <Stack>
          {/*
            Заголовок и дату экрана рисует «Начало смены»: приглашения теперь
            его вкладка, а не отдельный раздел. Кнопка «Выписать» переехала из
            шапки сюда — шапка общая на три вкладки, и действие одной из них в
            ней стояло бы и над двумя другими.
          */}
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setShowForm(true)}>{ut("inv.create")}</Button>
          </div>
          {showForm ? (
            <InviteForm
              batteries={batteries}
              surveys={surveys}
              specialists={specialists}
              onClose={() => setShowForm(false)}
              onCreated={(t) => {
                setFresh(t);
                setShowForm(false);
                reload();
              }}
            />
          ) : null}

          {fresh ? <FreshInvite token={fresh.token} code={fresh.code} onClose={() => setFresh(null)} /> : null}

          {body.body === "failed" || body.body === "loading" ? (
            <Loading error={list.error} onRetry={list.reload} busy={list.loading} />
          ) : null}
          {/*
            Отказ поверх уже показанных ссылок — строкой с «повторити»
            (listBody в ui/paging.ts). Раньше отказ перечитывания после
            «відкликати» или подгрузки «ще» не показывался вовсе: отозванная
            ссылка оставалась в списке живой, а «ще» молча ничего не делало.
          */}
          {body.stale ? (
            <div role="alert" className="flex items-center gap-[10px]">
              <p className="m-0 min-w-0 flex-1 text-caption text-danger">{body.stale}</p>
              <Button variant="quiet" size="sm" onClick={list.reload}>
                {ut("common.retry")}
              </Button>
            </div>
          ) : null}
          {body.body === "empty" && !showForm ? <Empty title={ut("inv.none")} hint={ut("inv.noneHint")} /> : null}

          {note ? <p className="m-0 text-caption text-muted">{note}</p> : null}
          {rows?.length ? (
            <Panel flush>
              <div className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      <th>{ut("inv.code")}</th>
                      <th>{ut("inv.bound")}</th>
                      <th>{ut("ui.unit")}</th>
                      <th className="num">{ut("inv.entries")}</th>
                      <th>{ut("inv.expires")}</th>
                      <th>{ut("inv.createdBy")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((inv) => {
                      const dead = inviteState(inv, now) !== "live";
                      return (
                        <tr key={inv.id} className={dead ? "muted-row" : undefined}>
                          <td className="font-mono font-semibold">{inv.code}</td>
                          {/*
                            Один столбец на обе привязки: набор и методика
                            взаимоисключающи, и два столбца, из которых всегда
                            пуст ровно один, читались бы хуже. Врач стоит
                            второй строкой — он про тот же вопрос «что человек
                            получит, войдя по ссылке».
                          */}
                          <td>
                            {inv.batteryTitle ?? inv.surveyTitle ?? (
                              <span className="text-muted">{ut("inv.noBattery")}</span>
                            )}
                            {inv.specialistName ? (
                              <div className="text-caption text-muted">{inv.specialistName}</div>
                            ) : null}
                          </td>
                          <td className="text-muted">{inv.unit ?? "—"}</td>
                          <td className="num">
                            {inv.usedCount}/{inv.maxUses}
                            {inv.uses.length ? (
                              <div className="text-caption text-muted">{inv.uses.map((u) => u.fullName).join(", ")}</div>
                            ) : null}
                          </td>
                          <td className={dead ? "text-muted" : undefined}>
                            {inv.revokedAt ? `${ut("inf.revoked")} ${day(inv.revokedAt)}` : day(inv.expiresAt)}
                          </td>
                          <td className="text-muted">{inv.createdByName}</td>
                          <td>
                            {!dead ? (
                              <Button
                                disabled={busy}
                                variant="danger"
                                size="sm"
                                onClick={() =>
                                  run(async () => {
                                    await api.revokeInvite(inv.id);
                                    await reload();
                                  }, ut("inv.revoked"))
                                }
                              >
                                {ut("inv.revoke")}
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}
          {list.hasMore ? (
            <div className="flex justify-center">
              <Button variant="ghost" disabled={list.loadingMore} onClick={list.loadMore}>
                {list.loadingMore ? ut("ui.loadingMore") : ut("ui.loadMore")}
              </Button>
            </div>
          ) : null}
        </Stack>
      )}
    </Screen>
  );
}

function InviteForm({
  batteries,
  surveys,
  specialists,
  onClose,
  onCreated,
}: {
  batteries: Battery[];
  surveys: SurveyListItem[];
  specialists: Specialist[];
  onClose: () => void;
  onCreated: (t: { token: string; code: string }) => void;
}) {
  const { ut } = useLang();
  /*
   * Набор ИЛИ методика, и это видно по форме: выбор одного гасит другой.
   * «Набор и ещё одна методика» дало бы назначение, состав которого не виден
   * ни из приглашения, ни из карты, — сервер такое и не примет.
   */
  const [batteryId, setBatteryId] = useState("");
  const [surveyId, setSurveyId] = useState("");
  const [specialistId, setSpecialistId] = useState("");
  const [unit, setUnit] = useState("");
  const [note, setNote] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [ttlDays, setTtlDays] = useState(14);
  const { run, busy } = useAction();

  return (
    <Panel title={ut("inv.new")} actions={<Button variant="quiet" onClick={onClose}>{ut("ui.close")}</Button>}>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        <Field label={ut("inv.batteryOnRegister")} className="sm:col-span-2">
          <Select
            value={batteryId}
            onChange={(e) => {
              setBatteryId(e.target.value);
              if (e.target.value) setSurveyId("");
            }}
          >
            <option value="">{ut("inv.noBatteryHint")}</option>
            {batteries.map((b) => (
              <option key={b.id} value={b.id}>{b.title}</option>
            ))}
          </Select>
        </Field>
        <Field label={ut("inv.surveyOnRegister")} className="sm:col-span-2">
          <Select
            value={surveyId}
            onChange={(e) => {
              setSurveyId(e.target.value);
              if (e.target.value) setBatteryId("");
            }}
          >
            <option value="">{ut("inv.noSurveyHint")}</option>
            {surveys.map((s) => (
              <option key={s.id} value={s.id}>{s.title}</option>
            ))}
          </Select>
        </Field>
        {/*
          Врач, за которым закрепится пришедший. По умолчанию — тот, кто
          выписывает: ссылку под случай выписывают себе. Без этого поля
          человек приходил ничьим, и его надо было потом искать среди
          остальных и закреплять руками.
        */}
        <Field label={ut("inv.specialist")} className="sm:col-span-2">
          <Select value={specialistId} onChange={(e) => setSpecialistId(e.target.value)}>
            <option value="">{ut("inv.specialistMe")}</option>
            {specialists.map((p) => (
              <option key={p.userId} value={p.userId}>{p.fullName}</option>
            ))}
          </Select>
        </Field>
        <Field label={ut("ui.unit")}>
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={ut("inv.unitToAccount")} />
        </Field>
        <Field label={ut("inv.uses")}>
          <Input type="number" min={1} max={500} value={maxUses}
            onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))} />
        </Field>
        <Field label={ut("inv.days")}>
          <Input type="number" min={1} max={365} value={ttlDays}
            onChange={(e) => setTtlDays(Math.max(1, Number(e.target.value) || 1))} />
        </Field>
        <Field label={ut("inv.noteStaffOnly")} className="sm:col-span-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={ut("inv.reasonExample")} />
        </Field>
      </div>
      <p className="mt-3 text-caption text-muted">{ut("inv.groupHint")}</p>
      <div className="mt-3">
        <Button
          disabled={busy}
          variant="primary"
          onClick={() =>
            run(async () => {
              const res = await api.createInvite({
                batteryId: batteryId || null,
                surveyId: surveyId || null,
                specialistId: specialistId || null,
                unit: unit || null,
                note: note || null,
                maxUses,
                ttlDays,
              });
              onCreated({ token: res.token, code: res.code });
            }, ut("inv.created"))
          }
        >
          {ut("inv.createSubmit")}
        </Button>
      </div>
    </Panel>
  );
}

/** Показ ссылки и QR один раз после создания */
function FreshInvite({ token, code, onClose }: { token: string; code: string; onClose: () => void }) {
  const { ut } = useLang();
  const url = `${location.origin}/join/${token}`;
  const { run } = useAction();

  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [url]);

  return (
    <Panel title={ut("inv.ready")} actions={<Button variant="quiet" onClick={onClose}>{ut("f.hide")}</Button>}>
      {/*
        Предупреждение красится акцентом: это ровно тот случай, для
        которого он существует, — ссылку нужно скопировать сейчас, второго
        показа не будет.
      */}
      <p className="text-caption text-accent">{ut("inv.linkWarning")}</p>
      <div className="flex flex-wrap gap-5">
        {/*
          biome-ignore lint/security/noDangerouslySetInnerHtml: SVG кода собирается
          здесь же из ссылки, никакие внешние данные в разметку не попадают
        */}
        <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="min-w-[260px] flex-1">
          <Field label={ut("inv.link")}>
            <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          </Field>
          <Field label={ut("inv.manualCode")} className="mt-2">
            <Input readOnly value={code} className="font-mono text-[18px] font-bold" />
          </Field>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button onClick={() => run(async () => navigator.clipboard.writeText(url), ut("inv.linkCopied"))}>
              {ut("inv.copyLink")}
            </Button>
            <Button onClick={() => run(async () => navigator.clipboard.writeText(code), ut("inv.codeCopied"))}>
              {ut("inv.copyCode")}
            </Button>
            <Button onClick={() => window.print()}>{ut("inv.printQr")}</Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
