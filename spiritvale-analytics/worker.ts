const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
} as const;

function withHeaders(response: Response, pathname: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);

  if (pathname === "/api/data" || pathname === "/data.json") {
    headers.set("Cache-Control", "public, max-age=60, s-maxage=900, stale-while-revalidate=3600");
  } else if (pathname.startsWith("/assets/fonts/")) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else if (headers.get("Content-Type")?.includes("text/html")) {
    headers.set("Cache-Control", "no-cache");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/robots.txt") {
      return withHeaders(new Response("User-agent: *\nDisallow: /\n", {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
      }), url.pathname);
    }

    if (url.pathname === "/health") {
      return withHeaders(Response.json({ name: "spiritvale-analytics", status: "ok" }, {
        headers: { "Cache-Control": "no-store" },
      }), url.pathname);
    }

    if (url.pathname === "/api/data") {
      const assetUrl = new URL("/data.json", url);
      const assetRequest = new Request(assetUrl, request);
      return withHeaders(await env.ASSETS.fetch(assetRequest), url.pathname);
    }

    return withHeaders(await env.ASSETS.fetch(request), url.pathname);
  },
} satisfies ExportedHandler<Env>;
