import { Text, type TextProps, type TextStyle } from "react-native";
import { font, type Weight } from "../fonts";
import { useTextScale } from "../textScale";
import { type Colors, type as typeScale, useColors } from "../theme";

/**
 * Текст «Виразной»: Manrope, шкала телефона, цвет из темы.
 *
 * Вариант задаёт размер, межстрочный и начертание сразу — экран выбирает
 * роль строки («заголовок строки», «подпись»), а не набор чисел, и две строки
 * одной роли на разных экранах не расходятся на пиксель.
 *
 * Укрупнение текста (textScale) действует на всё, что читают: тело, вопрос,
 * подписи. Шапку и вкладки оно не трогает — их не читают, а узнают, и
 * крупная шапка съела бы место у самого вопроса.
 */
export type TVariant =
  | "largeTitle"
  | "question"
  | "sheetTitle"
  | "section"
  | "navTitle"
  | "headline"
  | "body"
  | "lead"
  | "note"
  | "sub"
  | "caption"
  | "number";

type Tone = "text" | "text2" | "muted" | "vink" | "riskink" | "warn" | "good" | "info" | "onfill" | "tipink";

const STYLE: Record<TVariant, () => TextStyle> = {
  largeTitle: () => typeScale.largeTitle,
  question: () => typeScale.question,
  sheetTitle: () => typeScale.sheetTitle,
  section: () => typeScale.section,
  navTitle: () => typeScale.navTitle,
  headline: () => typeScale.headline,
  body: () => typeScale.body,
  lead: () => typeScale.lead,
  note: () => typeScale.note,
  sub: () => typeScale.sub,
  caption: () => typeScale.caption,
  number: () => ({ ...typeScale.number, fontVariant: ["tabular-nums"] }),
};

const TONE: Partial<Record<TVariant, Tone>> = { lead: "text2", note: "text2", sub: "muted", caption: "muted" };

/** Шапка и вкладки не укрупняются: их узнают, а не читают */
const FIXED: ReadonlySet<TVariant> = new Set(["largeTitle", "navTitle"]);

export function T({
  v = "body",
  tone,
  color,
  weight,
  size,
  num,
  center,
  scale,
  style,
  children,
  ...rest
}: TextProps & {
  v?: TVariant;
  /** Цвет из темы по роли; color — готовое значение, для выраженности и графиков */
  tone?: Tone;
  color?: string;
  weight?: Weight;
  /** Кегль поверх варианта; межстрочный растёт пропорционально */
  size?: number;
  /** Моноширинные цифры: баллы, счётчики, время */
  num?: boolean;
  center?: boolean;
  /** false — не укрупнять, даже если вариант обычно укрупняется */
  scale?: boolean;
}) {
  const c = useColors();
  const { fs } = useTextScale();
  const base = STYLE[v]();
  const grow = scale ?? !FIXED.has(v);
  const fontSize = size ?? (base.fontSize as number);
  const ratio = (base.lineHeight as number) / (base.fontSize as number);
  const px = grow ? fs(fontSize) : fontSize;
  const ink = color ?? c[(tone ?? TONE[v] ?? "text") as keyof Colors];

  return (
    <Text
      {...rest}
      style={[
        base,
        weight ? font(weight) : null,
        { fontSize: px, lineHeight: Math.round(px * ratio), color: ink },
        num ? { fontVariant: ["tabular-nums"] } : null,
        center ? { textAlign: "center" } : null,
        style,
      ]}
    >
      {children}
    </Text>
  );
}
