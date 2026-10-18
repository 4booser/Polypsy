/*
 * Рабочее место вошедшего — вопрос карточки человека, а не навигации.
 *
 * Жило в Topbar.tsx рядом с составом верхней полосы: от рабочего места
 * когда-то зависела и полоса. Полосы больше нет (Polypsy 2.0: полоса
 * приложения и рельса), а рабочее место осталось нужным карточке человека
 * (StaffCard: что лежит под карточкой и чем она подписана — cardTitleRole).
 *
 * Четыре вида:
 *
 *   specialist   — рядовой лікар: раздела людей у него нет вовсе (f04);
 *   admin        — заведующий, у которого есть И свои пациенты, И свои
 *                  лікарі (f30, f31, f34, f35), а также суперадмін вне
 *                  раздела людей;
 *   peopleStaff  — раздел людей у того, кто ведёт людей и не лечит (f40,
 *                  f41, f42, f43), и раздел организаций у суперадміна (f44,
 *                  f45, f51, f52);
 *   peopleAdmins — раздел людей у суперадміна (f47, f48, f49, f50).
 *
 * «Лечит» — право видеть пациентов, а не ступень: главный лікар (chief)
 * лечит, хотя стоит высоко.
 */
export type BarKind = "specialist" | "admin" | "peopleStaff" | "peopleAdmins";

/**
 * Раздел экрана в том смысле, в каком его различают кадры. По корню
 * адреса, а не по вхождению строки: «/patients/staff» — не раздел людей.
 */
export function barSection(pathname: string): "people" | "organisations" | "other" {
  const at = (root: string) => pathname === root || pathname.startsWith(`${root}/`);
  if (at("/staff") || at("/admins")) return "people";
  if (at("/organisations")) return "organisations";
  return "other";
}

/**
 * Какое рабочее место у вошедшего на этом экране.
 *
 * `treats` — «видит пациентов»: право users.manage у заведующего и у чистого
 * администратора одно и то же, а patients.read их и разделяет.
 */
export function barKind(
  user: { role?: string | null; ladderRank?: number | null } | null | undefined,
  treats: boolean,
  pathname: string,
): BarKind {
  const section = barSection(pathname);
  if (user?.role === "superadmin") {
    /* f47–f50 против f44/f45/f51/f52: у одного человека два рабочих места, и выбирает раздел */
    if (section === "people") return "peopleAdmins";
    if (section === "organisations") return "peopleStaff";
    return "admin";
  }
  const managesPeople = (user?.ladderRank ?? 0) > 1;
  /* f40–f43: ведёт людей, но не лечит — и только в разделе людей, других кадров нет */
  if (managesPeople && !treats && section !== "other") return "peopleStaff";
  return managesPeople ? "admin" : "specialist";
}
