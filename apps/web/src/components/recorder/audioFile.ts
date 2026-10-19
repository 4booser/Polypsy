/** Имя файла в форме — по типу; сервер ему не верит (смотрит в байты), но в журналах так понятнее */
export function audioFileName(type: string): string {
  if (type.includes("ogg")) return "visit.ogg";
  if (type.includes("mp4")) return "visit.m4a";
  if (type.includes("wav")) return "visit.wav";
  return "visit.webm";
}
