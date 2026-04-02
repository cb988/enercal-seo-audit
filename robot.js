import fs from "fs";
import OpenAI from "openai";
import * as cheerio from "cheerio";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const sitemap = "https://www.enercal.nc/sitemap_index.xml";
const MAX_PAGES = 15;

// --------- RÉCUP URLS ---------
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

  return urls.slice(0, MAX_PAGES);
}

// --------- CRAWL ---------
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
        text: $("body").text().replace(/\s+/g, " ").slice(0, 3000)
      });

    } catch (e) {
      pages.push({ url, error: e.message });
    }
  }

  return pages;
}

// --------- IA ANALYSE V2 ---------
async function analyze(pages) {

  const prompt = `
Tu es un expert SEO senior + consultant en communication corporate.

Analyse ces pages web.

Tu dois produire un rapport structuré type présentation PowerPoint.

OBJECTIFS :

1. Détecter :
- incohérences éditoriales (contradictions, messages flous)
- incohérences de ton vs image Enercal (institutionnel, énergie, crédibilité)
- pages faibles (contenu pauvre ou inutile)
- problèmes SEO

2. Donner un SCORE SEO par page (sur 100)

3. Prioriser les actions

FORMAT OBLIGATOIRE :

# 🔵 SYNTHÈSE (5 lignes max)

# 🔴 TOP PROBLÈMES
- court, clair

# 🟠 INCOHÉRENCES ÉDITORIALES
(ex: contradictions, incohérences discours)

# 🎯 TON DE MARQUE (Enercal)
- est-ce cohérent ?
- trop marketing ? pas assez institutionnel ?

# 📉 PAGES FAIBLES
- URL + pourquoi

# 📊 SCORING PAR PAGE
tableau :
URL | Score | Problème principal

# 🚀 PLAN D’ACTION PRIORISÉ
- Niveau 1 (urgent)
- Niveau 2
- Niveau 3

CONTENU À ANALYSER :
${JSON.stringify(pages, null, 2)}
`;

  const response = await client.responses.create({
    model: "gpt-5",
    input: prompt
  });

  return response.output_text;
}

// --------- MAIN ---------
async function main() {
  try {
    console.log("Sitemap...");
    const urls = await getUrls();

    console.log("Crawl...");
    const pages = await crawlPages(urls);

    console.log("Analyse IA...");
    const result = await analyze(pages);

    const report = `
# 📊 AUDIT SEO ENERCAL — VERSION EXEC

Date : ${new Date().toLocaleString()}

---

${result}
`;

    fs.writeFileSync("audit-enercal.md", report);

    console.log("✅ Audit terminé !");
  } catch (err) {
    console.error("Erreur :", err.message);
    process.exit(1);
  }
}

main();
