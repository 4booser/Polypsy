import { useState } from "react";
import { Pressable, View } from "react-native";
import { useLang } from "../../lang";
import { radius, useColors } from "../../theme";
import { HelpSheet } from "../../ui/HelpSheet";
import { Squircle } from "../../ui/Panel";
import { T } from "../../ui/Text";

/**
 * «Потрібна допомога зараз?» — строка с номером телефона доверия внизу
 * экранов входа, замка, согласия и перед методикой. Открывает тот же лист,
 * что «Допомога» в шапке: номера звонят сразу, 103 — красным.
 *
 * На экранах до входа и без согласия она тоже есть: телефон доверия не
 * требует учётной записи, и человек в кризисе не должен сначала
 * регистрироваться.
 */
export function CrisisStrip({ note }: { note?: string }) {
  const c = useColors();
  const { ut } = useLang();
  const [open, setOpen] = useState(false);
  const number = ut("home.hotlineNumber");
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${ut("mpt.crisisAsk")} ${ut("home.hotline")}, ${number}`}
        accessibilityHint={note}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          minHeight: 64,
          marginTop: 16,
          marginHorizontal: 16,
          paddingVertical: 10,
          paddingLeft: 14,
          paddingRight: 12,
          borderRadius: radius.panel,
          borderWidth: 1,
          borderColor: pressed ? c.ctl : c.border,
          backgroundColor: pressed ? c.panel2 : c.panel,
        })}
      >
        <Squircle icon="phone" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T v="headline">{ut("mpt.crisisAsk")}</T>
          <T v="sub">{note ?? `${ut("home.hotline")}, ${ut("mui.hotlineSub")}`}</T>
        </View>
        <T v="headline" size={20} color={c.vink} num scale={false}>
          {number}
        </T>
      </Pressable>
      <HelpSheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}
