import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { dateTime } from "../format";
import { useLang } from "../lang";
import { PageHead, useAction } from "../ui";

/**
 * Поиск по записям приёма.
 *
 * Записи зашифрованы, и поиск идёт по отпечаткам основ слов, а не по тексту.
 * Об этом сказано прямо на экране: ограничения поиска — не техническая деталь,
 * а то, что определяет, какой запрос сработает. «Тревожность» найдёт
 * «тревожности», но не «тревогу», и человек должен знать это до того, как
 * решит, что записи нет.
 */
export default function Search() {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [q, setQ] = useState("");
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.searchNotes>> | null>(null);

  const search = () =>
    void run(async () => {
      setResult(await api.searchNotes(q.trim()));
    });

  return (
    <>
      <PageHead title={ut("srch.title")} sub={ut("srch.sub")} />

      <div className="card">
        <div className="row tight">
          <input
            style={{ flex: 1 }}
            value={q}
            placeholder={ut("srch.placeholder")}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && q.trim().length >= 2 && search()}
          />
          <button className="primary" disabled={busy || q.trim().length < 2} onClick={search}>
            {ut("srch.go")}
          </button>
        </div>
        <p className="hint">{ut("srch.morphNote")}</p>
      </div>

      {result ? (
        <div className="card">
          <div className="card-head">
            <h2>
              {ut("srch.found")}: {result.items.length}
            </h2>
          </div>

          {result.items.length === 0 ? (
            <p className="muted">{ut("srch.nothing")}</p>
          ) : (
            <ul className="search-hits">
              {result.items.map((hit) => (
                <li key={hit.id}>
                  <div className="row tight">
                    <Link to={`/patients/${hit.userId}/summary`}>{hit.userName}</Link>
                    <span className="muted">
                      {dateTime(hit.createdAt)} · {ut("note.version")} {hit.version}
                    </span>
                  </div>
                  {/*
                    Отрывок, а не запись целиком: поиск по одному слову
                    выложил бы на экран десяток клинических текстов сразу, а
                    прочитан будет один.
                  */}
                  <p className="search-excerpt">{hit.excerpt}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </>
  );
}
