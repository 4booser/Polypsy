/**
 * Заглушка S3 для проверки scripts/offsite.sh: PUT, HEAD, GET объекта и
 * ListObjectsV2 на одной корзине в памяти. Подпись SigV4 не проверяется
 * (её проверит настоящее хранилище), но заголовок Authorization обязан
 * быть — иначе скрипт мог бы «работать» и без ключей.
 *
 *   bun scripts/test/offsite-stub.ts <порт>
 */
const port = Number(process.argv[2] ?? 0);
const objects = new Map<string, Uint8Array>();

function xml(items: [string, number][]): string {
  const body = items
    .map(([k, n]) => `<Contents><Key>${k}</Key><Size>${n}</Size></Contents>`)
    .join("");
  return `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${body}</ListBucketResult>`;
}

const server = Bun.serve({
  port,
  async fetch(req) {
    if (!req.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256")) {
      return new Response("no signature", { status: 403 });
    }
    const url = new URL(req.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\/?/, ""));
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      return new Response(xml([...objects].map(([k, v]) => [k, v.byteLength])), {
        headers: { "content-type": "application/xml" },
      });
    }
    if (req.method === "PUT") {
      objects.set(key, new Uint8Array(await req.arrayBuffer()));
      return new Response("", { status: 200 });
    }
    const obj = objects.get(key);
    if (!obj) return new Response("", { status: 404 });
    if (req.method === "HEAD") return new Response("", { headers: { "content-length": String(obj.byteLength) } });
    if (req.method === "GET") return new Response(obj);
    return new Response("", { status: 405 });
  },
});
console.log(`stub ${server.port}`);
