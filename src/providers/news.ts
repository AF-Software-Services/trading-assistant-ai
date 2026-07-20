export interface NewsItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
  source: string;
  sentiment: "bullish" | "bearish" | "neutral";
}

const PAIR_KEYWORDS: Record<string, string[]> = {
  "EUR/USD": ["EUR", "euro", "USD", "dollar", "Fed", "ECB", "Federal Reserve", "European Central Bank"],
  "GBP/USD": ["GBP", "pound", "sterling", "USD", "dollar", "Fed", "BOE", "Bank of England"],
  "GBP/CAD": ["GBP", "pound", "CAD", "Canadian", "BOC", "Bank of Canada", "BOE", "Bank of England"],
  "USD/JPY": ["JPY", "yen", "USD", "dollar", "BOJ", "Bank of Japan", "Fed"],
  "EUR/GBP": ["EUR", "euro", "GBP", "pound", "ECB", "BOE"],
  "AUD/USD": ["AUD", "Australian", "USD", "dollar", "RBA", "Reserve Bank of Australia", "Fed"],
  // Indices — added alongside the cTrader migration's 10 new instruments, but this table
  // was never updated at the time, so news lookups for any of these silently returned zero
  // headlines (isRelevant() treats a missing entry as "not relevant", not an error).
  "US500":     ["S&P 500", "S&P", "Wall Street", "US stocks", "equities", "Fed", "Federal Reserve"],
  "NAS100":    ["Nasdaq", "tech stocks", "Wall Street", "US stocks", "equities", "Fed"],
  "GER40":     ["DAX", "German stocks", "Germany", "ECB", "European stocks", "eurozone"],
  "UK100":     ["FTSE", "UK stocks", "London", "BOE", "Bank of England", "British"],
  // Commodities
  "XAU/USD":   ["gold", "XAU", "bullion", "safe haven", "Fed", "dollar"],
  "XAG/USD":   ["silver", "XAG", "bullion", "precious metal"],
  "WTI/USD":   ["WTI", "crude oil", "oil price", "OPEC", "crude"],
  "BRENT/USD": ["Brent", "crude oil", "oil price", "OPEC"],
  "NATGAS":    ["natural gas", "nat gas", "gas price", "LNG"],
  "COPPER":    ["copper", "industrial metal", "base metal", "China demand"],
};

const BULLISH_WORDS = ["rally", "rise", "gain", "surge", "strength", "bullish", "higher", "uptick", "recover", "bounce", "hawkish", "beat", "strong"];
const BEARISH_WORDS = ["fall", "drop", "decline", "weak", "bearish", "lower", "sell", "pressure", "plunge", "slump", "dovish", "miss", "soft"];

const RSS_SOURCES = [
  { url: "https://www.dailyfx.com/feeds/all",         name: "DailyFX" },
  { url: "https://www.forexlive.com/feed/news",        name: "ForexLive" },
];

function extractTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  return m[1]!
    .trim()
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, ""); // strip any inner HTML tags
}

function parseRssItems(xml: string, sourceName: string): Omit<NewsItem, "sentiment">[] {
  const items: Omit<NewsItem, "sentiment">[] = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemPattern.exec(xml)) !== null) {
    const block = m[1]!;
    const title   = extractTag(block, "title");
    const link    = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const description = extractTag(block, "description").slice(0, 300);
    if (title) items.push({ title, link, pubDate, description, source: sourceName });
  }
  return items;
}

function scoreSentiment(text: string): "bullish" | "bearish" | "neutral" {
  const lower = text.toLowerCase();
  const b = BULLISH_WORDS.filter(w => lower.includes(w)).length;
  const br = BEARISH_WORDS.filter(w => lower.includes(w)).length;
  if (b > br) return "bullish";
  if (br > b) return "bearish";
  return "neutral";
}

function isRelevant(item: Omit<NewsItem, "sentiment">, pair: string): boolean {
  const keywords = PAIR_KEYWORDS[pair];
  if (!keywords) return false;
  const text = (item.title + " " + item.description).toLowerCase();
  // Require at least 2 keyword matches to avoid false positives (e.g. "dollar" alone)
  const matches = keywords.filter(k => text.includes(k.toLowerCase()));
  return matches.length >= 2;
}

export interface PairNews {
  pair: string;
  items: NewsItem[];
  cachedAt: number;
  sentiment: { bullish: number; bearish: number; neutral: number; overall: "bullish" | "bearish" | "neutral" };
}

export async function fetchNewsForPair(pair: string, kv: KVNamespace): Promise<PairNews> {
  const cacheKey = `news:${pair}`;

  // Try KV cache (1hr TTL)
  const cached = await kv.get(cacheKey, "json") as PairNews | null;
  if (cached) return cached;

  // Fetch all RSS sources in parallel
  const fetches = RSS_SOURCES.map(async src => {
    try {
      const res = await fetch(src.url, {
        headers: { "User-Agent": "TradingAssistant/1.0" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const xml = await res.text();
      return parseRssItems(xml, src.name);
    } catch {
      return [];
    }
  });

  const allItems = (await Promise.all(fetches)).flat();

  // Filter to pair-relevant items, deduplicate by title, take most recent 10
  const seen = new Set<string>();
  const relevant: NewsItem[] = [];
  for (const item of allItems) {
    if (seen.has(item.title)) continue;
    if (!isRelevant(item, pair)) continue;
    seen.add(item.title);
    relevant.push({ ...item, sentiment: scoreSentiment(item.title + " " + item.description) });
  }

  // Sort by pubDate descending (most recent first)
  relevant.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return tb - ta;
  });

  const items = relevant.slice(0, 10);

  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  for (const i of items) counts[i.sentiment]++;
  const overall: "bullish" | "bearish" | "neutral" =
    counts.bullish > counts.bearish ? "bullish" :
    counts.bearish > counts.bullish ? "bearish" : "neutral";

  const result: PairNews = {
    pair,
    items,
    cachedAt: Date.now(),
    sentiment: { ...counts, overall },
  };

  await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });
  return result;
}
