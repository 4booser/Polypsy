import { useState } from "react";
import { api, type OpenApiOperation as Operation } from "../api";
import { useResource } from "../useResource";
import { Loading, PageHead } from "../ui";

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
  const [open, setOpen] = useState<string | null>(null);
  const { data: spec, error } = useResource(() => api.openapi(), []);

  if (!spec) return <Loading error={error} />;

  const byTag = new Map<string, { path: string; method: string; op: Operation }[]>();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tag = op.tags[0] ?? "прочее";
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
    <>
      <PageHead
        title="Описание API"
        sub={`${spec.info.title} ${spec.info.version} · ${total} маршрутов`}
        actions={
          <button onClick={() => void api.downloadOpenapi()}>Скачать openapi.json</button>
        }
      />
      <div className="card">
        <p className="hint" style={{ marginTop: 0 }}>
          Пути и методы выведены из таблицы маршрутов приложения, поэтому разойтись с кодом
          не могут. Схемы тел взяты из проверяющих схем — то же, что применяется к запросу.
        </p>
      </div>

      {[...byTag.entries()].sort().map(([tag, list]) => (
        <div className="card" key={tag}>
          <div className="card-head">
            <h2>{tag}</h2>
            <span className="hint">{list.length}</span>
          </div>
          {list.map(({ path, method, op }) => {
            const key = `${method} ${path}`;
            const schema = op.requestBody?.content["application/json"].schema;
            return (
              <div key={key} className="api-row">
                <button
                  className="ghost api-line"
                  onClick={() => setOpen(open === key ? null : key)}
                  disabled={!schema}
                  title={schema ? "Показать схему тела" : "Тело не требуется"}
                >
                  <span className={`api-method m-${method}`}>{method.toUpperCase()}</span>
                  <code>{path}</code>
                </button>
                <div className="api-meta">
                  <span>{op.summary}</span>
                  <span className="muted">{op.description}</span>
                </div>
                {open === key && schema ? (
                  <pre className="api-schema">{JSON.stringify(schema, null, 2)}</pre>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
