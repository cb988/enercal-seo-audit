import fs from "fs";
import OpenAI from "openai";
import * as cheerio from "cheerio";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const sitemap = "https://www.enercal.nc/sitemap_index.xml";
const BATCH_SIZE = 5;

async function getUrls() {
  const res = await fetch(sitemap);
  const xml = await res.text();

  const sitemapUrls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);

  let urls = [];

  for (const map of sitemapUrls) {
    const r = await fetch(map);
    const subXml = await r.text();

    const subUrls = [...subXml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
    urls = urls.concat(subUrls);
  }

  return urls.slice(0, 20); // limite pour éviter surcharge
}

async function crawlPages(urls) {
  const pages = [];

  for (const url of urls) {
    try {
      console.log("Scan :", url);

      const r = await fetch(url);
      const html = await r.text();

      const $ = cheerio.load(html);

      pages.push({
        url,
        title: $("title").text(),
        h1: $("h1").map((i, el) => $(el).text()).get(),
        text: $("body").text().slice(0, 2000)
      });

    } catch (e) {
      pages.push({
        url,
        error: e.message
      });
    }
  }

  return pages;
}

async function analyzeBatch(batch) {
  const prompt = `
Tu es un expert SEO.

Analyse ces pages et détecte :
- incohérences de contenu
- doublons
- problèmes SEO

Réponds en français de façon claire.

${JSON.stringify(batch, null, 2)}
`;

  const response = await client.responses.create({
    model: "gpt-5",
    input: prompt
  });

  return response.output_text;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function main() {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY manquante");
    }

    console.log("Récupération sitemap...");
    const urls = await getUrls();

    console.log("Crawl...");
    const pages = await crawlPages(urls);

    const batches = chunkArray(pages, BATCH_SIZE);
    const results = [];

    for (let i = 0; i < batches.length; i++) {
      console.log(`Analyse batch ${i + 1}/${batches.length}`);
      const res = await analyzeBatch(batches[i]);
      results.push(res);
    }

    const final = results.join("\n\n");

    const report = `
# Audit SEO Enercal

Date : ${new Date().toLocaleString()}

---

${final}
`;

    fs.writeFileSync("audit-enercal.md", report);

    console.log("Audit terminé !");
  } catch (err) {
    console.error("Erreur :", err.message);
    process.exit(1);
  }
}

main();
