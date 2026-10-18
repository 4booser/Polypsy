import { View } from "react-native";
import { useRouter } from "expo-router";
import type { Sex, UiKey, WorkItem } from "@quizzy/shared";
import { useLang } from "../lang";
import { T } from "../ui/Text";
import { Avatar, Chip, type ChipKind } from "./ui";
import type { IconName } from "../ui/Icon";

/*
 * Шапка человека и строка открытого по нему — общие для карты у койки и
 * карты пациента.
 */

/** Аватар 56, имя, возраст и пол, подразделение — на полосе под строкой навигации */
export function PatientHead({ name, age, sex, extra }: { name: string; age: number | null; sex: Sex | null; extra?: string | null }) {
  const { ut } = useLang();
  const facts = [
    age !== null ? ut("mst.age").replace("{n}", String(age)) : null,
    sex === "male" ? ut("mst.sexMale") : sex === "female" ? ut("mst.sexFemale") : null,
    extra ?? null,
  ].filter(Boolean);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingTop: 4 }}>
      <Avatar name={name} size={56} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T v="sheetTitle" accessibilityRole="header">
          {name}
        </T>
        {facts.length ? (
          <T v="sub" size={15} tone="text2" style={{ marginTop: 2 }}>
            {facts.join(", ")}
          </T>
        ) : null}
      </View>
    </View>
  );
}

const ICON: Record<WorkItem["kind"], IconName> = {
  noshow: "calendar-x-2",
  message: "message-square-text",
  followup: "clipboard-check",
  assignment: "clipboard-list",
  dispensary: "calendar-clock",
  referral: "file-text",
};

/**
 * Всё открытое по человеку одной строкой плашек, у каждой — своё: письмо
 * ведёт в переписку, остальное говорит, что и насколько просрочено.
 * Жёлтое — внимание (неявка, просрочка), а не риск.
 */
export function WorkStrip({ items }: { items: readonly WorkItem[] }) {
  const { ut } = useLang();
  const router = useRouter();
  if (!items.length) return null;
  return (
    <View accessibilityLabel={ut("mst.openItems")} style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginHorizontal: 16, marginTop: 12 }}>
      {items.map((i) => {
        const kind: ChipKind = i.kind === "message" ? "msg" : i.overdue ? "warn" : "n";
        const label =
          i.kind === "message" || i.kind === "noshow" || i.kind === "referral" ? ut(`mst.kind.${i.kind}`) : i.title;
        const detail =
          i.kind === "message"
            ? ut("mst.unreadN").replace("{n}", String(i.signals ?? 1))
            : i.kind === "referral"
              ? i.destination
                ? ut(`dest.${i.destination}` as UiKey, i.destination)
                : undefined
              : i.overdue
                ? ut("mst.overdueDays").replace("{n}", String(i.days ?? 0))
                : undefined;
        return (
          <Chip
            key={`${i.kind}:${i.id}`}
            kind={kind}
            icon={ICON[i.kind]}
            label={label}
            detail={detail}
            onPress={i.kind === "message" ? () => router.push(`/inbox/${i.userId}`) : undefined}
          />
        );
      })}
    </View>
  );
}
