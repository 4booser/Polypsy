import { useState, type ReactNode } from "react";
import type { UiKey } from "@quizzy/shared";
import { api, download } from "../../api";
import { useLang } from "../../lang";
import { useAction } from "../../ui";
import { cx } from "../../ui/cx";
import { Drawer, DrawerSection } from "../../ui/Drawer";
import { Ic } from "../../ui/icons";
import { Callout } from "../../ui/states";
import { Button, ChoiceCard, Field, Input } from "../../ui/primitives";
import { Mi } from "./icons";

/*
 * «Вивантаження» в ящике (methods-exports-dialog): мета, профіль даних і
 * вісім файлів — те саме, що й шестерня аналітики методики
 * (pages/analytics/tests/actions.tsx), тільки у вигляді набору: файли —
 * плитки з поясненням і іменем, вибраний завантажується основною кнопкою.
 *
 * Профіль за замовчуванням — деідентифікований, як і на сервері: з
 * прізвищами файл їде лише за вибором «Повний», зробленим руками. «Дані,
 * CSV» профіль не застосовує (так сервер), і плитка про це каже.
 */

type Profile = "full" | "deidentified" | "anonymous";

interface ExportFile {
  key: string;
  icon: ReactNode;
  title: UiKey;
  hint: UiKey;
  name: string;
  url: (surveyId: string, profile: Profile, purpose: string) => string;
}

const FILES: ExportFile[] = [
  { key: "csv", icon: <Mi.sheet size={17} />, title: "an.dataCsv", hint: "mc.exCsvHint", name: "data.csv", url: (id) => api.exportUrl(id) },
  { key: "spss", icon: <Mi.table size={17} />, title: "an.spssMatrix", hint: "mc.exSpssHint", name: "spss-data.csv", url: (id, p) => api.spssDataUrl(id, p) },
  { key: "sps", icon: <Mi.fileCode size={17} />, title: "an.spssSyntax", hint: "mc.exSyntaxHint", name: "syntax.sps", url: (id, p) => api.spssSyntaxUrl(id, p) },
  { key: "codebook", icon: <Mi.bookOpen size={17} />, title: "an.codebook", hint: "mc.exCodebookHint", name: "codebook.csv", url: (id, p) => api.codebookUrl(id, p) },
  { key: "long", icon: <Mi.rows size={17} />, title: "an.long", hint: "mc.exLongHint", name: "long.csv", url: (id, p) => api.longUrl(id, p) },
  { key: "manifest", icon: <Mi.fileJson size={17} />, title: "rep.manifest", hint: "mc.exManifestHint", name: "manifest.json", url: (id, p, purpose) => api.manifestUrl(id, p, purpose) },
  { key: "r", icon: <Mi.fileCode size={17} />, title: "ant.scriptR", hint: "mc.exRHint", name: "load.r", url: (id, p) => api.loadScriptUrl(id, "r", p) },
  { key: "py", icon: <Mi.fileCode size={17} />, title: "ant.scriptPy", hint: "mc.exPyHint", name: "load.py", url: (id, p) => api.loadScriptUrl(id, "py", p) },
];

export function ExportsDrawer({
  open,
  onClose,
  surveyId,
  sub,
  scope,
}: {
  open: boolean;
  onClose: () => void;
  surveyId: string;
  /** «Дані проходжень PHQ-9 для звітів і досліджень» */
  sub: string;
  /** Подпись к файлам: «PHQ-9, 2 184 проходження» */
  scope?: string;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [profile, setProfile] = useState<Profile>("deidentified");
  const [purpose, setPurpose] = useState("");
  const [file, setFile] = useState(FILES[1]!.key);
  const [last, setLast] = useState<{ name: string; at: string } | null>(null);
  const chosen = FILES.find((f) => f.key === file) ?? FILES[0]!;

  const go = () =>
    run(async () => {
      await download(chosen.url(surveyId, profile, purpose.trim()), chosen.name);
      const now = new Date();
      setLast({ name: chosen.name, at: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}` });
    }, ut("mc.exDone").replace("{file}", chosen.name));

  return (
    <Drawer
      open={open}
      onClose={onClose}
      wide
      title={ut("ant.exportsTitle")}
      sub={sub}
      icon={<Mi.fileDown />}
      saved={last ? ut("mc.exLast").replace("{file}", last.name).replace("{time}", last.at) : undefined}
      footer={
        <>
          <Button variant="primary" icon={<Ic.download />} disabled={busy} onClick={() => void go()}>
            {ut("mc.exDownload").replace("{file}", ut(chosen.title))}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {ut("ui.close")}
          </Button>
        </>
      }
    >
      <DrawerSection>
        <Callout kind="info" icon={<Ic.shieldCheck />}>
          {ut("mc.exAudit")}
        </Callout>
        <div className="mt-3">
          <Field label={ut("rep.purpose")} hint={ut("mc.exPurposeHint")}>
            <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder={ut("rep.purposePlaceholder")} maxLength={200} data-autofocus />
          </Field>
        </div>
      </DrawerSection>
      <DrawerSection title={ut("an.profile")}>
        <div role="radiogroup" aria-label={ut("an.profile")} className="flex flex-col gap-1.5">
          {(
            [
              ["full", "an.exportFull", "mc.exFullHint"],
              ["deidentified", "an.exportDeid", "mc.exDeidHint"],
              ["anonymous", "an.exportAnon", "mc.exAnonHint"],
            ] as const
          ).map(([key, title, hint]) => (
            <ChoiceCard
              key={key}
              name="export-profile"
              value={key}
              checked={profile === key}
              onChange={(v) => setProfile(v as Profile)}
              title={ut(title)}
              sub={ut(hint)}
            />
          ))}
        </div>
      </DrawerSection>
      <DrawerSection title={ut("mc.exFiles")} sub={scope}>
        <div role="group" aria-label={ut("mc.exFiles")} className="grid grid-cols-2 gap-2 max-[560px]:grid-cols-1">
          {FILES.map((f) => {
            const on = f.key === file;
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={on}
                onClick={() => setFile(f.key)}
                className={cx(
                  "flex min-h-0 cursor-pointer items-start gap-2.5 rounded-[12px] border-0 px-3 py-2.5 text-left",
                  "transition-[background-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease)]",
                  on ? "bg-violet-tint shadow-[inset_0_0_0_1.5px_var(--vring)]" : "bg-sunk hover:bg-sunk-2",
                )}
              >
                <span className={cx("mt-px inline-flex", on ? "text-violet-ink" : "text-muted")}>{f.icon}</span>
                <span className="min-w-0">
                  <b className={cx("block text-[13px] font-extrabold leading-[18px]", on ? "text-violet-ink" : "text-text")}>{ut(f.title)}</b>
                  <small className="block text-caption text-muted">{ut(f.hint)}</small>
                  <code className="mt-1 block whitespace-nowrap font-mono text-[11px] font-bold leading-[14px] text-muted">{f.name}</code>
                </span>
              </button>
            );
          })}
        </div>
        <p className="m-0 mt-2.5 text-small text-muted">{ut("mc.exNote")}</p>
      </DrawerSection>
    </Drawer>
  );
}
