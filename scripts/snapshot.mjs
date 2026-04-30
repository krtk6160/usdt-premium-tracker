// Fetches current USDT/INR premium from Binance P2P + forex rate,
// appends a snapshot to data/premium-history.json.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const HISTORY_PATH = "data/premium-history.json";
const MAX_POINTS = 24 * 365 * 3; // ~3 years of hourly data

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function getUsdtInr() {
  const data = await fetchJSON(
    "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify({
        proMerchantAds: false,
        page: 1,
        rows: 20,
        payTypes: ["UPI", "IMPS"],
        countries: [],
        publisherType: null,
        asset: "USDT",
        fiat: "INR",
        tradeType: "BUY",
        transAmount: "5000",
      }),
    }
  );

  const isAllowedMethod = (method) => {
    const normalized = String(
      method?.identifier || method?.tradeMethodName || method?.methodName || ""
    )
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    return normalized === "upi" || normalized === "lightningupi" || normalized === "imps";
  };

  const hasNoAdditionalKyc = (offer) => {
    const required = Number(offer?.adv?.takerAdditionalKycRequired || 0);
    const extraItems = offer?.adv?.adAdditionalKycVerifyItems;
    return required === 0 && (!Array.isArray(extraItems) || extraItems.length === 0);
  };

  const sorted = (data.data || [])
    .filter((o) => Number.isFinite(parseFloat(o.adv.price)))
    .filter((o) => (o.adv.tradeMethods || []).some(isAllowedMethod))
    .filter(hasNoAdditionalKyc)
    .sort((a, b) => parseFloat(a.adv.price) - parseFloat(b.adv.price))
    .slice(0, 10);

  if (sorted.length === 0) throw new Error("No Binance P2P offers found");

  const prices = sorted.map((o) => parseFloat(o.adv.price));
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 1
    ? prices[mid]
    : (prices[mid - 1] + prices[mid]) / 2;
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
  const [usdtInr, fx] = await Promise.all([
    getUsdtInr(),
    fetchJSON("https://open.er-api.com/v6/latest/USD"),
  ]);

  const usdInr = Number(fx?.rates?.INR);

  if (!Number.isFinite(usdtInr) || !Number.isFinite(usdInr)) {
    throw new Error(`Bad values: usdtInr=${usdtInr} usdInr=${usdInr}`);
  }

  const premium = ((usdtInr - usdInr) / usdInr) * 100;
  const point = {
    ts: Math.floor(Date.now() / 1000),
    usdtInr: Number(usdtInr.toFixed(4)),
    usdInr: Number(usdInr.toFixed(4)),
    premium: Number(premium.toFixed(4)),
  };

  const history = await loadHistory();
  history.push(point);
  if (history.length > MAX_POINTS) history.splice(0, history.length - MAX_POINTS);

  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  await writeFile(HISTORY_PATH, JSON.stringify(history) + "\n");

  console.log(`Appended snapshot: ${JSON.stringify(point)} (total ${history.length})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
