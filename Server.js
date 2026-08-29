const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");

const PORT = process.env.PORT || 3000;


// ======================================================
// SEND JSON
// ======================================================

function sendJSON(res, statusCode, data) {

  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
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

            reject(error);

          }

        });

      })
      .on("error", reject);

  });

}


// ======================================================
// NORMALIZE AMAZON PRODUCT
// ======================================================

function normalizeProduct(item) {

  const price =
    Number(item.extracted_price);

  const oldPrice =
    Number(item.extracted_old_price);


  let discountPercent = 0;

  let savings = 0;


  if (
    Number.isFinite(price) &&
    Number.isFinite(oldPrice) &&
    oldPrice > price &&
    oldPrice > 0
  ) {

    savings =
      oldPrice - price;

    discountPercent =
      Math.round(
        (savings / oldPrice) * 100
      );

  }


  return {

    asin:
      item.asin || "",

    title:
      item.title || "Amazon product",


    price:
      Number.isFinite(price)
        ? price
        : null,


    priceText:
      item.price ||
      (
        Number.isFinite(price)
          ? `$${price.toFixed(2)}`
          : ""
      ),


    oldPrice:
      Number.isFinite(oldPrice)
        ? oldPrice
        : null,


    oldPriceText:
      item.old_price ||
      (
        Number.isFinite(oldPrice)
          ? `$${oldPrice.toFixed(2)}`
          : ""
      ),


    savings:
      savings > 0
        ? Number(savings.toFixed(2))
        : 0,


    discountPercent,


    rating:
      item.rating || null,


    reviews:
      item.reviews || 0,


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


    image:
      item.thumbnail || "",


    link:
      item.link_clean ||
      item.link ||
      (
        item.asin
          ? `https://www.amazon.com/dp/${item.asin}`
          : ""
      ),


    sponsored:
      Boolean(item.sponsored)

  };

}


// ======================================================
// SEARCH AMAZON
// ======================================================

async function amazonSearch(query) {

  const apiKey =
    process.env.SERPAPI_KEY;


  if (!apiKey) {

    throw new Error(
      "SERPAPI_KEY is not configured."
    );

  }


  const params =
    new URLSearchParams({

      engine:
        "amazon",

      amazon_domain:
        "amazon.com",

      k:
        query,

      api_key:
        apiKey

    });


  const url =
    `https://serpapi.com/search.json?${params.toString()}`;


  const data =
    await fetchJSON(url);


  if (data.error) {

    throw new Error(
      data.error
    );

  }


  return (
    data.organic_results || []
  )
    .map(normalizeProduct)
    .filter(
      product =>
        product.price !== null
    );

}


// ======================================================
// NORMAL 90% SEARCH
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
// TOP 20 AMAZON DEALS
// ======================================================

async function getTop20Deals() {

  /*
    Each phrase below performs one
    SerpApi Amazon search.

    We search several major Amazon
    shopping areas to improve coverage.
  */

  const searches = [

    "amazon deals",

    "electronics deals",

    "home kitchen deals",

    "tools deals",

    "toys deals",

    "beauty deals",

    "automotive deals",

    "outdoor deals"

  ];


  const searchResults =
    await Promise.all(
      searches.map(
        query =>
          amazonSearch(query)
      )
    );


  const allProducts =
    searchResults.flat();


  // ----------------------------------
  // Remove duplicate products
  // ----------------------------------

  const unique =
    new Map();


  for (const product of allProducts) {

    /*
      ASIN is the best duplicate key.

      If ASIN is missing,
      fall back to title.
    */

    const key =
      product.asin ||
      product.title.toLowerCase();


    if (!unique.has(key)) {

      unique.set(
        key,
        product
      );

    } else {

      /*
        If duplicate appears twice,
        keep version with the
        larger calculated discount.
      */

      const existing =
        unique.get(key);


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

  }


  const deals =
    Array.from(
      unique.values()
    );


  // ----------------------------------
  // Require actual comparison price
  // ----------------------------------

  const realDeals =
    deals.filter(
      product =>
        product.oldPrice !== null &&
        product.discountPercent > 0
    );


  // ----------------------------------
  // Rank biggest markdown first
  // ----------------------------------

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


  // ----------------------------------
  // Return best 20
  // ----------------------------------

  return realDeals.slice(
    0,
    20
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

              notice:
                "These are the strongest Amazon markdowns found during the current live category searches. They are not guaranteed to be the absolute top 20 deals across Amazon's entire catalog. Prices can change quickly. Verify the final price on Amazon before purchasing."

            }
          );


        } catch (error) {

          console.error(error);


          sendJSON(
            res,
            500,
            {

              error:
                error.message ||
                "Top 20 Amazon search failed."

            }
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
                99,
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

              notice:
                "Discount percentages are calculated from Amazon current and comparison prices returned by the search data. Verify price and availability on Amazon before purchasing."

            }
          );


        } catch (error) {

          console.error(error);


          sendJSON(
            res,
            500,
            {

              error:
                error.message ||
                "Amazon search failed."

            }
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
