// =======================================================================
//  Inversiones Adriana — Earnings Date Auto-Updater
//  Uses Claude AI with web search to find confirmed earnings dates
//  Runs via GitHub Actions weekly
// =======================================================================

import { readFileSync, writeFileSync } from 'fs';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

const html = readFileSync('index.html', 'utf8');

// Extract international tickers (those with yf: field)
const tickerRegex = /\{t:"([^"]+)",n:"([^"]+)",s:"([^"]*)",x:"([^"]*)",yf:"([^"]*)",q:\[(.*?)\]\}/g;
const tickers = [];
let match;
while ((match = tickerRegex.exec(html)) !== null) {
  // Parse existing quarters
  const qRegex = /\{q:"([^"]*)",d:"([^"]*)"/g;
  const quarters = [];
  let qm;
  while ((qm = qRegex.exec(match[6])) !== null) {
    quarters.push({ label: qm[1], date: qm[2] });
  }
  tickers.push({
    ticker: match[1],
    name: match[2],
    sector: match[3],
    exchange: match[4],
    yf: match[5],
    quartersRaw: match[6],
    quarters,
    fullMatch: match[0]
  });
}

console.log(`Found ${tickers.length} international tickers to verify.`);
if (!tickers.length) { console.log('No tickers to update.'); process.exit(0); }

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 8000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }
  return res.json();
}

function extractText(response) {
  return response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

const BATCH_SIZE = 5;
const updatedDates = {};

const today = new Date().toISOString().split('T')[0];

for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
  const batch = tickers.slice(i, i + BATCH_SIZE);
  const batchInfo = batch.map(t => {
    const qs = t.quarters.map(q => `"${q.label}"`).join(', ');
    return `- ${t.ticker} (${t.name}) — quarters to find: [${qs}]`;
  }).join('\n');

  console.log(`\nBatch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(tickers.length/BATCH_SIZE)}: ${batch.length} tickers...`);

  const prompt = `Today is ${today}. Find the earnings report dates for each of these stocks and EACH specific quarter listed. Search the web (TipRanks, Investing.com, Nasdaq.com, company IR pages, SEC filings).

${batchInfo}

For EACH ticker, return the date for EACH of the quarters listed. Respond with ONLY a JSON array, no other text:

[
  {"ticker": "CERT", "dates": {"Q1 26": "2026-05-13", "Q2 26": "2026-08-06", "Q3 26": "2026-11-05"}, "status": "confirmed", "source": "company IR"},
  {"ticker": "GLOB", "dates": {"Q1 26": "2026-05-14", "Q2 26": "2026-08-13", "Q3 26": "2026-11-12"}, "status": "estimated", "source": "TipRanks"}
]

Rules:
- Return ALL quarter labels for each ticker exactly as given in the input
- "dates" is an object mapping each quarter label to YYYY-MM-DD
- If you can only find one confirmed date (e.g. Q1 confirmed), provide it. For future quarters that are estimates, use typical quarterly pattern (~90 days apart from Q1)
- If a specific quarter's date cannot be found or estimated, use empty string ""
- "status" = "confirmed" if Q1/next earnings is from company IR/SEC, "estimated" otherwise
- "source" = where you found the primary date
- Only return the JSON array, nothing else`;

  try {
    const response = await callClaude(prompt);
    const text = extractText(response);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const results = JSON.parse(jsonMatch[0]);
      for (const r of results) {
        if (r.ticker && r.dates) {
          updatedDates[r.ticker] = {
            dates: r.dates,
            status: r.status || 'estimated',
            source: r.source || ''
          };
          const summary = Object.entries(r.dates).map(([q, d]) => `${q}=${d || 'none'}`).join(', ');
          console.log(`  ✓ ${r.ticker}: ${summary} (${r.status} — ${r.source})`);
        }
      }
    } else {
      console.warn('  ⚠ Could not parse response. First 200 chars:', text.substring(0, 200));
    }
  } catch (e) {
    console.error(`  ✗ Batch failed:`, e.message);
  }

  if (i + BATCH_SIZE < tickers.length) {
    console.log('  ⏳ Waiting 65s for rate limit...');
    await new Promise(r => setTimeout(r, 65000));
  }
}

// Update index.html
let updatedHtml = html;
let changeCount = 0;

for (const t of tickers) {
  const update = updatedDates[t.ticker];
  if (!update || !update.dates) continue;

  let hasChanges = false;
  const newQuarters = t.quarters.map(q => {
    const newDate = update.dates[q.label];
    if (newDate && newDate !== q.date) {
      hasChanges = true;
      return { ...q, date: newDate };
    }
    return q;
  });

  if (hasChanges) {
    const newQStr = newQuarters.map(q => `{q:"${q.label}",d:"${q.date}"}`).join(',');
    const newLine = t.fullMatch.replace(t.quartersRaw, newQStr);

    const escapedMatch = t.fullMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const oldLineWithComment = new RegExp(escapedMatch + '(,\\/\\*[^*]*\\*\\/)?');

    const commentTag = `/*auto ${update.status} ${update.source || '?'} ${today}*/`;
    updatedHtml = updatedHtml.replace(oldLineWithComment, newLine + ',' + commentTag);
    changeCount++;

    const before = t.quarters.map(q => `${q.label}=${q.date || '-'}`).join(' | ');
    const after = newQuarters.map(q => `${q.label}=${q.date || '-'}`).join(' | ');
    console.log(`  📝 ${t.ticker}:`);
    console.log(`     before: ${before}`);
    console.log(`     after:  ${after}`);
  }
}

if (changeCount > 0) {
  writeFileSync('index.html', updatedHtml);
  console.log(`\n✅ Updated ${changeCount} ticker(s) in index.html`);
} else {
  console.log('\n✅ All dates up to date. No changes needed.');
}
