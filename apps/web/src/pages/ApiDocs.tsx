import { useState } from "react";
import { api, type OpenApiOperation as Operation } from "../api";
import { useResource } from "../useResource";
import { Loading } from "../ui";
import { Button } from "../ui/primitives";
import { Page, Panel, Stack } from "../ui/layout";
import { useLang } from "../lang";

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"];

/**
 * Описание API прямо в консоли.
 *
 * Swagger UI сюда не подходит: он тянет скрипты со стороннего CDN, а
 * content-security-policy у нас закрыт намеренно — открывать его ради
 * удобной странички было бы обменом безопасности на косметику. Список
 * маршрутов со схемами тел даёт то же самое без единого внешнего запроса.
 */
export default function ApiDocs() {
  const { ut } = useLang();
  const [open, setOpen] = useState<string | null>(null);
  const { data: spec, error } = useResource(() => api.openapi(), []);

  if (!spec) return <Loading error={error} />;

  const byTag = new Map<string, { path: string; method: string; op: Operation }[]>();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tag = op.tags[0] ?? ut("api.routesFallbackTag");
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push({ path, method, op });
    }
  }
  for (const list of byTag.values()) {
    list.sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
    );
  }

  const total = [...byTag.values()].reduce((n, l) => n + l.length, 0);

  return (
    <Page
      title={ut("api.title")}
      sub={`${spec.info.title} ${spec.info.version} · ${total} ${ut("api.routesCount")}`}
      actions={<Button variant="primary" onClick={() => void api.downloadOpenapi()}>{ut("api.download")}</Button>}
    >
      <Stack>
        <Panel>
          <p className="m-0 text-small text-muted">{ut("api.routesDescription")}</p>
        </Panel>

        {[...byTag.entries()].sort().map(([tag, list]) => (
          <Panel
            key={tag}
            title={tag}
            actions={<span className="text-caption text-muted">{list.length}</span>}
          >
            {list.map(({ path, method, op }) => {
              const key = `${method} ${path}`;
              const schema = op.requestBody?.content["application/json"].schema;
              return (
                <div key={key} className="api-row">
                  {/*
                    Кнопка-раскрытие была className="ghost api-line": обычная
                    кнопка занимает столько места, сколько текст, а строка
                    списка маршрутов должна тянуться на всю ширину панели и
                    прижимать текст влево, а не к центру — это единственная
                    причина оверрайдов ниже.
                  */}
                  <Button
                    variant="quiet"
                    className="!h-auto w-full justify-start gap-2.5 !px-2 py-2"
                    onClick={() => setOpen(open === key ? null : key)}
                    disabled={!schema}
                    title={schema ? ut("api.showSchema") : ut("api.noBody")}
                  >
                    <span className={`api-method m-${method}`}>{method.toUpperCase()}</span>
                    <code>{path}</code>
                  </Button>
                  <div className="api-meta">
                    <span>{op.summary}</span>
                    <span className="text-muted">{op.description}</span>
                  </div>
                  {open === key && schema ? (
                    <pre className="api-schema">{JSON.stringify(schema, null, 2)}</pre>
                  ) : null}
                </div>
              );
            })}
          </Panel>
        ))}
      </Stack>
    </Page>
  );
}
