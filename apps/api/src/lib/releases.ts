import { HTTPException } from "hono/http-exception";
import { desc, isNotNull, sql } from "drizzle-orm";
import type { ReleaseEntry, ReleasesView } from "@quizzy/shared";
import journal from "../../drizzle/meta/_journal.json" with { type: "json" };
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { releases } from "../db/schema";
import { env } from "../env";
import type { ErrorInfo } from "./http";
import { log } from "./log";

/**
 * История выкаток: какой выпуск когда работал, с какими миграциями, кто его
 * выкатил и где прогон CI.
 *
 * Решение заказчика 2026-09-26 (техпанель, пункт 12): тег, коммит, кто и
 * когда, миграции выпуска, ссылка на прогон CI, откат на предыдущий тег.
 *
 * Запись делает сам сервер при старте, а не шаг выкатки: так история
 * отражает то, что действительно поднялось, а не то, что собирались
 * выкатить. Выкатка, упавшая до старта API, в историю не попадает — и не
 * должна: этот выпуск не работал ни минуты.
 */

export interface ReleaseInfo {
  version: string;
  commitSha: string | null;
  deployedBy: string | null;
  runUrl: string | null;
  repo: string | null;
}

/*
 * Проверка значений из окружения. Они уходят на экран ссылками, и адрес,
 * собранный из непроверенной строки, стал бы ссылкой куда угодно. Прогон
 * CI — только на github.com, коммит — только шестнадцатеричный, репозиторий
 * — «владелец/имя».
 */
const SHA = /^[0-9a-f]{7,40}$/i;
/* владелец — буквы, цифры и дефис; имя — ещё точка и подчёркивание, но не «.» и не «..» */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
const RUN =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?\/)[A-Za-z0-9_.-]+\/actions\/runs\/\d+(\/attempts\/\d+)?$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;

/**
 * Что за выпуск в окружении этого процесса.
 *
 * null — выпуска нет: «local» (сборка на месте) и «latest» (плавающий тег,
 * которым на сервере заводят первую установку, см. docs/DEPLOY.md) не
 * называют никакого выпуска, и строка «latest» в истории ничего бы не
 * сообщала — через неделю под ней лежал бы уже другой код.
 */
export function releaseFromEnv(source = env.release): ReleaseInfo | null {
  const version = source.version;
  if (!version || version === "local" || version === "latest") return null;
  return {
    version,
    commitSha: SHA.test(source.commit) ? source.commit.toLowerCase() : null,
    deployedBy: LOGIN.test(source.deployedBy) ? source.deployedBy : null,
    runUrl: RUN.test(source.runUrl) ? source.runUrl : null,
    repo: REPO.test(source.repo) ? source.repo : null,
  };
}

/**
 * Миграции этой версии кода — по журналу drizzle, который едет в образе.
 *
 * Почему журнал, а не таблица применённых миграций. Приложение подключается
 * ролью без прав владельца, и служебная схема drizzle ему не видна (и не
 * должна быть). А журнал в образе — ровно тот список, который применил
 * provision перед стартом: compose не поднимает api, пока provision не
 * завершился успешно (depends_on: service_completed_successfully). Значит,
 * к моменту этой записи всё из журнала уже в базе.
 */
export function migrationTags(): string[] {
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag);
}

/**
 * Какие миграции пришли с этим выпуском.
 *
 * null — неизвестно: прошлого выпуска в истории нет, и что было до него,
 * сказать нечем. Пустой список — новых миграций нет; так же выглядит и
 * откат на старый тег: его последняя миграция стоит раньше прошлой, а
 * миграции переключением тега не откатываются — они остаются в базе (это и
 * видно в предупреждении кнопки отката).
 */
export function migrationsSince(tags: string[], previousLast: string | null | undefined): string[] | null {
  if (previousLast === undefined) return null;
  if (previousLast === null) return tags;
  const at = tags.indexOf(previousLast);
  return at === -1 ? [] : tags.slice(at + 1);
}

/* выкатку в историю пишет один процесс за раз: два API на одной базе иначе записали бы её дважды */
const RELEASE_LOCK = 7_154_390;

/**
 * Записать выпуск, если он новый.
 *
 * Новый — если версия или коммит отличаются от последней строки. Перезапуск
 * того же выпуска дубля не даёт; откат на прежний тег даёт новую строку:
 * это новый период работы, и «время работы выпуска» считается по периодам.
 *
 * Системным контекстом: человека здесь нет, сервер пишет о себе сам.
 */
export async function recordRelease(
  info: ReleaseInfo | null = releaseFromEnv(),
  tags: string[] = migrationTags(),
): Promise<"recorded" | "same" | "skipped"> {
  if (!info) return "skipped";
  return systemContext(baseDb, async () => {
    await db.execute(sql`select pg_advisory_xact_lock(${RELEASE_LOCK})`);
    const [last] = await db.select().from(releases).orderBy(desc(releases.startedAt)).limit(1);
    if (last && last.version === info.version && (last.commitSha ?? null) === info.commitSha) return "same";
    await db.insert(releases).values({
      id: crypto.randomUUID(),
      version: info.version,
      commitSha: info.commitSha,
      deployedBy: info.deployedBy,
      runUrl: info.runUrl,
      repo: info.repo,
      migrations: migrationsSince(tags, last ? last.lastMigration : undefined),
      lastMigration: tags.at(-1) ?? null,
    });
    log.info("release recorded", { version: info.version, commit: info.commitSha });
    return "recorded";
  });
}

/** Страница ручного запуска выкатки в GitHub Actions */
export function workflowUrl(repo: string | null): string | null {
  return repo ? `https://github.com/${repo}/actions/workflows/deploy.yml` : null;
}

/**
 * Репозиторий для ссылок и запуска: из окружения этого процесса, иначе из
 * последней выкатки, где он был известен. Процесс, поднятый руками без
 * QUIZZY_REPO, не должен терять ссылки на историю, записанную выкатками.
 */
export async function knownRepo(): Promise<string | null> {
  const fromEnv = releaseFromEnv()?.repo;
  if (fromEnv) return fromEnv;
  const [row] = await db
    .select({ repo: releases.repo })
    .from(releases)
    .where(isNotNull(releases.repo))
    .orderBy(desc(releases.startedAt))
    .limit(1);
  return row?.repo ?? null;
}

/** История выкаток для техпанели: свежие сверху, со временем работы каждого */
export async function listReleases(limit = 50): Promise<ReleasesView> {
  const rows = await db.select().from(releases).orderBy(desc(releases.startedAt)).limit(limit);
  const running = releaseFromEnv();
  const repo = await knownRepo();
  const items: ReleaseEntry[] = rows.map((r, i) => {
    const repoOf = r.repo ?? repo;
    return {
      id: r.id,
      version: r.version,
      commitSha: r.commitSha,
      commitUrl: repoOf && r.commitSha ? `https://github.com/${repoOf}/commit/${r.commitSha}` : null,
      deployedBy: r.deployedBy,
      runUrl: r.runUrl,
      startedAt: r.startedAt,
      // свежие сверху: следующий по времени выпуск стоит в списке выше
      endedAt: i === 0 ? null : rows[i - 1]!.startedAt,
      migrations: r.migrations ?? null,
      lastMigration: r.lastMigration,
    };
  });
  return {
    items,
    running: { version: env.release.version || null, commitSha: running?.commitSha ?? null },
    workflowUrl: workflowUrl(repo),
    dispatchConfigured: !!env.githubDispatchToken && !!repo,
  };
}

/**
 * Запустить выкатку прежнего тега через API GitHub (workflow_dispatch).
 *
 * Это не «откат» в смысле обратной миграции: схема назад не едет (см.
 * комментарии в deploy.yml), выкатка просто собирает и поднимает старый
 * тег поверх той же базы. Запускается рабочий процесс из main, а тег
 * уходит входом `ref`: логика выкатки берётся свежая (со всеми её
 * проверками), а код — старый.
 *
 * fetch — параметром, чтобы тест не ходил в GitHub.
 */
export async function dispatchDeploy(
  version: string,
  deps: { token: string; repo: string | null; fetch?: typeof fetch } = {
    token: env.githubDispatchToken,
    repo: releaseFromEnv()?.repo ?? null,
  },
): Promise<void> {
  const call = deps.fetch ?? fetch;
  if (!deps.token || !deps.repo) fail(409, "err.dispatchNotConfigured");
  let res: Response;
  try {
    res = await call(`https://api.github.com/repos/${deps.repo}/actions/workflows/deploy.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { ref: version } }),
    });
  } catch {
    fail(502, "err.dispatchFailed", { status: 0 });
  }
  // GitHub отвечает 204 без тела; всё прочее — отказ, и его код человеку нужен
  if (res.status !== 204) {
    log.warn("deploy dispatch refused", { status: res.status });
    fail(502, "err.dispatchFailed", { status: res.status });
  }
}

function fail(status: 409 | 502, key: string, params?: Record<string, string | number>): never {
  throw new HTTPException(status, { message: key, cause: { key, params } satisfies ErrorInfo });
}
