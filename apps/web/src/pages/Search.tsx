import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { dateTime } from "../format";
import { useLang } from "../lang";
import { useAction } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button, Input } from "../ui/primitives";

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
    <Page title={ut("srch.title")} sub={ut("srch.sub")}>
      <Stack>
        <Panel>
          <div className="flex gap-2">
            <Input
              className="flex-1"
              value={q}
              placeholder={ut("srch.placeholder")}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && q.trim().length >= 2 && search()}
            />
            <Button variant="primary" disabled={busy || q.trim().length < 2} onClick={search}>
              {ut("srch.go")}
            </Button>
          </div>
          <p className="m-0 mt-2 text-caption text-muted">{ut("srch.morphNote")}</p>
        </Panel>

        {result ? (
          <Panel title={`${ut("srch.found")}: ${result.items.length}`}>
            {result.items.length === 0 ? (
              <p className="m-0 text-muted">{ut("srch.nothing")}</p>
            ) : (
              <ul className="search-hits">
                {result.items.map((hit) => (
                  <li key={hit.id}>
                    <div className="flex items-center gap-2">
                      <Link to={`/patients/${hit.userId}/summary`}>{hit.userName}</Link>
                      <span className="text-muted">
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
          </Panel>
        ) : null}
      </Stack>
    </Page>
  );
}
