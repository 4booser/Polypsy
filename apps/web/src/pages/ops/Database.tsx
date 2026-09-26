import { useLang } from "../../lang";

/* Заготовка вкладки техпанели: содержимое пишет сборщик своего участка (волна 10). */
export default function OpsDatabase() {
  const { ut } = useLang();
  return <p className="m-0 py-[24px] text-[13px] text-muted">{ut("ops.soon")}</p>;
}
