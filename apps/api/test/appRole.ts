import { resolve } from "node:path";

/**
 * Роль без прав владельца — как в бою.
 *
 * Тесты ходят в базу владельцем, а владелец в PostgreSQL политики строк
 * обходит: зелёная сюита под ним доказывает, что ничего не сломалось в dev,
 * и ничего — про политики. Та же роль, что заводят access.test.ts и
 * rlsIdentity.test.ts, здесь вынесена в одно место, чтобы третьему файлу не
 * копировать заведение и гранты. Роль общая на кластер, заводится
 * идемпотентно; гранты повторяются безвредно — а нужны каждый раз, потому
 * что тестовая база пересоздаётся на каждый прогон и права на её таблицы
 * пересоздаются вместе с ней.
 */
export const RLS_ROLE = "quizzy_rls_test";

/** Завести роль (если нет), выдать права и вернуть адрес подключения ею к тестовой базе */
export async function rlsRoleUrl(): Promise<string> {
  const postgres = (await import("postgres")).default;
  const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
  await admin.unsafe(`do $$ begin
    if not exists (select from pg_roles where rolname = '${RLS_ROLE}') then
      create role ${RLS_ROLE} login;
    end if;
  end $$`);
  await admin.unsafe(`grant usage on schema public to ${RLS_ROLE}`);
  await admin.unsafe(`grant select, insert, update, delete on all tables in schema public to ${RLS_ROLE}`);
  await admin.unsafe(`grant usage, select on all sequences in schema public to ${RLS_ROLE}`);
  await admin.end();

  const url = new URL(process.env.DATABASE_URL!);
  url.username = RLS_ROLE;
  url.password = "";
  return url.toString();
}

/**
 * Приложение целиком под ролью приложения.
 *
 * Отдельным процессом, потому что подключение к базе у приложения одно на
 * процесс и выбирается при загрузке модуля; подменить его внутри сюиты
 * нельзя — requireAuth открывает транзакцию на том подключении, которое
 * знает сам (приём тот же, что в rlsIdentity.test.ts). `body` выполняется
 * с `app` в области видимости и складывает результат в `out`; исключение
 * попадает в `out.error`. Первым делом в `out.rlsActive` записывается, что
 * политики для роли действуют, — иначе всё, что проверил бы вызывающий,
 * было бы проверкой их обхода.
 */
export async function underAppRole<T extends Record<string, unknown>>(
  body: string,
): Promise<Partial<T> & { rlsActive?: boolean; error?: string }> {
  const API = resolve(import.meta.dir, "..");
  const script = `
    const { app } = await import(${JSON.stringify(`${API}/src/app.ts`)});
    const { checkRls } = await import(${JSON.stringify(`${API}/src/lib/rlsGuard.ts`)});
    const out = {};
    try {
      out.rlsActive = !(await checkRls()).bypasses;
      ${body}
    } catch (e) {
      out.error = String(e);
    }
    console.log("RESULT:" + JSON.stringify(out));
    process.exit(0);
  `;
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: API,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL: await rlsRoleUrl(),
      JWT_SECRET: process.env.JWT_SECRET ?? "",
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "",
      SCHEDULER_ENABLED: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const line = `${out}${err}`.split("\n").find((l) => l.startsWith("RESULT:"));
  // вывод дочернего процесса типизировать нечем: он собирает out свободно, и Partial<T> — обещание вызывающего
  return (line ? JSON.parse(line.slice("RESULT:".length)) : { error: `${out}${err}`.slice(0, 2000) }) as Partial<T> & {
    rlsActive?: boolean;
    error?: string;
  };
}
