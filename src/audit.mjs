/**
 * geo-audit — audit a site's readiness to be cited by AI search engines.
 *
 * Every check returns one of three states, never a bare boolean:
 *   present  — observed directly (the file/record was fetched)
 *   absent   — observed directly and definitively not there (HTTP 404)
 *   unknown  — could not be checked (network error, timeout, 5xx)
 *
 * "unknown" is deliberately NOT collapsed into "absent": a site we failed to
 * reach is not a site without llms.txt, and a report that says otherwise is
 * useless to the person acting on it.
 */

const DEFAULT_UA = 'geo-audit/0.1 (+https://github.com/lyh905/geo-audit)';
const DEFAULT_TIMEOUT = 15000;

/** Crawlers that feed AI answers. Blocking them means staying out of AI citations. */
export const AI_BOTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'meta-externalagent',
  'Bytespider',
  'Baiduspider',
];

const WEIGHTS = {
  llms_txt: 20,
  ai_crawlers: 30,
  sitemap: 20,
  structured_data: 15,
  meta: 15,
};

/**
 * Normalize user input into an origin URL.
 * @param {string} input a bare domain, a URL, or a URL with a path
 * @returns {URL}
 */
export function normalizeTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('empty target');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  const url = new URL(withScheme);
  if (!url.hostname.includes('.')) throw new Error('not a domain: ' + raw);
  return url;
}

async function fetchText(url, { ua = DEFAULT_UA, timeout = DEFAULT_TIMEOUT } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': ua,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, finalUrl: res.url, body };
  } catch (err) {
    return { ok: false, status: 0, finalUrl: url, body: '', error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse robots.txt into user-agent groups plus the site-wide Sitemap lines.
 * @param {string} text robots.txt contents
 * @returns {{ groups: {agents: string[], rules: {type: string, path: string}[]}[], sitemaps: string[] }}
 */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;

  for (const line of String(text || '').split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, '').trim();
    if (!clean) continue;
    const sep = clean.indexOf(':');
    if (sep < 0) continue;

    const field = clean.slice(0, sep).trim().toLowerCase();
    const value = clean.slice(sep + 1).trim();

    if (field === 'user-agent') {
      // A user-agent line after rules opens a new group.
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (field === 'disallow' || field === 'allow') {
      if (!current) {
        current = { agents: ['*'], rules: [] };
        groups.push(current);
      }
      current.rules.push({ type: field, path: value });
    } else if (field === 'sitemap' && value) {
      sitemaps.push(value);
    }
  }

  return { groups, sitemaps };
}

/**
 * Decide whether robots.txt blocks a given crawler from the site root.
 *
 * This is a root-level verdict, not a full robots.txt matcher: it answers
 * "can this bot read the homepage at all", which is the question that
 * determines whether the site can be crawled into an AI answer.
 *
 * @param {{agents: string[], rules: {type: string, path: string}[]}[]} groups parsed robots groups
 * @param {string} bot crawler product token, e.g. "GPTBot"
 * @returns {'blocked'|'allowed'|'unlisted'}
 */
export function botStance(groups, bot) {
  const wanted = bot.toLowerCase();
  const named = groups.find((g) => g.agents.includes(wanted));
  const group = named || groups.find((g) => g.agents.includes('*'));

  if (!group) return 'unlisted';

  const blocksRoot = group.rules.some((r) => r.type === 'disallow' && r.path === '/');
  const allowsRoot = group.rules.some((r) => r.type === 'allow' && (r.path === '/' || r.path === ''));

  if (blocksRoot && !allowsRoot) return 'blocked';
  return 'allowed';
}

/**
 * Detect a catch-all route: many single-page apps answer every path with the
 * same HTML shell and HTTP 200. Without this check /llms.txt looks "present"
 * on any SPA, and the report congratulates the site for a file it never wrote.
 *
 * @param {string} body response body
 * @returns {boolean} true when the body is an HTML document rather than a text file
 */
export function looksLikeHtml(body) {
  const head = String(body || '').trimStart().slice(0, 400).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head>');
}

function listRobotsSitemaps(body) {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^sitemap:/i.test(l))
    .map((l) => l.slice(l.indexOf(':') + 1).trim())
    .filter(Boolean);
}

function countSitemapUrls(xml) {
  const locs = String(xml || '').match(/<loc>\s*([^<\s]+)\s*<\/loc>/gi) || [];
  return { count: locs.length, isIndex: /<sitemapindex/i.test(xml) };
}

function countJsonLd(html) {
  const blocks = String(html || '').match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  ) || [];
  const types = new Set();
  for (const block of blocks) {
    for (const m of block.matchAll(/"@type"\s*:\s*"([^"]+)"/g)) types.add(m[1]);
  }
  return { blocks: blocks.length, types: [...types] };
}

function readMeta(html) {
  const title = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const desc = (String(html).match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
  ) || [])[1];
  const canonical = (String(html).match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i,
  ) || [])[1];
  return {
    title: title ? title.replace(/\s+/g, ' ').trim().slice(0, 120) : null,
    description: desc ? desc.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
    canonical: canonical || null,
  };
}

/**
 * Run every check against a site.
 * @param {string} input domain or URL
 * @param {{ua?: string, timeout?: number}} [options]
 * @returns {Promise<object>} report with per-check states, an evidence-linked score, and coverage
 */
export async function audit(input, options = {}) {
  const target = normalizeTarget(input);
  const origin = target.origin;
  const fetchOpts = { ua: options.ua || DEFAULT_UA, timeout: options.timeout || DEFAULT_TIMEOUT };

  const home = await fetchText(origin + '/', fetchOpts);
  const robotsRes = await fetchText(origin + '/robots.txt', fetchOpts);
  const llmsRes = await fetchText(origin + '/llms.txt', fetchOpts);

  const checks = [];

  // --- home page -----------------------------------------------------------
  const homeState = home.status === 0 || home.status >= 500
    ? 'unknown'
    : home.ok ? 'present' : 'absent';

  // --- llms.txt ------------------------------------------------------------
  const llmsIsHtml = llmsRes.ok && looksLikeHtml(llmsRes.body);
  const llmsState = llmsRes.status === 0 || llmsRes.status >= 500
    ? 'unknown'
    : llmsRes.ok && llmsRes.body.trim().length > 0 && !llmsIsHtml ? 'present' : 'absent';

  checks.push({
    id: 'llms_txt',
    weight: WEIGHTS.llms_txt,
    status: llmsState,
    title: 'llms.txt',
    detail:
      llmsState === 'present'
        ? `${llmsRes.body.trim().split(/\r?\n/).length} lines at /llms.txt`
        : llmsState === 'absent'
          ? llmsIsHtml
            ? 'server answered with an HTML page (catch-all route), not a text file'
            : 'no /llms.txt served'
          : `could not check (${llmsRes.error || 'HTTP ' + llmsRes.status})`,
    evidence: origin + '/llms.txt',
  });

  // --- robots.txt / AI crawler stance -------------------------------------
  let robots = { groups: [], sitemaps: [] };
  const robotsIsHtml = robotsRes.ok && looksLikeHtml(robotsRes.body);
  const robotsState = robotsRes.status === 0 || robotsRes.status >= 500
    ? 'unknown'
    : robotsRes.ok && !robotsIsHtml ? 'present' : 'absent';

  if (robotsState === 'present') robots = parseRobots(robotsRes.body);

  const stances = AI_BOTS.map((bot) => ({ bot, stance: botStance(robots.groups, bot) }));
  const blocked = stances.filter((s) => s.stance === 'blocked');
  const crawlerState =
    robotsState === 'unknown' ? 'unknown' : blocked.length === 0 ? 'present' : 'absent';

  checks.push({
    id: 'ai_crawlers',
    weight: WEIGHTS.ai_crawlers,
    status: crawlerState,
    title: 'AI crawler access',
    detail:
      robotsState === 'unknown'
        ? `could not check robots.txt (${robotsRes.error || 'HTTP ' + robotsRes.status})`
        : blocked.length === 0
          ? robotsState === 'absent'
            ? robotsIsHtml
              ? `no readable robots.txt (HTML catch-all); all ${AI_BOTS.length} AI crawlers allowed by default`
              : `no robots.txt; all ${AI_BOTS.length} AI crawlers allowed by default`
            : `none of ${AI_BOTS.length} AI crawlers blocked`
          : `${blocked.length}/${AI_BOTS.length} blocked: ${blocked.map((b) => b.bot).join(', ')}`,
    evidence: origin + '/robots.txt',
    bots: stances,
  });

  // --- sitemap -------------------------------------------------------------
  const declared = [...new Set([...robots.sitemaps, ...listRobotsSitemaps(robotsRes.body || '')])];
  const candidates = declared.length ? declared : [origin + '/sitemap.xml'];
  let sitemap = { status: 'unknown', detail: 'not fetched', url: candidates[0], urls: 0 };

  for (const candidate of candidates.slice(0, 3)) {
    const res = await fetchText(candidate, fetchOpts);
    if (res.status === 0 || res.status >= 500) {
      sitemap = { status: 'unknown', detail: `could not check (${res.error || 'HTTP ' + res.status})`, url: candidate, urls: 0 };
      continue;
    }
    if (!res.ok) {
      sitemap = { status: 'absent', detail: `HTTP ${res.status}`, url: candidate, urls: 0 };
      continue;
    }
    const { count, isIndex } = countSitemapUrls(res.body);
    const isXml = /<(urlset|sitemapindex)/i.test(res.body);
    sitemap = {
      status: isXml && count > 0 ? 'present' : 'absent',
      detail: !isXml
        ? 'answered with a non-sitemap document (HTML catch-all route)'
        : count > 0
          ? `${count} <loc> entries${isIndex ? ' (sitemap index)' : ''}`
          : 'no <loc> entries',
      url: candidate,
      urls: count,
    };
    if (count > 0) break;
  }

  checks.push({
    id: 'sitemap',
    weight: WEIGHTS.sitemap,
    status: sitemap.status,
    title: 'Sitemap',
    detail: sitemap.detail,
    evidence: sitemap.url,
  });

  // --- structured data -----------------------------------------------------
  const jsonld = homeState === 'present' ? countJsonLd(home.body) : { blocks: 0, types: [] };
  checks.push({
    id: 'structured_data',
    weight: WEIGHTS.structured_data,
    status: homeState === 'unknown' ? 'unknown' : jsonld.blocks > 0 ? 'present' : 'absent',
    title: 'JSON-LD structured data',
    detail:
      homeState === 'unknown'
        ? 'could not check (home page unreachable)'
        : jsonld.blocks > 0
          ? `${jsonld.blocks} block(s): ${jsonld.types.join(', ') || 'no @type'}`
          : 'no application/ld+json on the home page',
    evidence: origin + '/',
  });

  // --- head metadata -------------------------------------------------------
  const meta = homeState === 'present' ? readMeta(home.body) : { title: null, description: null, canonical: null };
  const metaScore = [meta.title, meta.description, meta.canonical].filter(Boolean).length;
  checks.push({
    id: 'meta',
    weight: WEIGHTS.meta,
    status: homeState === 'unknown' ? 'unknown' : metaScore === 3 ? 'present' : 'absent',
    title: 'Head metadata',
    detail:
      homeState === 'unknown'
        ? 'could not check (home page unreachable)'
        : `${metaScore}/3 present` +
          (!meta.title ? ' · no <title>' : '') +
          (!meta.description ? ' · no description' : '') +
          (!meta.canonical ? ' · no canonical' : ''),
    evidence: origin + '/',
    meta,
  });

  // --- score ---------------------------------------------------------------
  // The score is computed over JUDGED checks only: an unreachable site must not
  // look like a bad site. Coverage is reported separately so a high score on
  // two checks cannot be mistaken for a full audit.
  const judged = checks.filter((c) => c.status !== 'unknown');
  const maxJudged = judged.reduce((n, c) => n + c.weight, 0);
  const earned = judged.filter((c) => c.status === 'present').reduce((n, c) => n + c.weight, 0);
  const score = maxJudged === 0 ? null : Math.round((earned / maxJudged) * 100);
  const coverage = Math.round((judged.length / checks.length) * 100);

  return {
    target: origin,
    auditedAt: new Date().toISOString(),
    homeStatus: home.status,
    checks,
    score,
    coverage,
    grade: score === null ? 'n/a' : score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D',
    counts: {
      present: checks.filter((c) => c.status === 'present').length,
      absent: checks.filter((c) => c.status === 'absent').length,
      unknown: checks.filter((c) => c.status === 'unknown').length,
    },
  };
}
