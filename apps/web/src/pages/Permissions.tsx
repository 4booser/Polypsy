import { useState } from "react";
import type { LocalizedText, PermissionEffectKind } from "@quizzy/shared";
import { ROLE_LADDER } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { Loading, Search, useAction } from "../ui";
import { Grid, Page, Panel, Stack } from "../ui/layout";
import { Button, Field, Input, SectionLabel, Select, Tag } from "../ui/primitives";

/**
 * Экран прав.
 *
 * Отвечает на два вопроса и в этом порядке: что человек может сейчас и
 * почему именно это. Итог без происхождения бесполезен — по нему нельзя
 * решить, что менять: непонятно, пришло право от роли или от исключения, и
 * что снимать.
 *
 * Роли слева, человек справа. Так потому, что роль настраивают редко, а
 * права конкретному человеку смотрят часто — и обычно приходят на этот экран
 * именно за вторым.
 *
 * Роль собирается не из кодов прав, а из последствий. Двадцать девять
 * галочек с подписями вроде «console.use» — это список того, что система
 * умеет проверять, а не того, что человек получит; собирая по нему роль
 * заведующего, приходится держать в голове, какие разделы меню откроет
 * каждая. Поэтому рядом с каждой галочкой написано, что она открывает, а над
 * набором — сводка «что роль даёт» тремя блоками: разделы меню, аналитика,
 * действия. Разделены они не для красоты: первое — вопрос ориентации,
 * второе — доступ к цифрам по всему учреждению, третье — ответственность, и
 * в общем списке «Раздел «Методики»» весит столько же, сколько «Выгрузка
 * прохождений с именами».
 */

const KINDS = ["screen", "analysis", "action"] as const;

interface CataloguePermission {
  code: string;
  title: LocalizedText;
  effect: { kind: PermissionEffectKind; opens: LocalizedText };
}

interface CatalogueGroup {
  code: string;
  title: LocalizedText;
  permissions: CataloguePermission[];
}

interface RoleItem {
  id: string;
  code: string;
  title: LocalizedText;
  isBuiltin: boolean;
  permissions: string[];
  people: number;
  /** вправе ли я выдать эту роль — считает сервер по лестнице должностей */
  assignable: boolean;
}

export default function Permissions() {
  const { ut, lang } = useLang();
  const { run, busy } = useAction();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  /* открыт ровно один конструктор: шесть развёрнутых наборов сразу — это стена */
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newTitle, setNewTitle] = useState("");

  const catalogue = useResource(() => api.permissionCatalogue(), []);
  const rolesRes = useResource(() => api.permissionRoles(), []);
  const staff = useResource(() => api.assignableStaff(), []);
  const active = useResource(() => api.activeExceptions(), []);
  const card = useResource(() => api.userPermissions(picked!), [picked], { enabled: !!picked });

  /* язык оболочки, с откатом: у методик перевод бывает неполным, у справочника прав — нет,
     но одна и та же функция ходит по обоим */
  const t = (v: LocalizedText): string => v[lang] ?? v.uk ?? v.ru ?? "";

  if (catalogue.error) return <p className="text-danger">{catalogue.error}</p>;
  if (!catalogue.data || !rolesRes.data) return <Loading rows={6} />;

  const groups = catalogue.data.groups;
  /* плоский указатель: право по коду — чтобы список не обходился заново на каждую строку */
  const index = new Map<string, CataloguePermission>();
  for (const g of groups) for (const p of g.permissions) index.set(p.code, p);
  const titleOf = (code: string): string => (index.has(code) ? t(index.get(code)!.title) : code);

  /* сервер уже отдал только тех, кого этот человек вправе назначать — здесь остался поиск */
  const people = (staff.data ?? []).filter((u) =>
    `${u.fullName} ${u.email}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <Page title={ut("perm.title")} sub={ut("perm.sub")}>
      <Grid min={420}>
        <Stack>
          <Panel
            title={ut("perm.roles")}
            hint={ut("perm.builtinHint")}
            actions={
              <Button size="sm" onClick={() => setCreating((v) => !v)}>
                {ut("perm.newRole")}
              </Button>
            }
          >
            {creating ? (
              /*
                Новая роль заводится пустой: набор прав отмечают уже в ней.
                Так меньше шагов до понятного состояния — роль сразу видна в
                списке рядом с остальными, и её набор правится тем же способом,
                что и у прочих, а не отдельной формой, которую надо помнить.
              */
              <div className="mb-4 flex flex-col gap-3 rounded-md bg-surface-2 p-4">
                <Field label={ut("perm.roleTitle")}>
                  <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
                </Field>
                <Field label={ut("perm.roleCode")} hint={ut("perm.roleCodeHint")}>
                  <Input
                    value={newCode}
                    onChange={(e) => setNewCode(e.target.value.replace(/[^a-z0-9_-]/g, ""))}
                  />
                </Field>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    disabled={busy || newCode.length < 2 || newTitle.trim().length < 2}
                    onClick={() =>
                      void run(async () => {
                        await api.createRole({
                          code: newCode,
                          title: { uk: newTitle.trim(), ru: newTitle.trim() },
                          permissions: [],
                        });
                        setCreating(false);
                        setNewCode("");
                        setNewTitle("");
                        rolesRes.reload();
                      })
                    }
                  >
                    {ut("perm.newRole")}
                  </Button>
                  <Button variant="quiet" onClick={() => setCreating(false)}>
                    {ut("common.cancel")}
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-4">
              {rolesRes.data.map((role) => (
                <RoleRow
                  key={role.id}
                  role={role}
                  groups={groups}
                  index={index}
                  open={editing === role.id}
                  onToggle={() => setEditing(editing === role.id ? null : role.id)}
                  busy={busy}
                  onSave={(permissions) =>
                    void run(async () => {
                      await api.setRolePermissions(role.id, permissions);
                      rolesRes.reload();
                    }, ut("perm.roleSaved"))
                  }
                />
              ))}
            </div>
          </Panel>

          <Chain roles={rolesRes.data} />

          <Panel title={ut("perm.activeAll")} flush>
            {(active.data ?? []).length === 0 ? (
              <p className="m-0 px-5 pb-5 text-caption text-muted">{ut("perm.noExceptions")}</p>
            ) : (
              <div className="flex flex-col">
                {(active.data ?? []).map((e) => (
                  <div key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-hairline px-5 py-2.5">
                    <button
                      type="button"
                      className="min-h-0 border-0 bg-transparent p-0 text-small font-medium text-primary"
                      onClick={() => setPicked(e.userId)}
                    >
                      {e.userName}
                    </button>
                    <Tag tone={e.mode === "grant" ? "primary" : "danger"}>
                      {e.mode === "grant" ? ut("perm.grant") : ut("perm.revoke")}
                    </Tag>
                    <span className="text-small">{titleOf(e.permission)}</span>
                    <span className="w-full text-caption text-muted">
                      {e.reason}
                      {" · "}
                      <Until expiresAt={e.expiresAt} />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </Stack>

        <Stack>
          <Panel
            title={ut("perm.person")}
            actions={<Search value={query} onChange={setQuery} placeholder={ut("ui.search")} />}
            flush
          >
            <div className="max-h-[260px] overflow-y-auto">
              {people.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setPicked(u.id)}
                  className={`flex w-full items-center justify-between gap-3 border-t border-hairline px-5 py-2 text-left text-small ${
                    picked === u.id ? "bg-surface-2 font-medium" : "hover:bg-surface-2"
                  }`}
                >
                  <span className="truncate">{u.fullName}</span>
                  <span className="shrink-0 text-caption text-muted">{u.email}</span>
                </button>
              ))}
            </div>
          </Panel>

          {!picked ? (
            <p className="text-caption text-muted">{ut("perm.pickPerson")}</p>
          ) : card.loading ? (
            <Loading rows={4} />
          ) : card.data ? (
            <PersonCard
              card={card.data}
              roles={rolesRes.data}
              groups={groups}
              index={index}
              exceptionable={catalogue.data.exceptionable}
              busy={busy}
              onChanged={() => {
                card.reload();
                active.reload();
                rolesRes.reload();
              }}
              run={run}
            />
          ) : null}
        </Stack>
      </Grid>
    </Page>
  );
}

/**
 * Что набор прав открывает на деле.
 *
 * Тремя блоками, а не одним списком: разделы меню, аналитика и действия —
 * три разных вопроса, и в общем перечне они читаются как равнозначные
 * строчки. Блок, в котором ничего нет, не печатается вовсе: пустой заголовок
 * «Аналитика и выгрузки» выглядит как недогрузившийся, а не как «ничего не
 * откроется».
 */
function Gives({
  permissions,
  index,
}: {
  permissions: string[];
  index: Map<string, CataloguePermission>;
}) {
  const { ut, lang } = useLang();
  const chosen = permissions.map((c) => index.get(c)).filter((p): p is CataloguePermission => !!p);

  if (!chosen.length) return <p className="m-0 text-caption text-muted">{ut("perm.givesNothing")}</p>;

  return (
    <div className="flex flex-col gap-2.5">
      {KINDS.map((kind) => {
        const here = chosen.filter((p) => p.effect.kind === kind);
        if (!here.length) return null;
        return (
          <div key={kind}>
            <SectionLabel className="mb-1">{ut(`perm.kind.${kind}`)}</SectionLabel>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {here.map((p) => (
                <li key={p.code} className="text-caption leading-normal text-text">
                  {p.effect.opens[lang] ?? p.effect.opens.uk}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Цепочка назначения — на экране, потому что её не видно из списка ролей.
 *
 * Список ролей плоский, и старшинство из него не читается никак: «Главный
 * врач» и «Специалист» стоят в нём рядом, отличаясь только числом галочек.
 * Отдельный блок объясняет, кто кого назначает, и заодно говорит главное —
 * что правило держится сервером. Написано это прямо, чтобы никто не пытался
 * «просто убрать кнопку» и не считал, что тем самым что-то закрыл.
 */
function Chain({ roles }: { roles: RoleItem[] }) {
  const { ut, lang } = useLang();
  const byCode = new Map(roles.map((r) => [r.code, r]));
  /* сверху вниз: назначающий стоит перед тем, кого он назначает */
  const steps = [ut("perm.superadminTitle")].concat(
    [...ROLE_LADDER].reverse().map((code) => byCode.get(code)?.title[lang] ?? code),
  );

  return (
    <Panel title={ut("perm.chain")} hint={ut("perm.chainNote")}>
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {steps.map((title, at) => (
          <li key={`${at}-${title}`} className="flex items-baseline gap-2 text-small">
            <span aria-hidden className="text-caption text-muted" style={{ paddingLeft: at * 14 }}>
              {at === 0 ? "" : "└"}
            </span>
            <span>{title}</span>
          </li>
        ))}
      </ol>
      {/* почему роли учреждения в цепочку не входят — иначе метка «вне цепочки» выглядит поломкой */}
      <p className="m-0 mt-2 text-caption leading-normal text-muted">{ut("perm.outsideChainHint")}</p>
    </Panel>
  );
}

/** Срок исключения словами: до какого числа и сколько осталось */
function Until({ expiresAt }: { expiresAt: string | null }) {
  const { ut } = useLang();
  if (!expiresAt) return <>{ut("perm.forever")}</>;

  /*
   * Остаток днями, а не только дата. «До 14 марта» требует посмотреть на
   * календарь и вычесть, а разбирают исключения обычно бегло: важно не
   * число, а «это ещё надолго или уже вчера».
   */
  const left = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  return (
    <>
      {ut("perm.until")} {day(expiresAt)}
      {" · "}
      {left <= 1 ? ut("perm.lastDay") : `${left} ${ut("perm.daysLeft")}`}
    </>
  );
}

/**
 * Набор прав одной роли.
 *
 * Свёрнута по умолчанию: ролей в учреждении пять-шесть, и развёрнутые сразу
 * все они дают несколько экранов галочек, среди которых не найти нужную. В
 * свёрнутом виде роль показывает то, за чем на неё смотрят чаще всего:
 * сколько людей на ней и стоит ли она в цепочке должностей.
 */
function RoleRow({
  role,
  groups,
  index,
  open,
  onToggle,
  busy,
  onSave,
}: {
  role: RoleItem;
  groups: CatalogueGroup[];
  index: Map<string, CataloguePermission>;
  open: boolean;
  onToggle: () => void;
  busy: boolean;
  onSave: (permissions: string[]) => void;
}) {
  const { ut, lang } = useLang();
  const [draft, setDraft] = useState<string[] | null>(null);
  const chosen = draft ?? role.permissions;
  const dirty = draft !== null && [...draft].sort().join() !== [...role.permissions].sort().join();
  const inChain = (ROLE_LADDER as readonly string[]).includes(role.code);

  const toggle = (code: string) =>
    setDraft(chosen.includes(code) ? chosen.filter((c) => c !== code) : [...chosen, code]);

  return (
    <div className="border-b border-hairline pb-4 last:border-0 last:pb-0">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <strong className="text-small font-medium">{role.title[lang]}</strong>
        {role.isBuiltin ? <Tag>{ut("perm.builtin")}</Tag> : null}
        {inChain ? null : <Tag tone="attention">{ut("perm.outsideChain")}</Tag>}
        <span className="text-caption text-muted">
          {role.people} {ut("perm.people")}
          {" · "}
          {chosen.length} {ut("perm.chosen")}
        </span>
        <Button size="sm" variant="quiet" className="ml-auto" onClick={onToggle}>
          {open ? ut("perm.collapse") : ut("perm.configure")}
        </Button>
      </div>

      {open ? (
        <>
          <div className="mb-3 rounded-md bg-surface-2 p-3">
            <SectionLabel className="mb-1.5">{ut("perm.roleGives")}</SectionLabel>
            <Gives permissions={chosen} index={index} />
          </div>

          {groups.map((g) => {
            const here = g.permissions.filter((p) => chosen.includes(p.code)).length;
            return (
              <div key={g.code} className="mb-3">
                <SectionLabel className="mb-1">
                  {g.title[lang]} · {here} {ut("common.of")} {g.permissions.length}
                </SectionLabel>
                <div className="flex flex-col gap-1.5">
                  {g.permissions.map((p) => (
                    <label key={p.code} className="flex cursor-pointer items-start gap-2.5">
                      <input
                        type="checkbox"
                        className="mt-1 w-auto min-h-0"
                        checked={chosen.includes(p.code)}
                        disabled={role.isBuiltin}
                        onChange={() => toggle(p.code)}
                      />
                      <span className="flex flex-col">
                        <span className="text-small text-text">{p.title[lang]}</span>
                        {/* что галочка открывает: по названию права этого не видно */}
                        <span className="text-caption leading-normal text-muted">
                          {p.effect.opens[lang] ?? p.effect.opens.uk}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}

          {role.isBuiltin ? null : (
            <Button variant="primary" size="sm" disabled={!dirty || busy} onClick={() => onSave(chosen)}>
              {ut("perm.saveRole")}
            </Button>
          )}
        </>
      ) : null}
    </div>
  );
}

/**
 * Что может конкретный человек — и откуда это взялось.
 *
 * Сначала итог, потом происхождение. Порядок обратный тому, в каком это
 * устроено внутри, и он правильный: пришли сюда узнать, может ли человек
 * подписывать заключения, а не изучать модель прав.
 *
 * Отдельными строками показано то, чем итог отличается от ролей: что выдано
 * сверх них и что отнято вопреки им. Без этого по итогу нельзя решить, что
 * менять: снимать роль или отзывать исключение — разные действия, и второе
 * касается одного человека, а первое всех, кто на этой роли. Отнятое к тому
 * же не видно в итоге вовсе — там его просто нет, — а спрашивают чаще всего
 * именно про него: «почему он не может подписать».
 */
function PersonCard({
  card,
  roles,
  groups,
  index,
  exceptionable,
  busy,
  onChanged,
  run,
}: {
  card: {
    userId: string;
    fullName: string;
    role: string;
    readOnly: boolean;
    roles: { roleId: string; code: string; title: LocalizedText; isBuiltin: boolean }[];
    exceptions: {
      id: string;
      permission: string;
      mode: "grant" | "revoke";
      reason: string;
      grantedAt: string;
      expiresAt: string | null;
      revokedAt: string | null;
    }[];
    effective: string[];
  };
  roles: RoleItem[];
  groups: CatalogueGroup[];
  index: Map<string, CataloguePermission>;
  exceptionable: string[];
  busy: boolean;
  onChanged: () => void;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
}) {
  const { ut, lang } = useLang();
  const [adding, setAdding] = useState<string | null>(null);
  const [mode, setMode] = useState<"grant" | "revoke">("grant");
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("");

  const titleOf = (code: string): string => index.get(code)?.title[lang] ?? code;
  const opensOf = (code: string): string =>
    index.get(code)?.effect.opens[lang] ?? index.get(code)?.effect.opens.uk ?? code;

  const isSuper = card.role === "superadmin";
  const live = card.exceptions.filter(
    (e) => !e.revokedAt && (!e.expiresAt || new Date(e.expiresAt) > new Date()),
  );

  /*
   * Что даёт роль — отдельно от итога. Разница между этими двумя списками и
   * есть работа исключений: что добавлено сверх роли и что отнято вопреки
   * ей. Показать надо обе стороны: отнятое не видно в итоге вовсе, а именно
   * оно чаще всего и оказывается неожиданностью.
   */
  const mine = new Set(card.roles.map((r) => r.roleId));
  const fromRoles = new Set(roles.filter((r) => mine.has(r.id)).flatMap((r) => r.permissions));
  const byException = card.effective.filter((p) => !fromRoles.has(p));
  const takenAway = [...fromRoles].filter((p) => !card.effective.includes(p));

  return (
    <Stack>
      <Panel title={card.fullName}>
        {isSuper ? (
          /*
            Суперадмину права не раздают: он обходит справочник целиком.
            Сказать это прямо дешевле, чем показать экран, где галочки ничего
            не меняют.
          */
          <p className="m-0 text-caption text-muted">{ut("perm.superadminNote")}</p>
        ) : (
          <>
            <SectionLabel className="mb-1.5">{ut("perm.effective")}</SectionLabel>
            <div className="mb-3">
              <Gives permissions={card.effective} index={index} />
            </div>

            {byException.length ? (
              <div className="mb-3 flex flex-wrap items-baseline gap-1.5">
                <Tag tone="primary">{ut("perm.fromException")}</Tag>
                {byException.map((p) => (
                  <span key={p} className="text-caption text-muted">
                    {titleOf(p)}
                  </span>
                ))}
              </div>
            ) : null}

            {takenAway.length ? (
              /* отнятое исключением не видно в итоге вовсе — а спрашивают чаще всего именно про него */
              <div className="mb-3 flex flex-wrap items-baseline gap-1.5">
                <Tag tone="danger">{ut("perm.closedList")}</Tag>
                {takenAway.map((p) => (
                  <span key={p} className="text-caption text-muted">
                    {titleOf(p)}
                  </span>
                ))}
              </div>
            ) : null}

            <SectionLabel className="mb-1.5">{ut("perm.fromRoles")}</SectionLabel>
            <div className="mb-2 flex flex-col gap-1">
              {roles.map((r) => (
                /*
                 * Роль не ниже собственной показывается, но не нажимается.
                 *
                 * Спрятать её было бы хуже: экран нарисовал бы лестницу,
                 * обрывающуюся на читателе, и «а где главный врач» стало бы
                 * вопросом без ответа. Погашенная строка с подписью отвечает
                 * на него на месте.
                 */
                <label key={r.id} className="check">
                  <input
                    type="checkbox"
                    checked={mine.has(r.id)}
                    disabled={busy || !r.assignable}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...card.roles.map((x) => x.roleId), r.id]
                        : card.roles.map((x) => x.roleId).filter((id) => id !== r.id);
                      void run(async () => {
                        await api.setUserRoles(card.userId, next);
                        onChanged();
                      });
                    }}
                  />
                  {r.title[lang]}
                  {(ROLE_LADDER as readonly string[]).includes(r.code) ? null : (
                    <span className="text-caption text-muted">{ut("perm.outsideChain")}</span>
                  )}
                  {r.assignable ? null : (
                    <span className="text-caption text-muted">{ut("perm.notYours")}</span>
                  )}
                </label>
              ))}
            </div>
            <p className="m-0 text-caption text-muted">{ut("perm.chainNote")}</p>
          </>
        )}
      </Panel>

      {isSuper ? null : (
        <Panel title={ut("perm.exceptions")} hint={ut("perm.quickHint")}>
          {live.length === 0 ? (
            <p className="m-0 mb-3 text-caption text-muted">{ut("perm.noExceptions")}</p>
          ) : (
            <div className="mb-3 flex flex-col gap-2">
              {live.map((e) => (
                <div key={e.id} className="flex flex-wrap items-baseline gap-2 border-b border-hairline pb-2">
                  <Tag tone={e.mode === "grant" ? "primary" : "danger"}>
                    {e.mode === "grant" ? ut("perm.grant") : ut("perm.revoke")}
                  </Tag>
                  <span className="text-small">{titleOf(e.permission)}</span>
                  <span className="text-caption text-muted">
                    <Until expiresAt={e.expiresAt} />
                  </span>
                  <Button
                    variant="quiet"
                    size="sm"
                    className="ml-auto"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.revokeException(e.id);
                        onChanged();
                      }, ut("perm.cancelled"))
                    }
                  >
                    {ut("perm.cancel")}
                  </Button>
                  {/* что именно эта строка открыла или закрыла — иначе разбирать её нечем */}
                  <span className="w-full text-caption text-muted">
                    {e.mode === "grant" ? ut("perm.willOpen") : ut("perm.willClose")}:{" "}
                    {opensOf(e.permission)}
                  </span>
                  <span className="w-full text-caption text-muted">{e.reason}</span>
                </div>
              ))}
            </div>
          )}

          <SectionLabel className="mb-1.5">{ut("perm.quick")}</SectionLabel>
          <div className="mb-3 flex flex-wrap gap-2">
            {exceptionable.map((p) => (
              <Button
                key={p}
                size="sm"
                onClick={() => {
                  setAdding(p);
                  setMode(card.effective.includes(p) ? "revoke" : "grant");
                  setReason("");
                  setDays("");
                }}
              >
                {titleOf(p)}
              </Button>
            ))}
          </div>

          {/*
            Поштучно открывается и закрывается любая возможность, а не только
            три частых. Быстрые кнопки остаются сверху, потому что в девяти
            случаях из десяти нужны именно они; полный список стоит рядом,
            чтобы за десятым случаем не приходилось идти к разработчику.
          */}
          <Field label={ut("perm.anyPermission")}>
            <Select
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                setAdding(e.target.value);
                setMode(card.effective.includes(e.target.value) ? "revoke" : "grant");
                setReason("");
                setDays("");
              }}
            >
              <option value="">{ut("perm.pickPermission")}</option>
              {groups.map((g) => (
                <optgroup key={g.code} label={g.title[lang] ?? g.code}>
                  {g.permissions.map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.title[lang]}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>

          {adding ? (
            <div className="mt-3 flex flex-col gap-3 rounded-md bg-surface-2 p-4">
              <strong className="text-small font-medium">{titleOf(adding)}</strong>
              <div className="flex gap-2">
                {(["grant", "revoke"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`chip${mode === m ? " active" : ""}`}
                    onClick={() => setMode(m)}
                  >
                    {m === "grant" ? ut("perm.grant") : ut("perm.revoke")}
                  </button>
                ))}
              </div>
              {/*
                Последствие названо до нажатия, а не после. «Выдать
                surveys.edit» и «откроет конструктор методик и ключи подсчёта»
                — это одно и то же действие, но второе останавливает того,
                кто не собирался открывать ключи.
              */}
              <p className="m-0 text-caption leading-normal text-muted">
                {mode === "grant" ? ut("perm.willOpen") : ut("perm.willClose")}: {opensOf(adding)}
              </p>
              {mode === "revoke" && !card.effective.includes(adding) ? (
                <p className="m-0 text-caption text-muted">{ut("perm.closedByException")}</p>
              ) : null}
              <Field label={ut("perm.reason")} hint={ut("perm.reasonHint")}>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <Field label={ut("perm.days")} hint={ut("perm.forever")}>
                <Input
                  value={days}
                  inputMode="numeric"
                  onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))}
                  className="w-[120px]"
                />
              </Field>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={busy || reason.trim().length < 10}
                  onClick={() =>
                    void run(async () => {
                      await api.addException(card.userId, {
                        permission: adding,
                        mode,
                        reason: reason.trim(),
                        days: days ? Number(days) : undefined,
                      });
                      setAdding(null);
                      onChanged();
                    }, ut("perm.added"))
                  }
                >
                  {ut("perm.addException")}
                </Button>
                <Button variant="quiet" onClick={() => setAdding(null)}>
                  {ut("common.cancel")}
                </Button>
              </div>
            </div>
          ) : null}
        </Panel>
      )}
    </Stack>
  );
}
