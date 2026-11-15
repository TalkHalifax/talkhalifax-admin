// The admin site in a real browser, against a local platform Worker with throwaway data. The platform is the public repo
// (TalkHalifax/talkhalifax) at main, checked out in .platform/ and run with its own test config, so this also checks that
// admin works with the AdminApi the platform has now. Every page at phone and desktop widths, and every data route.
//   npm run test:e2e
// Needs .platform/ (CI checks it out; locally: git clone --depth 1 https://github.com/TalkHalifax/talkhalifax .platform)
// and Chrome or Edge from the system, or the one at CHROME_PATH.
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const PORT = 8791, B = `http://localhost:${PORT}`;
const ADMIN_PORT = 8792, ADMIN = `http://localhost:${ADMIN_PORT}`;
const DATA = ".wrangler/e2e";
const PLATFORM_CONFIG = ".platform/test/wrangler.test.jsonc";
const PLATFORM = ["wrangler", "--config", PLATFORM_CONFIG];
const win = process.platform === "win32";
const wait = ms => new Promise(r => setTimeout(r, ms));

if (!existsSync(PLATFORM_CONFIG)) {
  console.error("No platform to run against. Check out the public repo first: git clone --depth 1 https://github.com/TalkHalifax/talkhalifax .platform");
  process.exit(1);
}

// Throwaway data: a story for each screen the checks open, and three members with a message between them
const q = s => `'${s}'`;
const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const T = Date.now();
const story = (id, kind, stage, headline) => `INSERT INTO stories (id, kind, section, area, headline, dek, facts, body, means, source_url, published_at, updated_at, stage, developing_since)
  VALUES (${[id, kind, "City Hall", "Halifax", headline, "A dek", "[]", '["A sentence."]', "[]", "https://www.halifax.ca/", now, now, stage, now].map(q).join(", ")});`;
const member = (id, sub, name, role) => `INSERT INTO users (id, provider, provider_sub, name, email, role, created_at, password_hash) VALUES (${[id, "password", sub, name, "", role].map(q).join(", ")}, ${T - 2 * 864e5}, NULL);`;
const SEED = [
  story("e2e-developing", "article", "developing", "A story still developing"),
  story("e2e-article", "article", "archived", "A story that has settled"),
  story("e2e-notice", "notice", "developing", "A notice about a road"),
  member("u_e2e_mod", "e2e_mod", "E2E Moderator", "moderator"),
  member("u_e2e_member", "e2e_member", "E2E Member", "member"),
  member("u_e2e_other", "e2e_other", "E2E Other", "member"),
  `INSERT INTO message_index (id, story_id, user_id, text, created_at) VALUES ('m_e2e', 'e2e-developing', 'u_e2e_member', 'A seeded message', ${T});`,
].join(" ");

function browserPath() {
  const found = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(p => p && existsSync(p));
  if (!found) throw new Error("No Chrome or Edge found. Set CHROME_PATH.");
  return found;
}

const npx = args => execSync(`npx ${args.join(" ")}`, { stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
const start = args => spawn("npx", args, { stdio: "ignore", shell: win, detached: !win, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
const stop = s => {
  if (!s) return;
  try { if (win) execSync(`taskkill /pid ${s.pid} /T /F`, { stdio: "ignore" }); else process.kill(-s.pid); } catch { /* already gone */ }
};

let fails = 0;
const ok = (c, label, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`); if (!c) fails++; };

// The admin site's real config keeps it off every other address, and can't skip the sign-in check
const adminConfig = readFileSync("wrangler.jsonc", "utf8");
ok(/"workers_dev":\s*false/.test(adminConfig), "admin config: no workers.dev address");
ok(/"preview_urls":\s*false/.test(adminConfig), "admin config: no preview addresses");
ok(/"run_worker_first":\s*true/.test(adminConfig), "admin config: pages go through the sign-in check");
ok(!adminConfig.includes("ADMIN_DEV"), "admin config: doesn't set the local bypass");
ok(/"name":\s*"LOGIN_LIMIT"/.test(adminConfig), "admin config: limits sign-in attempts");
ok(!/ADMIN_(USER|PASSWORD)"?\s*:/.test(adminConfig), "admin config: the username and password are secrets, not in the file");
ok(/"services":\s*\[\s*\{\s*"binding":\s*"PLATFORM",\s*"service":\s*"talkhalifax",\s*"entrypoint":\s*"AdminApi"\s*\}\s*\]/.test(adminConfig), "admin config: binds PLATFORM to talkhalifax / AdminApi");
ok(!adminConfig.includes("d1_databases"), "admin config: has no d1_databases");

// The platform at main, on throwaway data
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
npx([...PLATFORM, "d1", "migrations", "apply", "talkhalifax-test", "--local", "--persist-to", DATA]);
writeFileSync(`${DATA}/seed.sql`, SEED);
npx([...PLATFORM, "d1", "execute", "talkhalifax-test", "--local", "--persist-to", DATA, "--file", `${DATA}/seed.sql`]);
const platform = start([...PLATFORM, "dev", "--port", String(PORT), "--persist-to", DATA]);
let admin, browser;

try {
  for (let i = 0; ; i++) {
    if (await fetch(B + "/api/stories").then(r => r.ok, () => false)) break;
    if (i > 60) throw new Error("The local platform Worker didn't start.");
    await wait(1000);
  }
  admin = start(["wrangler", "--config", "test/wrangler.admin.jsonc", "dev", "--port", String(ADMIN_PORT), "--inspector-port", "9331"]);
  for (let i = 0; ; i++) {
    if (await fetch(ADMIN + "/api/summary").then(r => r.ok, () => false)) break;
    if (i > 60) throw new Error("The local admin Worker didn't start, or can't reach the platform's AdminApi.");
    await wait(1000);
  }

  // Every data route, through the platform's real AdminApi: AdminApi accepts the arguments admin sends, and answers
  // with what admin reads
  const ROUTES = [
    ["/api/summary", "members"], ["/api/overview", "labels"], ["/api/overview?range=24h", "labels"], ["/api/overview?range=30d", "labels"],
    ["/api/users", "users"], ["/api/users?q=%20E2E%20", "users"], ["/api/users?role=banned", "users"], ["/api/users?q=%25&offset=0", "users"],
    ["/api/users?offset=2", "users"], ["/api/content", "items"], ["/api/content?screen=Notices", "items"],
    ["/api/content?status=archived&q=settled", "items"], ["/api/content?screen=Events", "items"], ["/api/data", "sources"], ["/api/jobs", "jobs"],
  ];
  for (const [path, key] of ROUTES) {
    const r = await fetch(ADMIN + path);
    const body = await r.json().catch(() => null);
    ok(r.status === 200 && body !== null && typeof body === "object" && key in body, `admin api ${path}: answers from AdminApi`, `HTTP ${r.status}`);
  }
  const list = async (path, key) => (await (await fetch(ADMIN + path)).json())[key] || [];
  ok((await list("/api/users", "users")).length > 0, "admin api: the seeded members show up");
  ok((await list("/api/content", "items")).length > 0, "admin api: the seeded stories show up");

  browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, userDataDir: mkdtempSync(join(tmpdir(), "th-admin-e2e-")), args: process.env.CI ? ["--no-sandbox"] : [] });
  const adminErrors = [];
  for (const [width, height, label] of [[1280, 900, "desktop"], [375, 812, "phone"]]) {
    const open = async hash => {
      const p = await browser.newPage();
      p.on("pageerror", e => adminErrors.push(`${label} #${hash}: ${e.message}`));
      p.on("console", m => { if (m.type() === "error" && !/fonts\.g|ERR_NAME|ERR_INTERNET/.test(m.text() + (m.location().url || ""))) adminErrors.push(`${label} #${hash}: ${m.text()}`); });
      await p.setViewport({ width, height });
      await p.goto(`${ADMIN}/#${hash}`, { waitUntil: "load" });
      return p;
    };
    const fits = p => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    const h1 = p => p.evaluate(() => document.querySelector("h1")?.innerText || "");

    let p = await open("home");
    await p.waitForSelector("#charts .plot", { timeout: 8000 }).catch(() => {});
    ok(await h1(p) === "Home", `admin ${label}: Home opens`);
    ok(await p.$$eval("#charts > .card", c => c.length) === 4, `admin ${label}: Home has the four chart cards`);
    ok(await p.$$eval("#charts .plot", c => c.length) === 5, `admin ${label}: with a plot for each measure`);
    ok(await fits(p), `admin ${label}: Home fits the screen`);
    await p.click('[data-range="30d"]');
    await p.waitForFunction(() => document.querySelector('[data-range="30d"]').classList.contains("on"), { timeout: 5000 }).catch(() => {});
    ok(await p.$$eval("#charts .plot:first-child .col, #charts .plot .col", c => c.length) >= 30, `admin ${label}: the range switch redraws the charts`);
    await p.click("[data-table=signups]");
    ok(await p.$$eval("#charts .chart-table", c => c.length) === 1, `admin ${label}: a chart can show as a table`);
    await p.close();

    // Switching pages quickly shows the last one asked for, whichever answer arrives first
    p = await open("home");
    await p.evaluate(() => { location.hash = "#jobs"; location.hash = "#users"; location.hash = "#content-data"; location.hash = "#jobs"; });
    await p.waitForFunction(() => document.querySelector("h1")?.innerText === "Administration", { timeout: 5000 }).catch(() => {});
    await wait(1000);
    ok(await h1(p) === "Administration", `admin ${label}: switching quickly lands on the last page`, await h1(p));
    await p.close();

    p = await open("users");
    await p.waitForSelector("#urows", { timeout: 5000 }).catch(() => {});
    ok(await h1(p) === "Users", `admin ${label}: Users opens`);
    ok(await fits(p), `admin ${label}: Users fits the screen`);
    await p.close();

    p = await open("content");
    await p.waitForFunction(() => document.querySelector("#crows")?.innerText.includes("A story still developing"), { timeout: 5000 }).catch(() => {});
    ok((await p.evaluate(() => document.querySelector("#crows")?.innerText || "")).includes("A story still developing"), `admin ${label}: Content lists the stories`);
    ok(await fits(p), `admin ${label}: Content fits the screen`);
    await p.click('[data-screen="Notices"]');
    await p.waitForFunction(() => !document.querySelector("#crows")?.innerText.includes("A story still developing"), { timeout: 5000 }).catch(() => {});
    ok((await p.evaluate(() => document.querySelector("#crows")?.innerText || "")).includes("A notice about a road"), `admin ${label}: Content filters by screen`);
    await p.close();

    p = await open("content-data");
    await p.waitForFunction(() => document.querySelector("h1")?.innerText === "Content", { timeout: 5000 }).catch(() => {});
    ok(await fits(p), `admin ${label}: Data fits the screen`);
    await p.close();

    p = await open("jobs");
    await p.waitForFunction(() => document.querySelector("h1")?.innerText === "Administration", { timeout: 5000 }).catch(() => {});
    ok(await h1(p) === "Administration", `admin ${label}: Administration opens`);
    ok(await fits(p), `admin ${label}: Administration fits the screen`);
    await p.close();
  }
  ok(!adminErrors.length, "admin: no script errors", adminErrors.slice(0, 5).join("; "));
} finally {
  await browser?.close().catch(() => {});
  stop(admin);
  stop(platform);
}
console.log(fails ? `\n${fails} failed` : "\nAll passed");
process.exit(fails ? 1 : 0);
