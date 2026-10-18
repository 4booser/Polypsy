/**
 * Компоненты «Виразной» для телефона — один вход.
 *
 * Экран собирают из них, а не из голых View и Text: тогда два экрана одной
 * роли не расходятся на пиксель, а смена токена доходит до всех сразу.
 * Прежние имена (Card, Title, Body, Button…) живут в components/ui.tsx и
 * рисуются этими же компонентами.
 */
export { T, type TVariant } from "./Text";
export { Icon, type IconName } from "./Icon";
export { Btn, ActionBar, TARGET, type BtnKind, type BtnSize } from "./Button";
export { Panel, SectionHead, List, ListRow, Callout, Squircle, toneColors, type Tone } from "./Panel";
export { AnswerTile } from "./AnswerTile";
export { Pill, SevPill, Count, FilterChip, type PillKind } from "./Pill";
export { Segmented } from "./Segmented";
export { Field } from "./Field";
export { SettingRow, SwitchRow, CallRow } from "./Rows";
export { BottomSheet } from "./Sheet";
export { ToastProvider, useToast } from "./Toast";
export { ProgressSegments, SEGMENTS_MAX } from "./Progress";
export { BigValue } from "./BigValue";
export { NavBar, BackButton, NavTextButton, HelpPill } from "./NavBar";
export { HelpSheet } from "./HelpSheet";
export { TabBar } from "./TabBar";
export { StackHeader, TabHeader } from "./headers";
