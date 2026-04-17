// =======================================================================
//  Inversiones Adriana — Earnings Date Auto-Updater
//  Uses Claude AI with web search to find confirmed earnings dates
//  Runs via GitHub Actions weekly
// =======================================================================

import { readFileSync, writeFileSync } from 'fs';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

// Read index.html and extract international tickers
const html = readFileSync('index.html', 'utf8');

// Extract lines with yf: field (international tickers)
const tickerRegex = /\{t:"([^"]+)",n:"([^"]+)",s:"([^"]*)",x:"([^"]*)",yf:"([^"]*)",q:\[(.*?)\]\}/g;
const tickers = [];
let match;
while ((match = tickerRegex.exec(html)) !== null) {
  tickers.push({
    ticker: match[1],
    name: match[2],
    sector: match[3],
    exchange: match[4],
    yf: match[5],
    quartersRaw: match[6],
    fullMatch: match[0]
  });
}

console.log(`Found ${tickers.length} international tickers to verify.`);
if (!tickers.length) { console.log('No tickers to update.'); process.exit(0); }

// Build the ticker list for Claude
const tickerList = tickers.map(t => `${t.ticker} (${t.name}) — ${t.exchange}`).join('\n');

// Call Claude API with web search
async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
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

// Extract text from Claude response (may contain multiple content blocks)
function extractText(response) {
  return response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

// Process in batches of 10
const BATCH_SIZE = 10;
const updatedDates = {};

for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
  const batch = tickers.slice(i, i + BATCH_SIZE);
  const batchList = batch.map(t => `- ${t.ticker} (${t.name})`).join('\n');

  console.log(`\nBatch ${Math.floor(i/BATCH_SIZE)+1}: Searching dates for ${batch.length} tickers...`);

  const today = new Date().toISOString().split('T')[0];
  const prompt = `Today is ${today}. I need the EXACT CONFIRMED next earnings date for each of these stocks. Search the web for each one — check TipRanks, Investing.com, Nasdaq.com, or the company's IR page.

${batchList}

For each ticker, respond with ONLY a JSON array in this exact format, no other text:
[
  {"ticker": "CERT", "date": "2026-05-11", "quarter": "Q1 26", "status": "confirmed", "source": "company IR"},
  {"ticker": "GLOB", "date": "2026-05-14", "quarter": "Q1 26", "status": "estimated", "source": "TipRanks"}
]

Rules:
- "date" must be YYYY-MM-DD format
- "status" must be "confirmed" (from company IR/press release/SEC filing) or "estimated" (from aggregator sites)
- If you find a date for the NEXT upcoming earnings (after today ${today}), use that
- If the next earnings already passed, search for the one after that
- If you cannot find ANY date, set date to "" and status to "unknown"
- Only return the JSON array, nothing else`;

  try {
    const response = await callClaude(prompt);
    const text = extractText(response);

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const results = JSON.parse(jsonMatch[0]);
      for (const r of results) {
        if (r.ticker && r.date) {
          updatedDates[r.ticker] = {
            date: r.date,
            quarter: r.quarter || '',
            status: r.status || 'estimated',
            source: r.source || ''
          };
          console.log(`  ✓ ${r.ticker}: ${r.date} (${r.status} — ${r.source})`);
        } else if (r.ticker) {
          console.log(`  · ${r.ticker}: no date found`);
        }
      }
    } else {
      console.warn('  ⚠ Could not parse Claude response for this batch');
      console.warn('  Response:', text.substring(0, 200));
    }
  } catch (e) {
    console.error(`  ✗ Batch failed:`, e.message);
  }

  // Rate limit: wait 2s between batches
  if (i + BATCH_SIZE < tickers.length) {
    await new Promise(r => setTimeout(r, 2000));
  }
}

// Update index.html with new dates
let updatedHtml = html;
let changeCount = 0;

for (const t of tickers) {
  const update = updatedDates[t.ticker];
  if (!update || !update.date) continue;

  // Parse existing quarters
  const qRegex = /\{q:"([^"]*)",d:"([^"]*)"/g;
  const quarters = [];
  let qm;
  while ((qm = qRegex.exec(t.quartersRaw)) !== null) {
    quarters.push({ label: qm[1], date: qm[2] });
  }

  // Find the quarter to update (match by label or find next empty/outdated)
  let updated = false;
  const newQuarters = quarters.map(q => {
    // If the quarter label matches, update the date
    if (update.quarter && q.label === update.quarter && q.date !== update.date) {
      updated = true;
      return { ...q, date: update.date };
    }
    return q;
  });

  // If no label match, try to update the first upcoming quarter with a different date
  if (!updated && update.date) {
    const today = new Date();
    const updateDate = new Date(update.date);
    for (let qi = 0; qi < newQuarters.length; qi++) {
      const existingDate = newQuarters[qi].date ? new Date(newQuarters[qi].date) : null;
      if (!existingDate || (existingDate > today && Math.abs(existingDate - updateDate) > 5 * 86400000)) {
        // Date differs by more than 5 days — update it
        if (existingDate && Math.abs(existingDate - updateDate) > 5 * 86400000) {
          newQuarters[qi] = { ...newQuarters[qi], date: update.date };
          updated = true;
          break;
        }
      }
      if (!existingDate) {
        newQuarters[qi] = { ...newQuarters[qi], date: update.date };
        updated = true;
        break;
      }
    }
  }

  if (updated) {
    // Rebuild the quarters array string
    const newQStr = newQuarters.map(q => `{q:"${q.label}",d:"${q.date}"}`).join(',');
    const newLine = t.fullMatch.replace(t.quartersRaw, newQStr);

    // Also add/update the comment
    const commentTag = `/*${update.status} ${update.source} ${new Date().toISOString().split('T')[0]}*/`;
    const oldLineWithComment = new RegExp(
      t.fullMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(,?\\/\\*.*?\\*\\/)?'
    );

    updatedHtml = updatedHtml.replace(oldLineWithComment, newLine + ',' + commentTag);
    changeCount++;
    console.log(`\n  📝 Updated ${t.ticker}: ${quarters.map(q=>q.date).join(',')} → ${newQuarters.map(q=>q.date).join(',')}`);
  }
}

if (changeCount > 0) {
  writeFileSync('index.html', updatedHtml);
  console.log(`\n✅ Updated ${changeCount} ticker(s) in index.html`);
} else {
  console.log('\n✅ All dates are up to date. No changes needed.');
}
