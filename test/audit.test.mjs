import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { audit, parseRobots, botStance, normalizeTarget, looksLikeHtml, AI_BOTS } from '../src/audit.mjs';

const HOME = '<html><head><title>Example Clinic</title>'
  + '<meta name="description" content="a clinic">'
  + '<link rel="canonical" href="https://example.com/">'
  + '<script type="application/ld+json">{"@type":"MedicalClinic"}</script>'
  + '</head><body></body></html>';

function makeServer(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const hit = routes[req.url];
      if (hit === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      if (hit === 500) {
        res.writeHead(500);
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(typeof hit === 'string' ? hit : JSON.stringify(hit));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('normalizeTarget accepts bare domains and URLs', () => {
  assert.equal(normalizeTarget('example.com').origin, 'https://example.com');
  assert.equal(normalizeTarget('https://example.com/path').origin, 'https://example.com');
  assert.throws(() => normalizeTarget(''));
  assert.throws(() => normalizeTarget('localhost'));
});

test('parseRobots groups rules by user-agent and collects sitemaps', () => {
  const parsed = parseRobots([
    'User-agent: GPTBot',
    'Disallow: /',
    '',
    'User-agent: Googlebot',
    'Disallow: /private',
    '',
    'Sitemap: https://example.com/sitemap.xml',
  ].join('\n'));

  assert.equal(parsed.groups.length, 2);
  assert.deepEqual(parsed.groups[0].agents, ['gptbot']);
  assert.deepEqual(parsed.sitemaps, ['https://example.com/sitemap.xml']);
});

test('botStance reports blocked, allowed and unlisted', () => {
  const parsed = parseRobots([
    'User-agent: GPTBot',
    'Disallow: /',
    'User-agent: ClaudeBot',
    'Disallow: /private',
  ].join('\n'));

  assert.equal(botStance(parsed.groups, 'GPTBot'), 'blocked');
  assert.equal(botStance(parsed.groups, 'ClaudeBot'), 'allowed');
  assert.equal(botStance(parsed.groups, 'PerplexityBot'), 'unlisted');
});

test('a well-prepared site scores full marks', async () => {
  const server = await makeServer({
    '/': HOME,
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/llms.txt': '# Example\n> a clinic\n',
    '/sitemap.xml': '<urlset><url><loc>https://example.com/a</loc></url></urlset>',
  });
  const { port } = server.address();
  try {
    const report = await audit('http://127.0.0.1:' + port);
    assert.equal(report.score, 100);
    assert.equal(report.coverage, 100);
    assert.equal(report.grade, 'A');
    assert.equal(report.counts.absent, 0);
  } finally {
    server.close();
  }
});

test('blocking GPTBot is reported as an absent check, not an unknown', async () => {
  const server = await makeServer({
    '/': HOME,
    '/robots.txt': 'User-agent: GPTBot\nDisallow: /',
    '/llms.txt': 'ok',
    '/sitemap.xml': '<urlset><url><loc>https://example.com/a</loc></url></urlset>',
  });
  const { port } = server.address();
  try {
    const report = await audit('http://127.0.0.1:' + port);
    const crawlers = report.checks.find((c) => c.id === 'ai_crawlers');
    assert.equal(crawlers.status, 'absent');
    assert.match(crawlers.detail, /GPTBot/);
    assert.ok(report.score < 100);
  } finally {
    server.close();
  }
});

test('server errors become unknown, never absent', async () => {
  const server = await makeServer({
    '/': HOME,
    '/robots.txt': 500,
    '/llms.txt': 500,
    '/sitemap.xml': 500,
  });
  const { port } = server.address();
  try {
    const report = await audit('http://127.0.0.1:' + port);
    assert.equal(report.counts.unknown, 3);
    assert.equal(report.coverage, 40);
    // the score is computed over judged checks only
    assert.equal(report.score, 100);
  } finally {
    server.close();
  }
});

test('a site with no AI files at all is absent, not unknown', async () => {
  const server = await makeServer({ '/': '<html><head><title>x</title></head></html>' });
  const { port } = server.address();
  try {
    const report = await audit('http://127.0.0.1:' + port);
    assert.equal(report.counts.unknown, 0);
    assert.equal(report.counts.absent, 4);
    // no robots.txt cannot block a crawler, so access still earns its points
    assert.equal(report.score, 30);
    assert.equal(report.grade, 'D');
  } finally {
    server.close();
  }
});

test('a missing robots.txt is described as open by default', async () => {
  const server = await makeServer({ '/': HOME });
  const { port } = server.address();
  try {
    const report = await audit('http://127.0.0.1:' + port);
    const crawlers = report.checks.find((c) => c.id === 'ai_crawlers');
    assert.equal(crawlers.status, 'present');
    assert.match(crawlers.detail, /allowed by default/);
  } finally {
    server.close();
  }
});

test('an HTML catch-all route is not mistaken for llms.txt', async () => {
  const shell = '<!DOCTYPE html><html><head><title>app</title></head><body></body></html>';
  const server = await makeServer({
    '/': shell,
    '/robots.txt': shell,
    '/llms.txt': shell,
    '/sitemap.xml': shell,
  });
  const { port } = server.address();
  try {
    const report = await audit('http://127.0.0.1:' + port);
    const llms = report.checks.find((c) => c.id === 'llms_txt');
    const sitemap = report.checks.find((c) => c.id === 'sitemap');
    assert.equal(llms.status, 'absent');
    assert.match(llms.detail, /catch-all/);
    assert.equal(sitemap.status, 'absent');
    assert.match(sitemap.detail, /catch-all/);
  } finally {
    server.close();
  }
});

test('looksLikeHtml detects documents but not text files', () => {
  assert.equal(looksLikeHtml('<!DOCTYPE html><html></html>'), true);
  assert.equal(looksLikeHtml('<html><head></head></html>'), true);
  assert.equal(looksLikeHtml('# Example\n> a clinic\n'), false);
  assert.equal(looksLikeHtml('User-agent: *\nAllow: /'), false);
});

test('AI_BOTS covers the crawlers that matter for AI answers', () => {
  for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']) {
    assert.ok(AI_BOTS.includes(bot), bot + ' should be tracked');
  }
});
