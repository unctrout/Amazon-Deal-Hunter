const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");

const PORT = process.env.PORT || 3000;

// -----------------------------
// Helper: send JSON
// -----------------------------
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(JSON.stringify(data));
}

// -----------------------------
// Helper: call SerpApi
// -----------------------------
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        let data = "";

        response.on("data", (chunk) => {
          data += chunk;
        });

        response.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

// -----------------------------
// Amazon search
// -----------------------------
async function searchAmazon(query, minDiscount = 90) {
  const apiKey = process.env.SERPAPI_KEY;

  if (!apiKey) {
    throw new Error("SERPAPI_KEY is not configured.");
  }

  const searchQuery = query || "deals";

  const params = new URLSearchParams({
    engine: "amazon",
    amazon_domain: "amazon.com",
    k: searchQuery,
    api_key: apiKey
  });

  const url = `https://serpapi.com/search.json?${params.toString()}`;

  const data = await fetchJSON(url);

  if (data.error) {
    throw new Error(data.error);
  }

  const products = data.organic_results || [];

  const normalized = products
    .map((item) => {
      const price = Number(item.extracted_price);
      const oldPrice = Number(item.extracted_old_price);

      let discountPercent = 0;
      let savings = 0;

      if (
        Number.isFinite(price) &&
        Number.isFinite(oldPrice) &&
        oldPrice > price &&
        oldPrice > 0
      ) {
        savings = oldPrice - price;
        discountPercent = Math.round((savings / oldPrice) * 100);
      }

      return {
        asin: item.asin || "",
        title: item.title || "Amazon product",

        price: Number.isFinite(price) ? price : null,
        priceText:
          item.price ||
          (Number.isFinite(price) ? `$${price.toFixed(2)}` : ""),

        oldPrice: Number.isFinite(oldPrice) ? oldPrice : null,
        oldPriceText:
          item.old_price ||
          (Number.isFinite(oldPrice) ? `$${oldPrice.toFixed(2)}` : ""),

        savings:
          Number.isFinite(savings) && savings > 0
            ? Number(savings.toFixed(2))
            : 0,

        discountPercent,

        rating: item.rating || null,
        reviews: item.reviews || 0,

        prime: Boolean(item.prime),

        delivery: Array.isArray(item.delivery)
          ? item.delivery.join(" • ")
          : item.delivery || "",

        stock: item.stock || "",

        boughtLastMonth: item.bought_last_month || "",

        badges: Array.isArray(item.badges)
          ? item.badges
          : [],

        coupon: item.save_with_coupon || "",

        image: item.thumbnail || "",

        link:
          item.link_clean ||
          item.link ||
          (item.asin
            ? `https://www.amazon.com/dp/${item.asin}`
            : ""),

        sponsored: Boolean(item.sponsored)
      };
    })

    // Only products with a real current price
    .filter((item) => item.price !== null)

    // Only deals at or above the selected discount
    .filter((item) => item.discountPercent >= minDiscount)

    // Biggest discount first
    .sort((a, b) => {
      if (b.discountPercent !== a.discountPercent) {
        return b.discountPercent - a.discountPercent;
      }

      return b.savings - a.savings;
    });

  return products.length
    ? normalized
    : [];
}

// -----------------------------
// Server
// -----------------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  // -----------------------------
  // API search
  // -----------------------------
  if (parsedUrl.pathname === "/api/search") {
    try {
      const query = parsedUrl.searchParams.get("q") || "deals";

      let minDiscount = Number(
        parsedUrl.searchParams.get("minDiscount") || 90
      );

      if (!Number.isFinite(minDiscount)) {
        minDiscount = 90;
      }

      minDiscount = Math.max(0, Math.min(99, minDiscount));

      const results = await searchAmazon(
        query,
        minDiscount
      );

      sendJSON(res, 200, {
        query,
        minDiscount,
        count: results.length,
        results,

        notice:
          "Discount percentages are calculated from the current price and old/list price returned by Amazon search data. Verify price and availability on Amazon before purchasing."
      });
    } catch (error) {
      console.error(error);

      sendJSON(res, 500, {
        error: error.message || "Amazon search failed."
      });
    }

    return;
  }

  // -----------------------------
  // Serve website
  // -----------------------------
  let filePath = parsedUrl.pathname === "/"
    ? path.join(__dirname, "public", "index.html")
    : path.join(
        __dirname,
        "public",
        parsedUrl.pathname
      );

  const publicDirectory = path.join(
    __dirname,
    "public"
  );

  filePath = path.normalize(filePath);

  // Prevent access outside public directory
  if (
    parsedUrl.pathname !== "/" &&
    !filePath.startsWith(publicDirectory)
  ) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, {
        "Content-Type": "text/plain"
      });

      res.end("Not Found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();

    const contentTypes = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml"
    };

    res.writeHead(200, {
      "Content-Type":
        contentTypes[extension] ||
        "application/octet-stream"
    });

    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(
    `Amazon Deal Hunter running on port ${PORT}`
  );
});
