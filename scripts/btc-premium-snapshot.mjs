// Fetches BTC/INR prices from Indian exchanges + CoinGecko,
// appends a snapshot to data/btc-premium-history.json.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const HISTORY_PATH = "data/btc-premium-history.json";
const MAX_POINTS = 24 * 365 * 3;

const EXCHANGES = [
  {
    name: "CoinDCX",
    fetch: () => fetchJSON("https://api.coindcx.com/exchange/ticker"),
    parse: (arr) => {
      const item = arr.find((i) => i.market === "BTCINR");
      return item ? parseFloat(item.ask) : null;
    },
  },
  {
    name: "ZebPay",
    fetch: () => fetchJSON("https://www.zebapi.com/api/v1/market/BTC-INR/ticker"),
    parse: (data) => parseFloat(data.market),
  },
  {
    name: "Unocoin",
    fetch: () => fetchJSON("https://api.unocoin.com/api/v1/exchange/tickers"),
    parse: (arr) => {
      const item = arr.find((i) => i.ticker_id === "BTC_INR");
      return item ? parseFloat(item.bid) : null;
    },
  },
  {
    name: "GetBit",
    fetch: () => fetchJSON("https://venus.getbitmoneyapp.com/uat/getBitcoinPriceV2"),
    parse: (data) => parseFloat(data.data.value),
  },
];

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function getCoinGecko() {
  const data = await fetchJSON(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=inr"
  );
  return parseFloat(data.bitcoin.inr);
}

async function loadHistory() {
  try {
    return JSON.parse(await readFile(HISTORY_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function main() {
  const [cg, ...exchangeResults] = await Promise.all([
    getCoinGecko(),
    ...EXCHANGES.map(async (ex) => {
      try {
        const data = await ex.fetch();
        return { name: ex.name, value: ex.parse(data) };
      } catch (err) {
        console.warn(`${ex.name} fetch failed:`, err.message);
        return { name: ex.name, value: null };
      }
    }),
  ]);

  if (!Number.isFinite(cg)) {
    throw new Error("CoinGecko price unavailable — cannot compute premium");
  }

  const point = {
    ts: Math.floor(Date.now() / 1000),
    coingecko: Math.round(cg),
  };

  let validCount = 0;
  for (const r of exchangeResults) {
    if (Number.isFinite(r.value) && r.value > 0) {
      point[r.name] = Math.round(r.value);
      validCount++;
    }
  }

  if (validCount < 2) {
    throw new Error(
      `Only ${validCount} exchanges returned valid data — skipping snapshot`
    );
  }

  const history = await loadHistory();
  history.push(point);
  if (history.length > MAX_POINTS) {
    history.splice(0, history.length - MAX_POINTS);
  }

  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  await writeFile(HISTORY_PATH, JSON.stringify(history) + "\n");

  console.log(
    `Appended BTC snapshot: ${JSON.stringify(point)} (total ${history.length})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
