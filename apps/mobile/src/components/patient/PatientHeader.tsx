import type { ReactNode } from "react";
import type { BottomTabHeaderProps } from "expo-router/js-tabs";
import { useLang } from "../../lang";
import { useColors } from "../../theme";
import { BackButton, HelpPill, NavBar } from "../../ui/NavBar";
import { OfflineBar } from "../OfflineBar";

type HeaderSlot = ((props: { canGoBack: boolean; tintColor?: string }) => ReactNode) | undefined;

/**
 * Шапка экранов пациента: только строка навигации на полосе — «Допомога»
 * справа, «‹ Назад» у экранов-не-вкладок. Крупный заголовок экран рисует
 * сам, внутри прокрутки (Hero), как в утверждённом экране методики: под ним
 * на той же полосе стоят подзаголовок, переключатель, строка открытого —
 * и всё это прокручивается вместе, а не съедает треть экрана навсегда.
 *
 * Полоса «нет связи» — под строкой навигации, на любой вкладке. У
 * экранов-не-вкладок (переписка, план, очередь) её нет: с очереди она вела
 * бы на саму себя.
 */
export function PatientHeader({ navigation, options, help }: BottomTabHeaderProps & { help?: boolean }) {
  const c = useColors();
  const { ut } = useLang();
  const right = (options.headerRight as HeaderSlot)?.({ canGoBack: false, tintColor: c.vink }) ?? (help ? <HelpPill /> : null);
  const hidden = (options.tabBarItemStyle as { display?: string } | undefined)?.display === "none";
  if (hidden) {
    return <NavBar flush left={<BackButton label={ut("common.back")} onPress={() => navigation.goBack()} />} right={right} />;
  }
  return <NavBar flush right={right} below={<OfflineBar />} />;
}
