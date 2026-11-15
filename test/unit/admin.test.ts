import { afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi, type Mock } from "vitest";
import { forgetKeys, validAccessToken } from "../../src/access";
import { AdminEnv, handle } from "../../src/index";
const HOUR = 36e5;

const TEAM = "team.cloudflareaccess.com", AUD = "aud-1", NOW = Date.UTC(2026, 10, 7, 12);
const SECONDS = NOW / 1000;
const b64 = (data: string | ArrayBuffer) => btoa(typeof data === "string" ? data : String.fromCharCode(...new Uint8Array(data))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let keys: CryptoKeyPair, otherKeys: CryptoKeyPair, jwk: JsonWebKey;
const newKeys = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;

async function token(claims: Record<string, unknown> = {}, opts: { key?: CryptoKey; alg?: string; kid?: string } = {}) {
  const head = b64(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1" }));
  const body = b64(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, exp: SECONDS + 3600, nbf: SECONDS - 60, ...claims }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(sig)}`;
}

// ---------- stand-ins for PLATFORM ----------

type Platform = AdminEnv["PLATFORM"];
const METHODS = ["summary", "overview", "users", "content", "dataSources", "jobs"] as const;
type Method = typeof METHODS[number];


/** What each recording method answers: fixed values, nothing like the real data, so a passed-through body is plain to see. */
const FIXED: Record<Method, unknown> = {
  summary: { members: 41, fixed: "summary" },
  overview: { range: "7d", labels: ["fixed"], fixed: "overview" },
  users: { users: [{ id: "fixed-user" }], total: 1, pageSize: 100 },
  content: { items: [{ id: "fixed-item" }], total: 1, limit: 321 },
  dataSources: { feeds: [], sources: [{ name: "fixed" }] },
  jobs: { jobs: [{ name: "fixed job" }] },
};

/** Six vi.fn, each answering its FIXED value. */
function recording() {
  const fns = Object.fromEntries(METHODS.map(m => [m, vi.fn(async (..._args: unknown[]) => FIXED[m])])) as Record<Method, Mock<(...args: unknown[]) => Promise<unknown>>>;
  const calls = () => METHODS.reduce((n, m) => n + fns[m].mock.calls.length, 0);
  return { fns, calls, platform: fns as unknown as Platform };
}

/** Every method rejects with the error made by `make` (a message makes a plain Error). */
const throwing = (make: string | (() => unknown)): Platform =>
  Object.fromEntries(METHODS.map(m => [m, async () => { throw typeof make === "string" ? new Error(make) : make(); }])) as unknown as Platform;

const assets = { fetch: async () => new Response("<!doctype html>the page", { headers: { "content-type": "text/html" } }) } as unknown as Fetcher;
const configured = (platform: Platform = recording().platform): AdminEnv => ({ PLATFORM: platform, ASSETS: assets, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
const req = (path: string, init: RequestInit = {}, host = "https://admin.talkhalifax.ca") => new Request(host + path, init);
const asDev = (path: string, platform: Platform = recording().platform) => handle(req(path, {}, "http://localhost:8790"), { PLATFORM: platform, ASSETS: assets, ADMIN_DEV: "1" }, NOW);
const data = async <T = any>(path: string) => (await asDev(path)).json() as Promise<T>;
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

/** The methods use Date.now(), so the data tests pin it to NOW. */
const freezeClock = () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); };

beforeAll(async () => {
  keys = await newKeys();
  otherKeys = await newKeys();
  jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey), kid: "k1" } as JsonWebKey;
});
beforeEach(() => {
  forgetKeys();
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) throw new Error(`Unexpected request to ${url}`);
    return Response.json({ keys: [jwk] });
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the admin site's front door", () => {
  it("refuses everyone when Access isn't configured, pages and data alike", async () => {
    const bare: AdminEnv = { PLATFORM: recording().platform, ASSETS: assets };
    for (const path of ["/", "/admin.js", "/api/users"]) expect((await handle(req(path), bare, NOW)).status).toBe(503);
    expect((await handle(req("/"), { ...bare, ACCESS_TEAM_DOMAIN: TEAM }, NOW)).status).toBe(503);
  });
  it("refuses a request with no token, including the page itself", async () => {
    for (const path of ["/", "/admin.js", "/api/users", "/api/summary"]) expect((await handle(req(path), configured(), NOW)).status).toBe(403);
  });
  it("lets through a token Access signed for this application", async () => {
    const r = await handle(req("/", { headers: { "cf-access-jwt-assertion": await token() } }), configured(), NOW);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("the page");
  });
  it("refuses a token signed by anyone else", async () => {
    const t = await token({}, { key: otherKeys.privateKey });
    expect((await handle(req("/", { headers: { "cf-access-jwt-assertion": t } }), configured(), NOW)).status).toBe(403);
  });
  it("refuses a token for another application, from another team, or out of date", async () => {
    expect(await validAccessToken(await token({ aud: ["someone-else"] }), TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken(await token({ iss: "https://evil.cloudflareaccess.com" }), TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken(await token({ exp: SECONDS - 3600 }), TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken(await token({ nbf: SECONDS + 3600 }), TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken(await token({ exp: undefined }), TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken(await token(), TEAM, AUD, NOW)).toBe(true);
  });
  it("refuses a token that picks its own algorithm, or that's nonsense", async () => {
    expect(await validAccessToken(await token({}, { alg: "none" }), TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken(await token({}, { alg: "HS256" }), TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken("not.a.token", TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken("", TEAM, AUD, NOW)).toBe(false);
  });
  it("refuses a tampered token", async () => {
    const [h, , s] = (await token()).split(".");
    const forged = b64(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, exp: SECONDS + 9999 }));
    expect(await validAccessToken(`${h}.${forged}.${s}`, TEAM, AUD, NOW)).toBe(false);
  });
  it("refuses when Access's keys can't be fetched", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    expect(await validAccessToken(await token(), TEAM, AUD, NOW)).toBe(false);
  });
  it("refuses everyone if the team address isn't an Access team's own", async () => {
    for (const team of ["evil.test", "evil.test/x?", `https://${TEAM}`, `${TEAM}/`, `${TEAM}.evil.test`, "TEAM.cloudflareaccess.com"]) {
      const t = await token();
      expect((await handle(req("/", { headers: { "cf-access-jwt-assertion": t } }), { ...configured(), ACCESS_TEAM_DOMAIN: team }, NOW)).status).toBe(503);
    }
  });
  it("doesn't follow redirects when fetching Access's keys", async () => {
    const seen: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", async (_: string, init?: RequestInit) => { seen.push(init); return Response.json({ keys: [jwk] }); });
    await validAccessToken(await token(), TEAM, AUD, NOW);
    expect(seen[0]?.redirect).toBe("error");
  });
  it("picks up a rotated key, but bad tokens can't force a key fetch on every request", async () => {
    let fetches = 0;
    vi.stubGlobal("fetch", async () => { fetches++; return Response.json({ keys: [jwk] }); });
    const unknown = await token({}, { kid: "nobody" });
    await validAccessToken(unknown, TEAM, AUD, NOW);
    expect(fetches).toBe(1);
    for (let i = 0; i < 5; i++) expect(await validAccessToken(unknown, TEAM, AUD, NOW + i)).toBe(false);
    expect(fetches).toBe(1);
    await validAccessToken(unknown, TEAM, AUD, NOW + 61_000);
    expect(fetches).toBe(2);
  });
  it("keeps the good keys if a refresh comes back empty", async () => {
    expect(await validAccessToken(await token(), TEAM, AUD, NOW)).toBe(true);
    vi.stubGlobal("fetch", async () => Response.json({ keys: [] }));
    expect(await validAccessToken(await token({}, { kid: "nobody" }), TEAM, AUD, NOW + 61_000)).toBe(false);
    expect(await validAccessToken(await token(), TEAM, AUD, NOW + 62_000)).toBe(true);
  });
  it("only skips the check for a local run, never on the real address", async () => {
    const dev: AdminEnv = { PLATFORM: recording().platform, ASSETS: assets, ADMIN_DEV: "1" };
    expect((await handle(req("/", {}, "http://localhost:8790"), dev, NOW)).status).toBe(200);
    expect((await handle(req("/", {}, "https://admin.talkhalifax.ca"), dev, NOW)).status).toBe(503);
  });
  it("is read-only in stage 1", async () => {
    const t = await token();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect((await handle(req("/api/users", { method, headers: { "cf-access-jwt-assertion": t } }), configured(), NOW)).status).toBe(405);
  });
  it("sends its security headers, on refusals too", async () => {
    for (const r of [await handle(req("/"), configured(), NOW), await asDev("/")]) {
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("signing in with a username and password", () => {
  const USER = "editor", PASSWORD = "a-long-test-password-123";
  const allowAll = { limit: async () => ({ success: true }) };
  const withPassword = (extra: Partial<AdminEnv> = {}): AdminEnv => ({ PLATFORM: recording().platform, ASSETS: assets, ADMIN_USER: USER, ADMIN_PASSWORD: PASSWORD, LOGIN_LIMIT: allowAll, ...extra });
  const SITE = "https://admin.talkhalifax.ca";
  const signIn = (user: string, password: string, e = withPassword(), headers: Record<string, string> = { origin: SITE }) =>
    handle(req("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ user, password }).toString() }), e, NOW);
  const cookieFrom = (r: Response) => (r.headers.get("set-cookie") || "").split(";")[0];
  const asUser = (path: string, cookie: string, e = withPassword(), at = NOW) => handle(req(path, { headers: { cookie } }), e, at);

  it("sends strangers to the sign-in page, and refuses the data and the script", async () => {
    const page = await handle(req("/"), withPassword(), NOW);
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/login");
    expect((await handle(req("/admin.js"), withPassword(), NOW)).status).toBe(303);
    for (const path of ["/api/users", "/api/summary", "/api/overview"]) expect((await handle(req(path), withPassword(), NOW)).status).toBe(401);
    const login = await handle(req("/login"), withPassword(), NOW);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('action="/login"');
    expect((await handle(req("/admin.css"), withPassword(), NOW)).status).toBe(200);
  });
  it("signs in with the right username and password, with a cookie scripts can't read", async () => {
    const r = await signIn(USER, PASSWORD);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/");
    const set = r.headers.get("set-cookie") || "";
    for (const flag of ["__Host-th-admin=", "HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(set).toContain(flag);
    expect(set).not.toContain(PASSWORD);
    const page = await asUser("/", cookieFrom(r));
    expect(page.status).toBe(200);
    expect((await asUser("/api/summary", cookieFrom(r))).status).toBe(200);
  });
  it("refuses a wrong password or username, without saying which", async () => {
    const a = await signIn(USER, "wrong-password-but-long"), b = await signIn("someone", PASSWORD);
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(await a.text()).toBe(await b.text());
    expect(a.headers.get("set-cookie")).toBeNull();
  });
  it("refuses a sign-in posted from another site", async () => {
    expect((await signIn(USER, PASSWORD, withPassword(), { origin: "https://evil.test" })).status).toBe(403);
    expect((await signIn(USER, PASSWORD, withPassword(), {})).status).toBe(403);
  });
  it("refuses forged, tampered and expired sessions", async () => {
    const good = cookieFrom(await signIn(USER, PASSWORD));
    const [name, value] = good.split("=");
    const [exp, sig] = value.split(".");
    expect((await asUser("/api/users", `${name}=${Number(exp) + 3_600_000}.${sig}`)).status).toBe(401);
    expect((await asUser("/api/users", `${name}=${exp}.${"A".repeat(43)}`)).status).toBe(401);
    expect((await asUser("/api/users", `${name}=nonsense`)).status).toBe(401);
    expect((await asUser("/api/users", good, withPassword(), NOW + 13 * HOUR)).status).toBe(401);
    expect((await asUser("/api/users", good, withPassword(), NOW + 11 * HOUR)).status).toBe(200);
  });
  it("signs everyone out when the password changes", async () => {
    const good = cookieFrom(await signIn(USER, PASSWORD));
    expect((await asUser("/api/users", good, withPassword({ ADMIN_PASSWORD: "a-different-long-password" }))).status).toBe(401);
  });
  it("won't use a short password, or a missing username, at all", async () => {
    for (const e of [withPassword({ ADMIN_PASSWORD: "short-password" }), withPassword({ ADMIN_USER: undefined })]) {
      expect((await handle(req("/"), e, NOW)).status).toBe(503);
      expect((await signIn(USER, e.ADMIN_PASSWORD || "", e)).status).toBe(503);
    }
  });
  it("limits sign-in attempts by address", async () => {
    const keys: string[] = [];
    const limited = withPassword({ LOGIN_LIMIT: { limit: async (o: { key: string }) => { keys.push(o.key); return { success: false }; } } });
    const r = await signIn(USER, PASSWORD, limited, { origin: SITE, "cf-connecting-ip": "203.0.113.5" });
    expect(r.status).toBe(429);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(keys).toEqual(["203.0.113.5"]);
  });
  const SWITCHED_OFF = "Sign-in is switched off until it's set up properly.";
  it("refuses every sign-in when the attempt limit isn't set up, right or wrong", async () => {
    const e = withPassword({ LOGIN_LIMIT: undefined });
    const right = await signIn(USER, PASSWORD, e), wrong = await signIn(USER, "wrong-password-but-long", e);
    expect(right.status).toBe(503);
    expect(right.headers.get("set-cookie")).toBeNull();
    const body = await right.text();
    expect(body).toContain(SWITCHED_OFF);
    expect(wrong.status).toBe(right.status);
    expect(await wrong.text()).toBe(body);
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });
  it("checks the attempt limit by address and signs in when under it", async () => {
    const keys: string[] = [];
    const e = withPassword({ LOGIN_LIMIT: { limit: async (o: { key: string }) => { keys.push(o.key); return { success: true }; } } });
    const r = await signIn(USER, PASSWORD, e, { origin: SITE, "cf-connecting-ip": "203.0.113.5" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/");
    const set = r.headers.get("set-cookie") || "";
    for (const flag of ["__Host-th-admin=", "HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(set).toContain(flag);
    expect(keys).toEqual(["203.0.113.5"]);
    const wrong = await signIn(USER, "wrong-password-but-long", e, { origin: SITE, "cf-connecting-ip": "203.0.113.5" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });
  it("still says the site isn't set up when nothing is, attempt limit or not", async () => {
    for (const e of [{ PLATFORM: recording().platform, ASSETS: assets } as AdminEnv, withPassword({ ADMIN_PASSWORD: "short-password", LOGIN_LIMIT: undefined })]) {
      const r = await signIn(USER, PASSWORD, e);
      expect(r.status).toBe(503);
      const body = await r.text();
      expect(body).toContain("The admin site isn't set up yet");
      expect(body).not.toContain(SWITCHED_OFF);
    }
  });
  it("leaves Access alone when the attempt limit is missing", async () => {
    const both = { ...withPassword({ LOGIN_LIMIT: undefined }), ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
    expect((await handle(req("/", { headers: { "cf-access-jwt-assertion": await token() } }), both, NOW)).status).toBe(200);
    expect((await signIn(USER, PASSWORD, both)).status).toBe(403);
  });
  it("still shows the sign-in form when the attempt limit is missing", async () => {
    const r = await handle(req("/login"), withPassword({ LOGIN_LIMIT: undefined }), NOW);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('action="/login"');
  });
  it("sends the security headers when sign-in is switched off", async () => {
    const r = await signIn(USER, PASSWORD, withPassword({ LOGIN_LIMIT: undefined }));
    expect(r.status).toBe(503);
    const csp = r.headers.get("content-security-policy") || "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("same-origin");
  });
  it("refuses a sign-in from another site before anything else, attempt limit or not", async () => {
    expect((await signIn(USER, PASSWORD, withPassword({ LOGIN_LIMIT: undefined }), { origin: "https://evil.test" })).status).toBe(403);
  });
  it("refuses an oversized sign-in form", async () => {
    const big = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`user=${"x".repeat(5000)}`)); c.close(); } });
    const r = await handle(req("/login", { method: "POST", headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" }, body: big }), withPassword(), NOW);
    expect(r.status).toBe(413);
  });
  it("signs out by clearing the cookie", async () => {
    const good = cookieFrom(await signIn(USER, PASSWORD));
    const r = await handle(req("/logout", { method: "POST", headers: { cookie: good, origin: SITE } }), withPassword(), NOW);
    expect(r.status).toBe(303);
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("is still read-only once signed in", async () => {
    const good = cookieFrom(await signIn(USER, PASSWORD));
    expect((await handle(req("/api/users", { method: "POST", headers: { cookie: good, origin: SITE } }), withPassword(), NOW)).status).toBe(405);
  });
  it("uses Access instead whenever Access settings are present", async () => {
    const both = { ...withPassword(), ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
    expect((await signIn(USER, PASSWORD, both)).status).toBe(403);
    expect((await handle(req("/", { headers: { "cf-access-jwt-assertion": await token() } }), both, NOW)).status).toBe(200);
  });
  it("sends the security headers on the sign-in page", async () => {
    const r = await handle(req("/login"), withPassword(), NOW);
    expect(r.headers.get("content-security-policy")).toContain("form-action 'self'");
    // "no-referrer" would make browsers send "Origin: null" with the form, and every sign-in would be refused
    expect(r.headers.get("referrer-policy")).toBe("same-origin");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

// ---------- the data comes only through PLATFORM ----------

const ROUTES: [string, Method][] = [
  ["/api/summary", "summary"], ["/api/overview", "overview"], ["/api/users", "users"],
  ["/api/content", "content"], ["/api/data", "dataSources"], ["/api/jobs", "jobs"],
];

/** Calls one route with a recording PLATFORM and gives back what the named method was passed. */
async function argsFor(path: string, method: Method) {
  const r = recording();
  const res = await asDev(path, r.platform);
  expect(res.status, path).toBe(200);
  expect(r.fns[method], path).toHaveBeenCalledTimes(1);
  expect(r.calls(), path).toBe(1);
  return { arg: r.fns[method].mock.calls[0][0], body: await res.json() };
}

describe("each route is one call to PLATFORM", () => {
  it("calls exactly its own method, once, and answers what it gave back", async () => {
    for (const [path, method] of ROUTES) {
      const r = recording();
      const res = await asDev(path, r.platform);
      expect(res.status, path).toBe(200);
      for (const m of METHODS) expect(r.fns[m], `${path} ${m}`).toHaveBeenCalledTimes(m === method ? 1 : 0);
      expect(await res.json(), path).toEqual(FIXED[method]);
    }
  });
  it("answers an unknown route 404 without calling anything", async () => {
    const r = recording();
    const res = await asDev("/api/nope", r.platform);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(r.calls()).toBe(0);
  });
});

describe("the users arguments", () => {
  const users = async (qs: string) => {
    const { arg } = await argsFor(`/api/users${qs}`, "users");
    return arg;
  };
  it("defaults to everyone, from the start", async () => {
    expect(await users("")).toStrictEqual({ q: "", role: "all", offset: 0 });
  });
  it("passes the search on as typed, for AdminApi to trim and lowercase", async () => {
    expect(await users("?q=%20Harb%20&role=moderator&offset=200")).toStrictEqual({ q: " Harb ", role: "moderator", offset: 200 });
  });
  it("treats an unknown role as everyone, including names on every object", async () => {
    for (const role of ["", "admin", "Member", "constructor", "__proto__", "toString"])
      expect((await users(`?role=${role}`) as { role: string }).role, role).toBe("all");
    for (const role of ["all", "member", "moderator", "journalist", "banned"])
      expect((await users(`?role=${role}`) as { role: string }).role, role).toBe(role);
  });
  it("makes the offset a whole number from 0 to 100,000", async () => {
    const cases: [string, number][] = [
      ["", 0], ["abc", 0], ["-5", 0], ["NaN", 0], ["%207%20", 7], ["1e3", 1000], ["2.7", 2],
      ["100000", 100000], ["100001", 100000], ["1e9", 100000], ["Infinity", 100000],
    ];
    for (const [given, want] of cases) expect((await users(`?offset=${given}`) as { offset: number }).offset, given).toBe(want);
  });
});

describe("the content arguments", () => {
  const SCREENS = ["all", "Developing", "Articles", "Notices", "Events"], STATUSES = ["all", "waiting", "active", "archived"];
  it("defaults to everything", async () => {
    const { arg } = await argsFor("/api/content", "content");
    expect(arg).toStrictEqual({ screen: "all", status: "all", q: "" });
  });
  it("passes known screens and statuses, and the search, straight through", async () => {
    for (const screen of SCREENS) for (const status of STATUSES) {
      const { arg, body } = await argsFor(`/api/content?screen=${screen}&status=${status}&q=%20Bridge%20`, "content");
      expect(arg).toStrictEqual({ screen, status, q: " Bridge " });
      expect(body).toEqual(FIXED.content);
    }
  });
  it("answers an empty list for a screen or status it doesn't know, as it always has", async () => {
    const cases: [string, object][] = [
      ["?screen=Foo", { screen: "all", status: "all", q: "" }],
      ["?screen=events", { screen: "all", status: "all", q: "" }],
      ["?screen=constructor&status=active", { screen: "all", status: "active", q: "" }],
      ["?status=deleted", { screen: "all", status: "all", q: "" }],
      ["?screen=Events&status=__proto__&q=x", { screen: "Events", status: "all", q: "x" }],
    ];
    for (const [qs, want] of cases) {
      const { arg, body } = await argsFor(`/api/content${qs}`, "content");
      expect(arg, qs).toStrictEqual(want);
      expect(body, qs).toStrictEqual({ items: [], total: 0, limit: 321 });
    }
  });
});

describe("the overview range", () => {
  it("passes 24h, 7d and 30d, and makes anything else 7d", async () => {
    for (const [qs, want] of [["", "7d"], ["?range=forever", "7d"], ["?range=24H", "7d"], ["?range=constructor", "7d"], ["?range=__proto__", "7d"],
      ["?range=24h", "24h"], ["?range=7d", "7d"], ["?range=30d", "30d"]]) {
      expect((await argsFor(`/api/overview${qs}`, "overview")).arg, qs).toBe(want);
    }
  });
});

describe("when PLATFORM fails", () => {
  const SECRET = "D1_ERROR: no such column: email at offset 42 (SELECT email FROM users) nora.private@example.test";
  const expectGeneric = async (res: Response, status: number, error: string, label: string) => {
    expect(res.status, label).toBe(status);
    const text = await res.text();
    expect(text, label).toBe(JSON.stringify({ error }));
    expect(res.headers.get("content-security-policy"), label).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control"), label).toBe("no-store");
    expect(res.headers.get("x-content-type-options"), label).toBe("nosniff");
    return text;
  };
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });

  it("answers its refusal of bad arguments as a 400, and nothing more", async () => {
    for (const [path] of ROUTES) await expectGeneric(await asDev(path, throwing("Bad request")), 400, "Bad request", path);
  });
  it("answers its own failure as the usual 500", async () => {
    for (const [path] of ROUTES) await expectGeneric(await asDev(path, throwing("Something went wrong")), 500, "Something went wrong", path);
  });
  it("never puts the thrown text in the answer", async () => {
    for (const [path] of ROUTES) {
      for (const [label, p] of [["detailed", throwing(SECRET)], ["TypeError", throwing(() => new TypeError(`cannot read ${SECRET}`))]] as const) {
        const text = await expectGeneric(await asDev(path, p), 500, "Something went wrong", `${path} ${label}`);
        for (const bit of ["D1_ERROR", "email", "nora.private", "column", "cannot read"]) expect(text).not.toContain(bit);
      }
    }
  });
  it("answers the usual 500 when PLATFORM isn't bound at all", async () => {
    const unbound = { ASSETS: assets, ADMIN_DEV: "1" } as unknown as AdminEnv;
    for (const [path] of ROUTES) await expectGeneric(await handle(req(path, {}, "http://localhost:8790"), unbound, NOW), 500, "Something went wrong", path);
  });
});

describe("nothing reaches PLATFORM before the sign-in check", () => {
  const USER = "editor", PASSWORD = "a-long-test-password-123", SITE = "https://admin.talkhalifax.ca";
  const PATHS = [...ROUTES.map(([p]) => p), "/api/nope"];
  it("makes no call for any refused request", async () => {
    const r = recording();
    const passwordEnv: AdminEnv = { PLATFORM: r.platform, ASSETS: assets, ADMIN_USER: USER, ADMIN_PASSWORD: PASSWORD, LOGIN_LIMIT: { limit: async () => ({ success: true }) } };
    const login = await handle(req("/login", { method: "POST", headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ user: USER, password: PASSWORD }).toString() }), passwordEnv, NOW);
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const [name, value] = cookie.split("="), [exp, sig] = value.split(".");
    const good = await token(), forged = await token({}, { key: otherKeys.privateKey });

    const cases: [string, AdminEnv, RequestInit, string, number, number?][] = [
      ["unconfigured", { PLATFORM: r.platform, ASSETS: assets }, {}, SITE, 503],
      ["Access, team only", { PLATFORM: r.platform, ASSETS: assets, ACCESS_TEAM_DOMAIN: TEAM }, { headers: { "cf-access-jwt-assertion": good } }, SITE, 503],
      ["Access, audience only", { PLATFORM: r.platform, ASSETS: assets, ACCESS_AUD: AUD }, { headers: { "cf-access-jwt-assertion": good } }, SITE, 503],
      ["Access, no token", configured(r.platform), {}, SITE, 403],
      ["Access, forged token", configured(r.platform), { headers: { "cf-access-jwt-assertion": forged } }, SITE, 403],
      ["password, no cookie", passwordEnv, {}, SITE, 401],
      ["password, expired cookie", passwordEnv, { headers: { cookie } }, SITE, 401, NOW + 13 * HOUR],
      ["password, tampered cookie", passwordEnv, { headers: { cookie: `${name}=${Number(exp) + 3_600_000}.${sig}` } }, SITE, 401],
      ["ADMIN_DEV on the real address", { PLATFORM: r.platform, ASSETS: assets, ADMIN_DEV: "1" }, {}, SITE, 503],
      ["signed-in POST", configured(r.platform), { method: "POST", headers: { "cf-access-jwt-assertion": good, origin: SITE } }, SITE, 405],
      ["signed-in POST, password", passwordEnv, { method: "POST", headers: { cookie, origin: SITE } }, SITE, 405],
    ];
    for (const [label, e, init, host, status, at] of cases) {
      for (const path of PATHS) {
        const res = await handle(req(path, init, host), e, at ?? NOW);
        expect(res.status, `${label} ${path}`).toBe(status);
      }
    }
    expect(r.calls()).toBe(0);
    // and the same signed-in cookie does reach it, so the refusals above aren't an accident of the setup
    expect((await handle(req("/api/summary", { headers: { cookie } }, SITE), passwordEnv, NOW)).status).toBe(200);
    expect(r.calls()).toBe(1);
  });
});

describe("the admin Worker has no database", () => {
  it("has no DB in its environment's type", () => {
    expectTypeOf<AdminEnv>().not.toHaveProperty("DB");
    expectTypeOf<AdminEnv>().toHaveProperty("PLATFORM");
    // @ts-expect-error a database binding isn't part of the admin Worker's environment
    const withDb: AdminEnv = { PLATFORM: recording().platform, ASSETS: assets, DB: {} as D1Database };
    expect(withDb.PLATFORM).toBeDefined();
  });
  it("answers every route without ever reading a DB binding", async () => {
    freezeClock();
    let reads = 0;
    const e = {
      PLATFORM: recording().platform, ASSETS: assets, ADMIN_DEV: "1",
      get DB(): never { reads++; throw new Error("the admin Worker read DB"); },
    } as unknown as AdminEnv;
    for (const [path] of ROUTES) expect((await handle(req(path, {}, "http://localhost:8790"), e, NOW)).status, path).toBe(200);
    expect(reads).toBe(0);
  });
});
