const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");

const PORT = process.env.PORT || 3000;


// ======================================================
// SETTINGS
// ======================================================

// Keep Amazon search results in memory for one hour.
// This helps prevent repeated button presses from
// using unnecessary SerpApi searches.

const CACHE_TTL_MS = 60 * 60 * 1000;

const searchCache = new Map();


// Searches shared by Top 20 and Best Deals.

const DEAL_SEARCHES = [
  "amazon deals",
  "electronics deals",
  "home kitchen deals",
  "tools deals",
  "toys deals",
  "beauty deals",
  "automotive deals",
  "outdoor deals"
];


// ======================================================
// SEND JSON
// ======================================================

function sendJSON(res, statusCode, data) {

  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}


// ======================================================
// FETCH JSON
// ======================================================

function fetchJSON(url) {

  return new Promise((resolve, reject) => {

    https
      .get(url, response => {

        let data = "";

        response.on("data", chunk => {
          data += chunk;
        });

        response.on("end", () => {

          try {

            resolve(JSON.parse(data));

          } catch (error) {

            reject(
              new Error(
                "Could not read SerpApi response."
              )
            );

          }

        });

      })
      .on("error", reject);

  });

}


// ======================================================
// PRICE HELPERS
// ======================================================

function cleanNumber(value) {

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


function calculateDeal(currentPrice, oldPrice) {

  const current =
    cleanNumber(currentPrice);

  const old =
    cleanNumber(oldPrice);


  if (
    current === null ||
    current <= 0
  ) {

    return {
      price: null,
      oldPrice: null,
      savings: 0,
      discountPercent: 0,
      validDeal: false
    };

  }


  if (
    old === null ||
    old <= current ||
    old <= 0
  ) {

    return {
      price: current,
      oldPrice: null,
      savings: 0,
      discountPercent: 0,
      validDeal: false
    };

  }


  const savings =
    old - current;


  const discountPercent =
    Math.round(
      (savings / old) * 100
    );


  // Reject clearly broken or unreasonable
  // comparison-price relationships.

  if (
    discountPercent <= 0 ||
    discountPercent >= 90 ||
    old > current * 10
  ) {

    return {
      price: current,
      oldPrice: null,
      savings: 0,
      discountPercent: 0,
      validDeal: false
    };

  }


  return {

    price:
      current,

    oldPrice:
      old,

    savings:
      Number(
        savings.toFixed(2)
      ),

    discountPercent,

    validDeal:
      true

  };

}


// ======================================================
// CLEAN AMAZON LINK
// ======================================================

function buildAmazonLink(asin, fallbackLink) {

  if (asin) {

    return (
      `https://www.amazon.com/dp/${encodeURIComponent(asin)}`
    );

  }


  return fallbackLink || "";
}


// ======================================================
// NORMALIZE AMAZON PRODUCT
// ======================================================

function normalizeProduct(item) {

  const deal =
    calculateDeal(
      item.extracted_price,
      item.extracted_old_price
    );


  const asin =
    item.asin || "";


  return {

    asin,

    title:
      item.title ||
      "Amazon product",


    price:
      deal.price,


    priceText:
      deal.price !== null
        ? `$${deal.price.toFixed(2)}`
        : "",


    oldPrice:
      deal.oldPrice,


    oldPriceText:
      deal.oldPrice !== null
        ? `$${deal.oldPrice.toFixed(2)}`
        : "",


    savings:
      deal.savings,


    discountPercent:
      deal.discountPercent,


    validDeal:
      deal.validDeal,


    // IMPORTANT:
    // Price came from an Amazon search-results page.
    // It has NOT been independently verified against
    // the individual Amazon product page.

    priceVerified:
      false,


    priceSource:
      "Amazon search result via SerpApi",


    priceCheckedAt:
      new Date().toISOString(),


    rating:
      Number(item.rating) || null,


    reviews:
      Number(
        String(item.reviews || 0)
          .replace(/[^0-9]/g, "")
      ) || 0,


    prime:
      Boolean(item.prime),


    delivery:
      Array.isArray(item.delivery)
        ? item.delivery.join(" • ")
        : item.delivery || "",


    stock:
      item.stock || "",


    boughtLastMonth:
      item.bought_last_month || "",


    badges:
      Array.isArray(item.badges)
        ? item.badges
        : [],


    coupon:
      item.save_with_coupon || "",


    offers:
      Array.isArray(item.offers)
        ? item.offers
        : [],


    image:
      item.thumbnail || "",


    link:
      buildAmazonLink(
        asin,
        item.link_clean ||
        item.link
      ),


    sponsored:
      Boolean(item.sponsored)

  };

}


// ======================================================
// AMAZON SEARCH WITH 1-HOUR CACHE
// ======================================================

async function amazonSearch(query) {

  const apiKey =
    process.env.SERPAPI_KEY;


  if (!apiKey) {

    throw new Error(
      "SERPAPI_KEY is not configured."
    );

  }


  const cleanQuery =
    String(query || "deals")
      .trim()
      .toLowerCase();


  const cached =
    searchCache.get(cleanQuery);


  if (
    cached &&
    Date.now() - cached.time <
    CACHE_TTL_MS
  ) {

    console.log(
      `CACHE HIT: ${cleanQuery}`
    );

    return cached.products;

  }


  console.log(
    `LIVE SERPAPI SEARCH: ${cleanQuery}`
  );


  const params =
    new URLSearchParams({

      engine:
        "amazon",

      amazon_domain:
        "amazon.com",

      k:
        cleanQuery,

      api_key:
        apiKey

    });


  const url =
    `https://serpapi.com/search.json?${params.toString()}`;


  const data =
    await fetchJSON(url);


  if (data.error) {

    const error =
      new Error(data.error);


    const message =
      String(data.error)
        .toLowerCase();


    if (
      message.includes("run out") ||
      message.includes("searches") ||
      message.includes("limit")
    ) {

      error.code =
        "SERPAPI_LIMIT";

    }


    throw error;

  }


  const products =
    (
      data.organic_results || []
    )
      .map(normalizeProduct)

      .filter(
        product =>
          product.price !== null
      );


  searchCache.set(
    cleanQuery,
    {

      time:
        Date.now(),

      products

    }
  );


  return products;

}


// ======================================================
// REMOVE DUPLICATES
// ======================================================

function removeDuplicates(products) {

  const unique =
    new Map();


  for (const product of products) {

    const key =
      product.asin ||
      product.title.toLowerCase();


    if (!unique.has(key)) {

      unique.set(
        key,
        product
      );

      continue;

    }


    const existing =
      unique.get(key);


    // Prefer valid deal data.

    if (
      product.validDeal &&
      !existing.validDeal
    ) {

      unique.set(
        key,
        product
      );

      continue;

    }


    // Otherwise prefer the stronger discount.

    if (
      product.discountPercent >
      existing.discountPercent
    ) {

      unique.set(
        key,
        product
      );

    }

  }


  return Array.from(
    unique.values()
  );

}


// ======================================================
// NORMAL SEARCH
// ======================================================

async function searchAmazon(
  query,
  minDiscount = 90
) {

  const products =
    await amazonSearch(
      query || "deals"
    );


  return products

    .filter(
      product =>

        product.validDeal &&

        product.discountPercent >=
        minDiscount
    )

    .sort(
      (a, b) => {

        if (
          b.discountPercent !==
          a.discountPercent
        ) {

          return (
            b.discountPercent -
            a.discountPercent
          );

        }


        return (
          b.savings -
          a.savings
        );

      }
    );

}


// ======================================================
// RUN DEAL SCAN
// ======================================================

async function runDealScan() {

  const searchResults =
    await Promise.all(
      DEAL_SEARCHES.map(
        query =>
          amazonSearch(query)
      )
    );


  return removeDuplicates(
    searchResults.flat()
  );

}


// ======================================================
// TOP 20 AMAZON DEALS
// ======================================================

async function getTop20Deals() {

  const deals =
    await runDealScan();


  const realDeals =
    deals.filter(
      product =>

        product.validDeal &&

        product.oldPrice !== null &&

        product.discountPercent > 0
    );


  realDeals.sort(
    (a, b) => {

      if (
        b.discountPercent !==
        a.discountPercent
      ) {

        return (
          b.discountPercent -
          a.discountPercent
        );

      }


      if (
        b.savings !==
        a.savings
      ) {

        return (
          b.savings -
          a.savings
        );

      }


      return (
        Number(b.rating || 0) -
        Number(a.rating || 0)
      );

    }
  );


  return realDeals.slice(
    0,
    20
  );

}


// ======================================================
// SMART DEAL SCORE
// ======================================================

function calculateDealScore(product) {

  let score = 0;


  // Never give discount points to
  // invalid comparison prices.

  if (product.validDeal) {

    score +=
      Math.min(
        product.discountPercent,
        80
      ) * 0.55;


    score +=
      Math.min(
        product.savings / 100,
        1
      ) * 10;

  }


  // Rating score

  if (product.rating) {

    score +=
      Math.min(
        product.rating / 5,
        1
      ) * 15;

  }


  // Review score

  if (product.reviews > 0) {

    score +=
      Math.min(
        Math.log10(
          product.reviews + 1
        ) / 4,
        1
      ) * 15;

  }


  // Prime bonus

  if (product.prime) {

    score += 2;

  }


  // Sponsored penalty

  if (product.sponsored) {

    score -= 3;

  }


  return Math.max(
    0,
    Math.round(
      score * 10
    ) / 10
  );

}


// ======================================================
// DEAL LABEL
// ======================================================

function getDealLabel(score) {

  if (score >= 75) {

    return "🔥 Exceptional Deal";

  }


  if (score >= 60) {

    return "⭐ Great Deal";

  }


  if (score >= 45) {

    return "👍 Good Deal";

  }


  return "Deal";

}


// ======================================================
// BEST DEALS RIGHT NOW
// ======================================================

async function getBestDeals() {

  const deals =
    await runDealScan();


  const qualified =
    deals

      .filter(
        product =>

          product.validDeal &&

          product.oldPrice !== null &&

          product.discountPercent >= 20 &&

          product.price !== null
      )

      .map(
        product => {

          const dealScore =
            calculateDealScore(
              product
            );


          return {

            ...product,

            dealScore,

            dealLabel:
              getDealLabel(
                dealScore
              )

          };

        }
      );


  qualified.sort(
    (a, b) => {

      if (
        b.dealScore !==
        a.dealScore
      ) {

        return (
          b.dealScore -
          a.dealScore
        );

      }


      if (
        b.discountPercent !==
        a.discountPercent
      ) {

        return (
          b.discountPercent -
          a.discountPercent
        );

      }


      return (
        b.reviews -
        a.reviews
      );

    }
  );


  return qualified.slice(
    0,
    20
  );

}


// ======================================================
// API ERROR HANDLER
// ======================================================

function handleAPIError(
  res,
  error,
  fallbackMessage
) {

  console.error(error);


  if (
    error.code ===
    "SERPAPI_LIMIT"
  ) {

    sendJSON(
      res,
      429,
      {

        error:
          "Monthly SerpApi search limit reached.",

        code:
          "SERPAPI_LIMIT",

        message:
          "Your monthly SerpApi searches have been used. New live searches will work again when your plan resets or if additional searches are added."

      }
    );


    return;

  }


  sendJSON(
    res,
    500,
    {

      error:
        error.message ||
        fallbackMessage

    }
  );

}


// ======================================================
// WEB SERVER
// ======================================================

const server =
  http.createServer(
    async (req, res) => {

      const parsedUrl =
        new URL(
          req.url,
          `http://${req.headers.host || "localhost"}`
        );


      // ==================================================
      // BEST DEALS API
      // ==================================================

      if (
        parsedUrl.pathname ===
        "/api/bestdeals"
      ) {

        try {

          const results =
            await getBestDeals();


          sendJSON(
            res,
            200,
            {

              count:
                results.length,

              results,

              scanTime:
                new Date().toISOString(),

              cacheMinutes:
                60,

              searchesInScan:
                DEAL_SEARCHES.length,

              pricesVerifiedOnProductPage:
                false,

              notice:
                "Prices shown are from Amazon search results returned by SerpApi and may differ from the individual Amazon product page. Always verify the final price on Amazon before purchasing."

            }
          );


        } catch (error) {

          handleAPIError(
            res,
            error,
            "Best Deals search failed."
          );

        }


        return;

      }


      // ==================================================
      // TOP 20 API
      // ==================================================

      if (
        parsedUrl.pathname ===
        "/api/top20"
      ) {

        try {

          const results =
            await getTop20Deals();


          sendJSON(
            res,
            200,
            {

              count:
                results.length,

              results,

              scanTime:
                new Date().toISOString(),

              cacheMinutes:
                60,

              searchesInScan:
                DEAL_SEARCHES.length,

              pricesVerifiedOnProductPage:
                false,

              notice:
                "These are the strongest markdowns found in Amazon search results. Search-result prices can differ from the individual product page, so verify the final Amazon price before purchasing."

            }
          );


        } catch (error) {

          handleAPIError(
            res,
            error,
            "Top 20 Amazon search failed."
          );

        }


        return;

      }


      // ==================================================
      // NORMAL AMAZON SEARCH API
      // ==================================================

      if (
        parsedUrl.pathname ===
        "/api/search"
      ) {

        try {

          const query =
            parsedUrl.searchParams.get(
              "q"
            ) || "deals";


          let minDiscount =
            Number(
              parsedUrl.searchParams.get(
                "minDiscount"
              ) || 90
            );


          if (
            !Number.isFinite(
              minDiscount
            )
          ) {

            minDiscount = 90;

          }


          minDiscount =
            Math.max(
              0,
              Math.min(
                89,
                minDiscount
              )
            );


          const results =
            await searchAmazon(
              query,
              minDiscount
            );


          sendJSON(
            res,
            200,
            {

              query,

              minDiscount,

              count:
                results.length,

              results,

              cacheMinutes:
                60,

              pricesVerifiedOnProductPage:
                false,

              notice:
                "Prices shown come from Amazon search results returned by SerpApi. Verify the current product-page price on Amazon before purchasing."

            }
          );


        } catch (error) {

          handleAPIError(
            res,
            error,
            "Amazon search failed."
          );

        }


        return;

      }


      // ==================================================
      // SERVE WEBSITE
      // ==================================================

      let filePath =

        parsedUrl.pathname === "/"

          ? path.join(
              __dirname,
              "public",
              "index.html"
            )

          : path.join(
              __dirname,
              "public",
              parsedUrl.pathname
            );


      const publicDirectory =
        path.join(
          __dirname,
          "public"
        );


      filePath =
        path.normalize(
          filePath
        );


      if (
        parsedUrl.pathname !== "/" &&
        !filePath.startsWith(
          publicDirectory
        )
      ) {

        res.writeHead(403);

        res.end(
          "Forbidden"
        );

        return;

      }


      fs.readFile(
        filePath,
        (error, content) => {

          if (error) {

            res.writeHead(
              404,
              {
                "Content-Type":
                  "text/plain"
              }
            );

            res.end(
              "Not Found"
            );

            return;

          }


          const extension =
            path.extname(
              filePath
            ).toLowerCase();


          const contentTypes = {

            ".html":
              "text/html",

            ".css":
              "text/css",

            ".js":
              "text/javascript",

            ".json":
              "application/json",

            ".png":
              "image/png",

            ".jpg":
              "image/jpeg",

            ".jpeg":
              "image/jpeg",

            ".svg":
              "image/svg+xml"

          };


          res.writeHead(
            200,
            {

              "Content-Type":
                contentTypes[
                  extension
                ] ||
                "application/octet-stream"

            }
          );


          res.end(content);

        }
      );

    }
  );


// ======================================================
// START SERVER
// ======================================================

server.listen(
  PORT,
  () => {

    console.log(
      `Amazon Deal Hunter running on port ${PORT}`
    );

  }
);
