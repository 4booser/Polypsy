import { View } from "react-native";
import { useColors, useIsDark } from "../../theme";
import { T } from "../../ui/Text";

/** Инициалы из полного имени: «Савчук Ірина Олегівна» → «ІС» — имя, потом фамилия, как на кнопке в наборе */
export function initialsOf(fullName: string | null | undefined): string {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  // в учётной записи имя хранится «Фамилия Имя Отчество» — инициалы читаются «Имя Фамилия»
  return `${parts[1]![0] ?? ""}${parts[0]![0] ?? ""}`.toUpperCase();
}

/**
 * Имя для чтения: «Савчук Ірина Олегівна» → «Ірина Савчук». В учётной
 * записи имя хранится фамилией вперёд — так его ищут в списках, — а человеку
 * специалиста называют по имени. Код под псевдонимом («Респондент А-4821»)
 * остаётся как есть: в нём нет ни имени, ни фамилии.
 */
export function personName(fullName: string | null | undefined): string {
  const full = (fullName ?? "").trim();
  if (/\d/.test(full)) return full;
  const parts = full.split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? `${parts[1]} ${parts[0]}` : full;
}

/** Имя без фамилии — для приветствия: «Добрий вечір, Андрію» звучит, «…, Мельник Андрій» нет */
export function firstNameOf(fullName: string | null | undefined, firstName?: string | null): string {
  if (firstName?.trim()) return firstName.trim();
  const full = (fullName ?? "").trim();
  if (/\d/.test(full)) return "";
  return full.split(/\s+/)[1] ?? "";
}

/**
 * Кружок с инициалами — человек без фотографии. Залитый фиолетовым — свой
 * специалист и сам человек; мягкий — остальные в выборе.
 */
export function Avatar({ name, size = 34, soft }: { name: string; size?: 28 | 34 | 44 | 56; soft?: boolean }) {
  const c = useColors();
  const dark = useIsDark();
  const ring = size >= 44;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: soft ? c.vtint : dark ? c.vink : c.v,
        boxShadow: ring ? `0px 0px 0px 3px ${c.vtint}` : undefined,
      }}
    >
      <T
        v="caption"
        size={size >= 56 ? 19 : size >= 44 ? 15 : size >= 34 ? 13 : 11}
        weight={800}
        color={soft ? c.vink : dark ? c.ground : c.onfill}
        scale={false}
        style={{ lineHeight: size >= 44 ? 18 : 15 }}
      >
        {initialsOf(name)}
      </T>
    </View>
  );
}
