#!/usr/bin/env node
// JSON-LD Price Watch — zero-dependency Node.js CLI (Node >= 18).
// Fetches product pages, extracts schema.org Product/Offer JSON-LD,
// snapshots prices locally, and reports changes between runs.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const targetsPath = new URL('./targets.json', import.meta.url);
const statePath = new URL('./state.json', import.meta.url);
const changesJsonPath = new URL('./changes.json', import.meta.url);
const changesMdPath = new URL('./changes.md', import.meta.url);
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 JSON-LD-Price-Watch/1.0';

// Some sites embed technically-invalid JSON (raw control characters inside
// strings). Strip them before JSON.parse instead of failing the whole target.
function cleanJson(text) {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
}

function parseBlocks(html) {
  const objects = [];
  const pattern = /<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      objects.push(JSON.parse(cleanJson(match[2].trim())));
    } catch (error) {
      console.warn(`Skipping an invalid JSON-LD block: ${error.message}`);
    }
  }
  return objects;
}

function typesOf(item) {
  const value = item?.['@type'];
  const list = Array.isArray(value) ? value : [value];
  return list.filter(Boolean).map((type) => String(type).toLowerCase().split('/').pop());
}

// Flatten nested structures, including @graph arrays.
function walk(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, output);
  } else if (value && typeof value === 'object') {
    output.push(value);
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') walk(child, output);
    }
  }
  return output;
}

function scalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return scalar(value[0]);
  if (typeof value === 'object') return scalar(value['@id'] ?? value.name ?? value.url);
  return null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/[^\d.,-]/g, '').replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function normalizeOffer(offer) {
  const price = toNumber(offer.price ?? offer.lowPrice ?? offer.highPrice);
  if (price === null) return null;
  return {
    price,
    priceCurrency: scalar(offer.priceCurrency),
    availability: scalar(offer.availability),
    url: scalar(offer.url),
  };
}

function normalize(objects, pageUrl) {
  const all = objects.flatMap((object) => walk(object));
  const products = all.filter((item) => typesOf(item).includes('product'));
  const offersByIndex = new Map(all.map((item, index) => [index, item]));
  const seen = new Set();
  const results = [];

  const push = (name, url, offer) => {
    const normalized = normalizeOffer(offer);
    if (!normalized) return;
    const entry = {
      name: name || 'Unnamed product',
      url: url || normalized.url || pageUrl,
      price: normalized.price,
      priceCurrency: normalized.priceCurrency,
      availability: normalized.availability,
    };
    const fingerprint = JSON.stringify(entry);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    results.push(entry);
  };

  for (const product of products) {
    const name = scalar(product.name);
    const url = scalar(product.url) || pageUrl;
    // Offers may be embedded directly or referenced by @id.
    const refs = (Array.isArray(product.offers) ? product.offers : product.offers ? [product.offers] : []);
    let linked = 0;
    for (const ref of refs) {
      if (ref && typeof ref === 'object') push(name, url, ref);
      else if (typeof ref === 'string') {
        for (const candidate of offersByIndex.values()) {
          if (candidate?.['@id'] === ref) { push(name, url, candidate); linked++; }
        }
      }
    }
    if (!refs.length) push(name, url, product);
  }

  // Standalone Offer nodes with a price but no owning Product are still useful.
  for (const item of all) {
    if (!typesOf(item).includes('offer')) continue;
    push(scalar(item.itemOffered?.name) ?? 'Unnamed offer', scalar(item.url) || pageUrl, item);
  }
  return results;
}

async function fetchHtml(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(25000),
    });
    if (response.ok) return await response.text();
    console.warn(`HTTP ${response.status} from Node fetch for ${url}; falling back to curl.`);
  } catch (error) {
    console.warn(`Node fetch failed for ${url}: ${error.message}; falling back to curl.`);
  }
  // Some sites block Node's TLS fingerprint but allow curl.
  const args = ['-L', '--fail', '--silent', '--show-error', '--max-time', '30',
    '-A', USER_AGENT, '-H', 'Accept: text/html,application/xhtml+xml', url];
  const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) throw new Error(`curl failed for ${url} (exit ${code}): ${stderr.trim()}`);
  return stdout;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function renderMarkdown(checkedAt, changes) {
  const lines = ['# Price Watch Changes', '', `Last checked: ${checkedAt}`, ''];
  if (!changes.length) {
    lines.push('No changes detected.', '');
    return `${lines.join('\n')}`;
  }
  for (const change of changes) {
    lines.push(`## ${change.type === 'baseline' ? 'Baseline created' : `Price ${change.type}`} — ${change.name}`, '');
    lines.push(`- URL: ${change.url}`);
    lines.push(`- Price: ${change.previousPrice ?? '—'} → ${change.price} ${change.priceCurrency ?? ''}`.trimEnd());
    lines.push(`- Availability: ${change.availability ?? 'unknown'}`, '');
  }
  return lines.join('\n');
}

async function main() {
  const targets = await readJson(targetsPath, []);
  if (!Array.isArray(targets) || !targets.length) {
    throw new Error('targets.json must contain at least one target URL.');
  }
  const previous = await readJson(statePath, {});
  const next = { ...previous };
  const changes = [];
  let checked = 0;

  for (const target of targets) {
    const url = typeof target === 'string' ? target : target?.url;
    if (!url || !/^https?:\/\//i.test(url)) {
      console.warn(`Skipping invalid target: ${JSON.stringify(target)}`);
      continue;
    }
    console.log(`Checking ${url}`);
    let html;
    try {
      html = await fetchHtml(url);
    } catch (error) {
      console.warn(`Skipping unreachable target ${url}: ${error.message}`);
      continue;
    }
    const products = normalize(parseBlocks(html), url);
    if (!products.length) {
      console.warn(`No Product/Offer JSON-LD with a usable price found at ${url}.`);
      continue;
    }
    checked += 1;
    // Stable per-run key: same URL + product name, disambiguated by order.
    const counts = new Map();
    for (const product of products) {
      const order = counts.get(product.name) ?? 0;
      counts.set(product.name, order + 1);
      const key = `${url}#${product.name}#${order}`;
      const old = previous[key];
      const snapshot = { ...product, checkedAt: new Date().toISOString() };
      next[key] = snapshot;
      if (!old) {
        changes.push({ ...snapshot, type: 'baseline', previousPrice: null });
        console.log(`Baseline created: ${product.name} — ${product.price} ${product.priceCurrency ?? ''}`);
      } else if (Number(old.price) !== product.price) {
        const type = product.price < Number(old.price) ? 'drop' : 'rise';
        changes.push({ ...snapshot, type, previousPrice: Number(old.price) });
        console.log(`Price ${type}: ${product.name} — ${old.price} → ${product.price} ${product.priceCurrency ?? ''}`);
      } else {
        console.log(`No changes: ${product.name} — ${product.price} ${product.priceCurrency ?? ''}`);
      }
    }
  }

  const checkedAt = new Date().toISOString();
  await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`);
  await writeFile(changesJsonPath, `${JSON.stringify({ checkedAt, changes }, null, 2)}\n`);
  await writeFile(changesMdPath, renderMarkdown(checkedAt, changes));

  if (!checked) throw new Error('No target produced a usable Product/Offer price.');
  if (!changes.length) console.log('Run complete: no changes detected.');
  else if (changes.every((change) => change.type === 'baseline')) console.log('Run complete: baseline created.');
  else console.log(`Run complete: ${changes.length} price change(s) recorded.`);
}

main().catch((error) => {
  console.error(`Price watch failed: ${error.message}`);
  process.exitCode = 1;
});
