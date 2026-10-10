import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Обслуживание (maintenance.yml): входные поля проверяются до ssh (#154).
 *
 * Поле count ложилось в текст удалённой команды как есть: «120; что угодно»
 * исполнялось на сервере учреждения, и закрытый перечень действий
 * переставал быть границей — в том числе для держателя GITHUB_DISPATCH_TOKEN,
 * которому задумано одно право. keys проверялся, но уже после того, как
 * ssh открыт.
 *
 * Проверка — по самому файлу воркфлоу: шаг проверки стоит раньше любого
 * ssh, его сценарий отказывает на недопустимом и пропускает допустимое, а
 * шаг, собирающий команду, берёт значения из выходов проверки, а не из
 * полей формы.
 */

const ROOT = resolve(import.meta.dir, "../../..");

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
const workflow = Bun.YAML.parse(readFileSync(`${ROOT}/.github/workflows/maintenance.yml`, "utf8")) as {
  jobs: { run: { steps: Step[] } };
};
const steps = workflow.jobs.run.steps;
const checkAt = steps.findIndex((s) => s.id === "input");
const check = steps[checkAt]!;

/** Сценарий шага проверки — так же, как его запускает раннер: bash -eo pipefail */
async function runCheck(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "maint-input-"));
  try {
    const script = join(dir, "step.sh");
    const output = join(dir, "output");
    writeFileSync(script, check.run!);
    writeFileSync(output, "");
    const proc = Bun.spawn(["bash", "--noprofile", "--norc", "-eo", "pipefail", script], {
      env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const outputs = Object.fromEntries(
      readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    return { ok: code === 0, outputs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("обслуживание: вход проверяется до ssh", () => {
  test("шаг проверки стоит раньше любого ssh и scp", () => {
    expect(checkAt, "нет шага с id: input").toBeGreaterThanOrEqual(0);
    const firstRemote = steps.findIndex((s) => /\b(ssh|scp)\s/.test(s.run ?? ""));
    expect(firstRemote).toBeGreaterThan(checkAt);
    expect(check.run ?? "", "сам шаг проверки к серверу не ходит").not.toMatch(/\b(ssh|scp)\s/);
  });

  test("недопустимые count и keys — отказ", async () => {
    const refused: Record<string, string>[] = [
      { ACTION: "demo-fill", COUNT: "120; touch /tmp/pwned" },
      { ACTION: "demo-fill", COUNT: "$(id)" },
      { ACTION: "demo-fill", COUNT: "abc" },
      { ACTION: "demo-fill", COUNT: "0" },
      { ACTION: "demo-fill", COUNT: "501" },
      { ACTION: "demo-fill", COUNT: "0120" },
      { ACTION: "demo-fill", COUNT: "12\n3" },
      // непроверенное поле не доезжает и туда, где сейчас не нужно
      { ACTION: "rls-check", COUNT: "1;reboot" },
      { ACTION: "catalog-force", COUNT: "120", KEYS: "who5 --status" },
      { ACTION: "catalog-force", COUNT: "120", KEYS: "--status" },
      { ACTION: "catalog-force", COUNT: "120", KEYS: "" },
      { ACTION: "shell", COUNT: "120" },
    ];
    for (const env of refused) {
      const res = await runCheck(env);
      expect(res.ok, JSON.stringify(env)).toBe(false);
    }
  }, 30_000);

  test("допустимые — проходят, в выходы ложатся проверенные значения", async () => {
    // контроль: без него «всё отказывает» выглядело бы как исправная проверка
    expect((await runCheck({ ACTION: "demo-fill", COUNT: "250" })).outputs).toEqual({
      action: "demo-fill",
      count: "250",
      keys: "",
    });
    expect((await runCheck({ ACTION: "demo-fill", COUNT: "" })).outputs.count).toBe("120");
    expect((await runCheck({ ACTION: "catalog-force", COUNT: "120", KEYS: "who5,phq9" })).outputs.keys).toBe(
      "who5,phq9",
    );
    // keys при другом действии не передаётся дальше вовсе
    expect((await runCheck({ ACTION: "rls-check", COUNT: "120", KEYS: "who5" })).outputs.keys).toBe("");
  }, 30_000);

  test("команду собирает шаг, читающий выходы проверки, а не поля формы", () => {
    const exec = steps.find((s) => s.name === "Выполнить")!;
    const env = Object.values(exec.env ?? {}).join("\n");
    expect(env).not.toContain("inputs.");
    expect(env).toContain("steps.input.outputs.count");
    // в самом тексте шага поля формы не подставляются ни в каком виде
    expect(exec.run ?? "").not.toMatch(/\$\{\{\s*(github\.event\.)?inputs\./);
  });
});
