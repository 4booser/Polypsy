import { describe, expect, test } from "bun:test";
import { SMTP_TIMEOUTS, smtpTransport } from "../src/lib/notify";

/**
 * Таймауты SMTP-транспорта действительно выставлены (lib/notify.ts).
 *
 * До nodemailer 10 они передавались вторым аргументом createTransport(url, …)
 * — а это умолчания письма, не настройки соединения, — и транспорт их
 * отбрасывал: зависший почтовый сервер держал соединение пула десять минут
 * (умолчание nodemailer), ровно от чего таймауты и должны были защищать.
 * Сторож читает настройки самого SMTP-транспорта, а не то, что мы думали,
 * что передали.
 */

interface SmtpOptions {
  host?: string;
  port?: number;
  secure?: boolean;
  connectionTimeout?: number;
  greetingTimeout?: number;
  socketTimeout?: number;
}

function optionsOf(url: string): SmtpOptions {
  const mail = smtpTransport(url) as unknown as { transporter: { options: SmtpOptions } };
  return mail.transporter.options;
}

describe("SMTP-транспорт", () => {
  test("таймауты из SMTP_TIMEOUTS стоят на транспорте, а не потеряны", () => {
    const options = optionsOf(`smtp://user%40example.test:secret@mail-${crypto.randomUUID().slice(0, 8)}.example.test:587`);
    expect(options.connectionTimeout).toBe(SMTP_TIMEOUTS.connectionTimeout);
    expect(options.greetingTimeout).toBe(SMTP_TIMEOUTS.greetingTimeout);
    expect(options.socketTimeout).toBe(SMTP_TIMEOUTS.socketTimeout);
    // сокетный таймаут короче минутного тика: зависший сервер не копит проходы
    expect(SMTP_TIMEOUTS.socketTimeout).toBeLessThan(60_000);
  });

  test("адрес разобран: хост, порт и TLS из smtps://", () => {
    const host = `smtp-${crypto.randomUUID().slice(0, 8)}.example.test`;
    const options = optionsOf(`smtps://u:p@${host}:465`);
    expect(options.host).toBe(host);
    expect(options.port).toBe(465);
    expect(options.secure).toBe(true);
  });
});
