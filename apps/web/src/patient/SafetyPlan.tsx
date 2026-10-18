import type { SafetyPlan } from "@quizzy/shared";
import { useLang } from "../lang";
import { Drawer } from "../ui";
import { Glyph } from "./icons";
import { dm } from "./when";

/**
 * Свой план безопасности — для чтения, в ящике (kit: «Мій план безпеки»).
 *
 * План составляет фахівець вместе с человеком (components/SafetyPlanEditor),
 * а здесь человек открывает его сам — в ту минуту, когда он нужен. Разделы
 * те же и в том же порядке, что в редакторе: признаки, что делать самому,
 * что отвлекает, к кому обратиться, специалисты, средства, ради чего.
 * Пустые разделы не рисуются. Контакт, похожий на номер, — ссылкой tel:.
 */
export function SafetyPlanDrawer({ plan, open, onClose }: { plan: SafetyPlan; open: boolean; onClose: () => void }) {
  const { ut } = useLang();
  const c = plan.content;
  const lists: { key: string; title: string; items: string[] }[] = [
    { key: "signs", title: ut("sp.warningSigns"), items: c.warningSigns },
    { key: "coping", title: ut("sp.coping"), items: c.copingStrategies },
    { key: "distract", title: ut("sp.distractions"), items: c.distractions },
  ];
  const contacts: { key: string; title: string; items: { name: string; contact: string }[] }[] = [
    { key: "people", title: ut("sp.people"), items: c.people },
    { key: "pros", title: ut("sp.professionals"), items: c.professionals },
  ];
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={ut("sp.title")}
      sub={`${ut("ptw.planFrom")} ${dm(plan.createdAt)}, ${plan.authorName}`}
      icon={<Glyph name="heart-handshake" size={18} />}
    >
      <div className="flex flex-col gap-5 pb-5 pt-3 text-[16px] leading-6">
        {lists
          .filter((l) => l.items.some((x) => x.trim()))
          .map((l) => (
            <section key={l.key}>
              <h3 className="m-0 text-[15px] font-extrabold leading-[21px] text-text">{l.title}</h3>
              <ul className="m-0 mt-1.5 flex list-disc flex-col gap-1 pl-5 text-text-2">
                {l.items
                  .filter((x) => x.trim())
                  .map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
              </ul>
            </section>
          ))}
        {contacts
          .filter((g) => g.items.some((p) => p.name.trim() || p.contact.trim()))
          .map((g) => (
            <section key={g.key}>
              <h3 className="m-0 text-[15px] font-extrabold leading-[21px] text-text">{g.title}</h3>
              <ul className="m-0 mt-1.5 flex list-none flex-col p-0">
                {g.items
                  .filter((p) => p.name.trim() || p.contact.trim())
                  .map((p, i) => {
                    const phone = /^[+\d][\d\s()-]{2,}$/.test(p.contact.trim());
                    return (
                      <li key={i} className="flex items-center justify-between gap-3 border-t border-divider py-2.5 first:border-t-0">
                        <span className="min-w-0 font-bold text-text">{p.name}</span>
                        {phone ? (
                          <a
                            href={`tel:${p.contact.replace(/[^\d+]/g, "")}`}
                            className="shrink-0 font-extrabold tabular-nums text-violet-ink no-underline hover:underline"
                          >
                            {p.contact}
                          </a>
                        ) : (
                          <span className="shrink-0 text-text-2">{p.contact}</span>
                        )}
                      </li>
                    );
                  })}
              </ul>
            </section>
          ))}
        {c.meansRestriction.trim() ? (
          <section>
            <h3 className="m-0 text-[15px] font-extrabold leading-[21px] text-text">{ut("sp.means")}</h3>
            <p className="m-0 mt-1.5 whitespace-pre-wrap text-text-2">{c.meansRestriction}</p>
          </section>
        ) : null}
        {c.reasonsToLive.some((x) => x.trim()) ? (
          <section className="rounded-panel bg-violet-tint px-4 py-3.5">
            <h3 className="m-0 text-[15px] font-extrabold leading-[21px] text-violet-ink">{ut("sp.reasons")}</h3>
            <ul className="m-0 mt-1.5 flex list-disc flex-col gap-1 pl-5 text-text">
              {c.reasonsToLive
                .filter((x) => x.trim())
                .map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Drawer>
  );
}
