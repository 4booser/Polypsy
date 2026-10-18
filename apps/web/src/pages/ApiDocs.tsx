import { Fragment, useMemo, useState, type ReactNode } from "react";
import type { UiKey } from "@quizzy/shared";
import { api, type OpenApiOperation as Operation } from "../api";
import { useResource } from "../useResource";
import { Empty, FilterChip, Ic, Loading, SearchField, useToast } from "../ui";
import { cx } from "../ui/cx";
import { Count, Page, Panel } from "../ui/layout";
import { MenuButton, menuItemClass } from "../ui/menu";
import { Button } from "../ui/primitives";
import { useLang } from "../lang";
import { AIc, fill } from "./people/parts";

/**
 * Описание API прямо в консоли — Polypsy 2.0, макет admin-api-docs.
 *
 * Swagger UI сюда не подходит: он тянет скрипты со стороннего CDN, а
 * content-security-policy у нас закрыт намеренно — открывать его ради
 * удобной странички было бы обменом безопасности на косметику. Список
 * маршрутов со схемами тел даёт то же самое без единого внешнего запроса.
 *
 * Слева — разделы (первая часть пути) с числом маршрутов; справа — отбор
 * по тексту, методу и доступу и маршруты разделами. Доступ — машинно, из
 * описания (x-access, x-permission): кому маршрут открыт и каким правом.
 * Раскрытая строка показывает схему тела — её строят те же проверки, что и
 * запрос, — и ответы.
 */

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"];

interface Route {
  path: string;
  method: string;
  op: Operation;
}

type MethodView = "all" | "get" | "post" | "put" | "delete";
type AccessView = "all" | "public" | "user" | "staff" | "superadmin";

/** Маршруты разделами: по первому тегу, внутри — путь, потом порядок методов */
export function byTag(spec: { paths: Record<string, Record<string, Operation>> }, fallback: string): Map<string, Route[]> {
  const out = new Map<string, Route[]>();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tag = op.tags[0] ?? fallback;
      if (!out.has(tag)) out.set(tag, []);
      out.get(tag)!.push({ path, method, op });
    }
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.path.localeCompare(b.path) || METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method));
  }
  return out;
}

/** Попадает ли маршрут в отбор: метод (PUT и PATCH — одной пилюлей), доступ, текст */
export function routeMatches(r: Route, f: { method: MethodView; access: AccessView; q: string }): boolean {
  if (f.method !== "all" && !(f.method === "put" ? r.method === "put" || r.method === "patch" : r.method === f.method)) return false;
  if (f.access !== "all" && (r.op["x-access"] ?? null) !== f.access) return false;
  const q = f.q.trim().toLowerCase();
  if (!q) return true;
  return `${r.path} ${r.op.summary} ${r.op["x-permission"] ?? ""}`.toLowerCase().includes(q);
}

export default function ApiDocs() {
  const { ut } = useLang();
  const toast = useToast();
  const { data: spec, error, reload, loading } = useResource(() => api.openapi(), []);
  const [q, setQ] = useState("");
  const [method, setMethod] = useState<MethodView>("all");
  const [access, setAccess] = useState<AccessView>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [allTags, setAllTags] = useState(false);
  const [onlyTag, setOnlyTag] = useState<string | null>(null);

  const tags = useMemo(() => (spec ? byTag(spec, ut("api.routesFallbackTag")) : new Map<string, Route[]>()), [spec, ut]);
  if (!spec) {
    return (
      <Page title={ut("api.title")}>
        <Loading error={error} onRetry={reload} busy={loading} rows={8} />
      </Page>
    );
  }

  const all = [...tags.values()].flat();
  const total = all.length;
  const ordered = [...tags.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const methodCount = (m: MethodView) => all.filter((r) => routeMatches(r, { method: m, access, q: "" })).length;
  const shown = ordered
    .filter(([tag]) => !onlyTag || tag === onlyTag)
    .map(([tag, list]) => [tag, list.filter((r) => routeMatches(r, { method, access, q }))] as const)
    .filter(([, list]) => list.length > 0);
  const visibleTags = allTags ? ordered : ordered.slice(0, 16);

  const accessLabel: Record<AccessView, string> = {
    all: ut("adm2.accessAll"),
    public: ut("adm2.accessPublic"),
    user: ut("adm2.accessUser"),
    staff: ut("adm2.accessStaff"),
    superadmin: ut("adm2.accessSuper"),
  };

  return (
    <Page
      title={ut("api.title")}
      meta={[fill(ut("adm2.apiMeta"), { title: spec.info.title, version: spec.info.version, n: total }), ut("adm2.apiMetaSub")]}
      actions={
        <>
          <Button
            icon={<AIc.link size={15} />}
            onClick={() => {
              void navigator.clipboard?.writeText(`${window.location.origin}/api`).then(() => toast(ut("adm2.copied"), "ok"));
            }}
          >
            {ut("adm2.copyBase")}
          </Button>
          <Button variant="primary" icon={<Ic.download size={15} />} onClick={() => void api.downloadOpenapi()}>
            {ut("adm2.downloadSpec")}
          </Button>
        </>
      }
    >
      <div className="grid items-start gap-4 min-[1100px]:grid-cols-[220px_minmax(0,1fr)]">
        <Panel title={ut("adm2.sections")} count={tags.size} className="min-[1100px]:sticky min-[1100px]:top-0" flush>
          <ul className="m-0 flex list-none flex-col gap-0.5 px-2 pb-2">
            {visibleTags.map(([tag, list]) => (
              <li key={tag}>
                <button
                  type="button"
                  aria-pressed={onlyTag === tag}
                  onClick={() => setOnlyTag(onlyTag === tag ? null : tag)}
                  className={cx(
                    "flex h-8 min-h-0 w-full cursor-pointer items-center gap-2 rounded-[9px] border-0 px-2.5 text-left",
                    onlyTag === tag ? "bg-violet-tint text-violet-ink" : "bg-transparent text-text hover:bg-sunk",
                  )}
                >
                  <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-bold">{tag}</code>
                  <Count n={list.length} tone={onlyTag === tag ? "tint" : "plain"} />
                </button>
              </li>
            ))}
            {ordered.length > 16 ? (
              <li>
                <button
                  type="button"
                  onClick={() => setAllTags((v) => !v)}
                  className="flex h-8 min-h-0 w-full cursor-pointer items-center gap-2 rounded-[9px] border-0 bg-transparent px-2.5 text-left text-small text-text-2 hover:bg-sunk"
                >
                  {allTags ? <Ic.chevronDown size={14} className="rotate-180" /> : <Ic.chevronDown size={14} />}
                  {allTags ? ut("adm2.fewerSections") : fill(ut("adm2.moreSections"), { n: ordered.length - 16 })}
                </button>
              </li>
            ) : null}
          </ul>
        </Panel>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <SearchField value={q} onChange={setQ} placeholder={ut("adm2.searchRoute")} slash width={240} />
            <div role="group" aria-label={ut("adm2.method")} className="flex flex-wrap gap-[5px]">
              {(["all", "get", "post", "put", "delete"] as MethodView[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={method === m}
                  onClick={() => setMethod(m)}
                  className={cx(
                    "inline-flex h-8 min-h-0 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-2xl border-0 px-2.5 text-small leading-none",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                    method === m ? "bg-violet font-bold text-onfill" : "bg-sunk font-semibold text-text-2 hover:bg-sunk-2",
                  )}
                >
                  {m === "all" ? ut("adm2.viewAll") : m === "put" ? ut("adm2.putPatch") : <span className="font-mono">{m.toUpperCase()}</span>}
                  <span className={cx("font-bold tabular-nums", method === m ? "text-onfill-muted" : "text-muted")}>{methodCount(m)}</span>
                </button>
              ))}
            </div>
            <div className="ml-auto">
              <MenuButton
                label={ut("adm2.access")}
                trigger={(p) => (
                  <FilterChip
                    label={ut("adm2.access")}
                    value={access === "all" ? undefined : accessLabel[access]}
                    on={access !== "all"}
                    expanded={p["aria-expanded"]}
                    onClick={p.onClick}
                    onClear={access !== "all" ? () => setAccess("all") : undefined}
                  />
                )}
              >
                {(close) =>
                  (["all", "public", "user", "staff", "superadmin"] as AccessView[]).map((a) => (
                    <button
                      key={a}
                      type="button"
                      role="menuitemradio"
                      aria-checked={access === a}
                      className={menuItemClass("left")}
                      onClick={() => {
                        close();
                        setAccess(a);
                      }}
                    >
                      <span className="min-w-0 flex-1">{accessLabel[a]}</span>
                      {access === a ? <Ic.check size={15} className="text-violet-ink" /> : null}
                    </button>
                  ))
                }
              </MenuButton>
            </div>
          </div>

          {shown.length ? (
            shown.map(([tag, list]) => (
              <Panel key={tag} title={<code className="font-mono">{tag}</code>} icon={<AIc.braces />} count={list.length} flush>
                <div className="overflow-x-auto">
                  <table className="w-full border-separate border-spacing-0 text-body" aria-label={tag}>
                    <thead>
                      <tr>
                        <th className="h-[38px] w-[44px] border-y border-divider bg-panel-2" aria-label={ut("adm2.details")} />
                        {[ut("adm2.method"), ut("adm2.path"), ut("adm2.description"), ut("adm2.access")].map((h) => (
                          <th key={h} className="h-[38px] border-y border-divider bg-panel-2 px-2.5 text-left text-caption font-bold text-muted last:pr-4">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((r) => {
                        const key = `${r.method} ${r.path}`;
                        const schema = r.op.requestBody?.content["application/json"].schema;
                        const isOpen = open === key;
                        return (
                          <Fragment key={key}>
                            <tr className={cx(isOpen && "bg-panel-2")}>
                              <td className="border-b border-divider py-2 pl-3">
                                {/* раскрывается то, у чего есть тело: схема — главное, что за раскрытием ищут */}
                                {schema ? (
                                  <button
                                    type="button"
                                    aria-expanded={isOpen}
                                    aria-label={ut("api.showSchema")}
                                    onClick={() => setOpen(isOpen ? null : key)}
                                    className={cx(
                                      "inline-grid size-8 min-h-0 cursor-pointer place-items-center rounded-[9px] border-0 text-muted",
                                      isOpen ? "bg-violet-tint text-violet-ink" : "bg-transparent hover:bg-sunk",
                                    )}
                                  >
                                    {isOpen ? <Ic.chevronDown size={15} /> : <Ic.chevronRight size={15} />}
                                  </button>
                                ) : null}
                              </td>
                              <td className="border-b border-divider px-2.5 py-2">
                                <MethodBadge method={r.method} />
                              </td>
                              <td className="border-b border-divider px-2.5 py-2">
                                <PathText path={r.path} />
                              </td>
                              <td className="max-w-[360px] border-b border-divider px-2.5 py-2 text-small leading-[18px] text-text-2">{r.op.summary}</td>
                              <td className="border-b border-divider py-2 pl-2.5 pr-4">
                                <AccessCell op={r.op} />
                              </td>
                            </tr>
                            {isOpen ? (
                              <tr>
                                <td colSpan={5} className="border-b border-divider bg-panel-2 px-4 pb-4 pt-1">
                                  <RouteDetail route={r} schema={schema ?? null} />
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Panel>
            ))
          ) : (
            <Panel>
              <Empty compact title={ut("adm2.noRoutes")} />
            </Panel>
          )}
        </div>
      </div>
    </Page>
  );
}

function MethodBadge({ method }: { method: string }) {
  const tone =
    method === "get"
      ? "bg-info-tint text-info"
      : method === "post"
        ? "bg-violet-tint text-violet-ink"
        : method === "delete"
          ? "bg-warn-tint text-warn"
          : "bg-sunk text-text-2";
  return (
    <span className={cx("inline-grid h-6 min-w-[58px] place-items-center rounded-[7px] px-2 font-mono text-[11.5px] font-bold", tone)}>
      {method.toUpperCase()}
    </span>
  );
}

/** Путь моноширинным, параметры `{id}` — как `:id` и жирнее: так их пишет и сам код маршрутов */
function PathText({ path }: { path: string }) {
  const parts = path.split(/(\{[^}]+\})/);
  return (
    <code className="whitespace-nowrap font-mono text-[12.5px] text-text">
      {parts.map((p, i) =>
        p.startsWith("{") ? (
          <b key={i} className="font-bold text-violet-ink">
            :{p.slice(1, -1)}
          </b>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </code>
  );
}

function AccessCell({ op }: { op: Operation }) {
  const { ut } = useLang();
  const a = op["x-access"] ?? null;
  const icon: ReactNode =
    a === "public" ? <AIc.globe size={14} /> : a === "superadmin" ? <AIc.shieldHalf size={14} /> : a === "staff" ? <AIc.stethoscope size={14} /> : <Ic.user size={14} />;
  const label = accessText(op, ut);
  return (
    <span className="flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-small text-text">
        <span className="text-muted">{icon}</span>
        {label}
      </span>
      {op["x-permission"] ? <code className="pl-5 font-mono text-[11px] text-muted">{op["x-permission"]}</code> : null}
    </span>
  );
}

/** Кому маршрут открыт — словами интерфейса, по машинному x-access */
function accessText(op: Operation, ut: (k: UiKey) => string): string {
  const a = op["x-access"] ?? null;
  if (a === "public") return ut("adm2.accessPublic");
  if (a === "user") return ut("adm2.accessUser");
  if (a === "staff") return ut("adm2.accessStaff");
  if (a === "superadmin") return ut("adm2.accessSuper");
  return ut("adm2.accessUnknown");
}

function RouteDetail({ route, schema }: { route: Route; schema: Record<string, unknown> | null }) {
  const { ut } = useLang();
  const toast = useToast();
  const json = schema ? JSON.stringify(schema, null, 2) : null;
  const responses = Object.entries((route.op as Operation & { responses?: Record<string, { description: string }> }).responses ?? {});
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 flex items-start gap-1.5 text-small text-text-2">
        <Ic.info size={14} className="mt-0.5 shrink-0 text-muted" />
        {fill(ut("adm2.accessIs"), { who: accessText(route.op, ut) })}
        {route.op["x-permission"] ? `; ${fill(ut("adm2.closedByPermission"), { code: route.op["x-permission"] })}` : ""}
      </p>
      <div className="grid items-start gap-3 min-[900px]:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-w-0 overflow-hidden rounded-panel border border-border bg-panel">
          <div className="flex items-center gap-2 border-b border-divider px-3.5 py-2">
            <b className="text-small font-extrabold text-text">{ut("adm2.requestBody")}</b>
            {json ? <code className="font-mono text-caption text-muted">application/json</code> : null}
            {json ? (
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto"
                icon={<AIc.copy size={13} />}
                onClick={() => void navigator.clipboard?.writeText(json).then(() => toast(ut("adm2.copied"), "ok"))}
              >
                {ut("adm2.copy")}
              </Button>
            ) : null}
          </div>
          {json ? (
            <pre className="m-0 max-h-[360px] overflow-auto px-3.5 py-3 font-mono text-[12px] leading-[19px] text-text">{json}</pre>
          ) : (
            <p className="m-0 px-3.5 py-3 text-small text-muted">{ut("api.noBody")}</p>
          )}
        </div>
        <div className="rounded-panel border border-border bg-panel">
          <div className="border-b border-divider px-3.5 py-2">
            <b className="text-small font-extrabold text-text">{ut("adm2.responses")}</b>
          </div>
          <ul className="m-0 flex list-none flex-col gap-1.5 px-3.5 py-3">
            {responses.map(([code, r]) => (
              <li key={code} className="flex items-center gap-2 text-small">
                <span
                  className={cx(
                    "inline-grid h-6 min-w-[42px] place-items-center rounded-[7px] font-mono text-[11.5px] font-bold",
                    code.startsWith("2") ? "bg-good-tint text-good" : "bg-sunk text-text-2",
                  )}
                >
                  {code}
                </span>
                <span className="text-text-2">{r.description}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
