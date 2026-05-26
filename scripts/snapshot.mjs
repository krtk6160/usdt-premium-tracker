// Fetches current USDT/INR premium from Binance P2P + forex rate,
// appends a snapshot to data/premium-history.json.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const HISTORY_PATH = "data/premium-history.json";
const MAX_POINTS = 24 * 365 * 3; // ~3 years of hourly data
const MIN_BUY_AMOUNT_INR = 5000;
const P2P_ROWS = 20;
const P2P_MAX_PAGES = 3;
const SMOOTHING_WINDOW = 5;

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchP2PPage(page) {
  return fetchJSON(
    "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify({
        proMerchantAds: false,
        page,
        rows: P2P_ROWS,
        payTypes: ["UPI", "IMPS"],
        countries: [],
        publisherType: null,
        asset: "USDT",
        fiat: "INR",
        tradeType: "BUY",
        transAmount: String(MIN_BUY_AMOUNT_INR),
      }),
    }
  );
}

async function getP2POffers() {
  const offers = [];

  for (let page = 1; page <= P2P_MAX_PAGES; page++) {
    const data = await fetchP2PPage(page);
    const pageOffers = data.data || [];
    offers.push(...pageOffers);

    const total = Number(data.total);
    if (pageOffers.length < P2P_ROWS || (Number.isFinite(total) && offers.length >= total)) {
      break;
    }
  }

  return offers;
}

function isAllowedMethod(method) {
  const normalized = String(
    method?.identifier || method?.tradeMethodName || method?.methodName || ""
  )
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return normalized === "upi" || normalized === "lightningupi" || normalized === "imps";
}

function hasNoAdditionalKyc(offer) {
  const required = Number(offer?.adv?.takerAdditionalKycRequired || 0);
  const extraItems = offer?.adv?.adAdditionalKycVerifyItems;
  return required === 0 && (!Array.isArray(extraItems) || extraItems.length === 0);
}

function parseOffer(offer) {
  const price = parseFloat(offer?.adv?.price);
  const surplus = parseFloat(offer?.adv?.surplusAmount);
  const minAmount = parseFloat(offer?.adv?.minSingleTransAmount);
  const maxAmount = parseFloat(offer?.adv?.maxSingleTransAmount);
  const monthOrderCount = Number(offer?.advertiser?.monthOrderCount || 0);
  const monthFinishRate = Number(offer?.advertiser?.monthFinishRate || 0);
  const tradeMethods = offer?.adv?.tradeMethods || [];

  return {
    raw: offer,
    price,
    surplus,
    minAmount,
    maxAmount,
    monthOrderCount,
    monthFinishRate,
    isAllowedPayment: tradeMethods.some(isAllowedMethod),
    hasNoAdditionalKyc: hasNoAdditionalKyc(offer),
  };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function trimPriceBand(offers) {
  if (offers.length < 8) return offers;
  const trimCount = Math.max(1, Math.floor(offers.length * 0.1));
  return offers.slice(trimCount, offers.length - trimCount);
}

function selectUsdtInr(offers) {
  const baseOffers = offers
    .map(parseOffer)
    .filter((offer) => Number.isFinite(offer.price))
    .filter((offer) => offer.isAllowedPayment)
    .filter((offer) => offer.hasNoAdditionalKyc)
    .filter((offer) => offer.maxAmount >= MIN_BUY_AMOUNT_INR)
    .sort((a, b) => a.price - b.price);

  const tiers = [
    { minSurplus: 100, minOrders: 50, minFinishRate: 0.95 },
    { minSurplus: 50, minOrders: 25, minFinishRate: 0.90 },
    { minSurplus: 0, minOrders: 0, minFinishRate: 0 },
  ];

  let eligible = [];
  for (const tier of tiers) {
    eligible = baseOffers.filter((offer) =>
      offer.surplus >= tier.minSurplus &&
      offer.monthOrderCount >= tier.minOrders &&
      offer.monthFinishRate >= tier.minFinishRate
    );
    if (eligible.length >= 8) break;
  }

  if (eligible.length === 0) {
    throw new Error("No Binance P2P offers found after filtering");
  }

  const usableOffers = trimPriceBand(eligible.slice(0, 20));
  const price = median(usableOffers.map((offer) => offer.price));

  return {
    price,
    offersFetched: offers.length,
    offersEligible: eligible.length,
    offersUsed: usableOffers.length,
    priceMin: usableOffers[0]?.price,
    priceMax: usableOffers[usableOffers.length - 1]?.price,
  };
}

async function getUsdtInrSnapshot() {
  return selectUsdtInr(await getP2POffers());
}

function smoothPremium(rawPremium, history) {
  const recentPremiums = history
    .slice(-(SMOOTHING_WINDOW - 1))
    .map((point) => Number(point.rawPremium ?? point.premium))
    .filter(Number.isFinite);

  return median([...recentPremiums, rawPremium]);
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
  const [snapshot, fx] = await Promise.all([
    getUsdtInrSnapshot(),
    fetchJSON("https://open.er-api.com/v6/latest/USD"),
  ]);

  const usdtInr = snapshot.price;
  const usdInr = Number(fx?.rates?.INR);

  if (!Number.isFinite(usdtInr) || !Number.isFinite(usdInr)) {
    throw new Error(`Bad values: usdtInr=${usdtInr} usdInr=${usdInr}`);
  }

  const history = await loadHistory();
  const rawPremium = ((usdtInr - usdInr) / usdInr) * 100;
  const premium = smoothPremium(rawPremium, history);
  const point = {
    ts: Math.floor(Date.now() / 1000),
    usdtInr: Number(usdtInr.toFixed(4)),
    usdInr: Number(usdInr.toFixed(4)),
    rawPremium: Number(rawPremium.toFixed(4)),
    premium: Number(premium.toFixed(4)),
    offersFetched: snapshot.offersFetched,
    offersEligible: snapshot.offersEligible,
    offersUsed: snapshot.offersUsed,
    offerPriceMin: Number(snapshot.priceMin.toFixed(4)),
    offerPriceMax: Number(snapshot.priceMax.toFixed(4)),
  };

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
