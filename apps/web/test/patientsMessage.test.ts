import { describe, expect, test } from "bun:test";
import { EMPTY_MESSAGE, messageDraft, type MessageDraft } from "../src/pages/patients/actions";

/**
 * «Написати» из реестра пациентов: черновик — того, кому его писали
 * (волна 26, клинический разбор).
 *
 * Ящик реестра хранит набранное и после Esc. Пока черновик был один на
 * ящик, «Написати» у другого человека открывалось с письмом, набранным
 * первому, и «Надіслати» уносило его не тому пациенту.
 */
describe("черновик письма — при адресате", () => {
  const typed: MessageDraft = { to: "patient-a", text: "Олено, перенесемо сесію на четвер?", error: null };

  test("тот же адресат — его черновик и его отказ", () => {
    expect(messageDraft(typed, "patient-a")).toBe(typed);
    const failed = { ...typed, error: "Не вдалося надіслати" };
    expect(messageDraft(failed, "patient-a").error).toBe("Не вдалося надіслати");
  });

  test("другой адресат — пустое поле, а не чужое письмо", () => {
    expect(messageDraft(typed, "patient-b")).toEqual({ to: "patient-b", text: "", error: null });
  });

  test("ящик без адресата — пусто; пустая заготовка ничья", () => {
    expect(messageDraft(typed, null).text).toBe("");
    expect(messageDraft(EMPTY_MESSAGE, "patient-a")).toEqual({ to: "patient-a", text: "", error: null });
  });
});
