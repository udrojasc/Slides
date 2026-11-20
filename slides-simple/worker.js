const ALLOWED_ORIGINS = new Set([
  "https://udrojasc.github.io"
]);

const json = (data, status = 200, origin = "") => new Response(JSON.stringify(data), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  }
});

function makeId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function validatePresentation(input) {
  if (!input || typeof input !== "object") throw new Error("Cuerpo inválido.");
  const name = String(input.n ?? input.name ?? "Mi presentación").trim().slice(0, 80) || "Mi presentación";
  const source = Array.isArray(input.s) ? input.s : input.slides;
  if (!Array.isArray(source) || source.length < 1 || source.length > 200) {
    throw new Error("La presentación debe contener entre 1 y 200 slides.");
  }

  const slides = source.map((item) => {
    const urlValue = Array.isArray(item) ? item[0] : item?.url;
    const durationValue = Array.isArray(item) ? item[1] : item?.duration;
    let parsed;
    try { parsed = new URL(String(urlValue || "")); }
    catch { throw new Error("Una de las URL no es válida."); }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Solo se permiten URL HTTP o HTTPS.");
    }
    const duration = Math.max(2, Math.min(3600, Number(durationValue) || 15));
    return [parsed.href, duration];
  });

  return { v: 1, n: name, s: slides };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = !origin || ALLOWED_ORIGINS.has(origin);

    if (!allowedOrigin) {
      return new Response("Origin not allowed", { status: 403 });
    }

    const corsOrigin = origin || "https://udrojasc.github.io";
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin"
        }
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "SLIDES SIMPLE API", storage: "Workers KV" }, 200, corsOrigin);
    }

    if (request.method === "POST" && url.pathname === "/api/slides") {
      try {
        const length = Number(request.headers.get("Content-Length") || 0);
        if (length > 100000) return json({ error: "La presentación supera el tamaño permitido." }, 413, corsOrigin);

        const input = await request.json();
        const data = validatePresentation(input);
        const serialized = JSON.stringify(data);
        if (new TextEncoder().encode(serialized).byteLength > 100000) {
          return json({ error: "La presentación supera los 100 KB permitidos." }, 413, corsOrigin);
        }

        const id = makeId();
        await env.SLIDES_KV.put("s:" + id, serialized);
        return json({ id, slides: data.s.length }, 201, corsOrigin);
      } catch (error) {
        const status = error instanceof SyntaxError ? 400 : 422;
        return json({ error: error?.message || "No se pudo guardar la presentación." }, status, corsOrigin);
      }
    }

    const match = url.pathname.match(/^\/api\/slides\/([A-Za-z0-9_-]{10,12})$/);
    if (request.method === "GET" && match) {
      try {
        const value = await env.SLIDES_KV.get("s:" + match[1]);
        if (!value) return json({ error: "Presentación no encontrada." }, 404, corsOrigin);
        return json(JSON.parse(value), 200, corsOrigin);
      } catch {
        return json({ error: "No se pudo leer el almacenamiento." }, 500, corsOrigin);
      }
    }

    return json({ error: "Ruta no encontrada." }, 404, corsOrigin);
  }
};
