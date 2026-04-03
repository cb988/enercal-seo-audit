import OpenAI from "openai";
import * as cheerio from "cheerio";
import PptxGenJS from "pptxgenjs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const SITEMAP_INDEX = "https://www.enercal.nc/sitemap_index.xml";
const MAX_URLS = 20;
const BATCH_SIZE = 5;

// -------------------------
// Helpers
// -------------------------
function cleanText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function truncate(str, max = 120) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function extractNumbers(text) {
  const matches =
    text.match(/\b\d+(?:[.,]\d+)?\s?(?:%|MW|kW|MWh|GWh|kWh|F|FCFP|ans|jours|mois)?\b/gi) || [];
  return [...new Set(matches)].slice(0, 30);
}

function extractDates(text) {
  const matches =
    text.match(/\b(?:\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4})\b/g) || [];
  return [...new Set(matches)].slice(0, 30);
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => cleanText(s))
    .filter(Boolean)
    .slice(0, 50);
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function pickUsefulSitemaps(urls) {
  return urls.filter((u) => {
    const x = u.toLowerCase();
    return (
      x.includes("page-sitemap") ||
      x.includes("post-sitemap") ||
      x.includes("actualite") ||
      x.includes("article")
    );
  });
}

function filterUrls(urls) {
  return urls.filter((url) => {
    const u = url.toLowerCase();

    if (!u.startsWith("https://www.enercal.nc/")) return false;

    const excluded = [
      "/category/",
      "/tag/",
      "/author/",
      "/feed/",
      "/embed/",
      "/wp-json/",
      "/attachment/",
      "/preview",
      "?s=",
      "/search/",
      "/calendrier-de-lavent",
      "/vider-les-caches",
      "/courbe-conso"
    ];

    const ext = [".jpg", ".jpeg", ".png", ".gif", ".svg", ".pdf", ".zip", ".doc", ".docx", ".xls", ".xlsx"];

    if (excluded.some((e) => u.includes(e))) return false;
    if (ext.some((e) => u.endsWith(e))) return false;

    return true;
  });
}

// -------------------------
// Sitemap
// -------------------------
async function getUrls() {
  const res = await fetch(SITEMAP_INDEX);
  if (!res.ok) throw new Error(`Sitemap index inaccessible: ${res.status}`);

  const xml = await res.text();
  let sitemapUrls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].trim());

  sitemapUrls = pickUsefulSitemaps(sitemapUrls);

  let urls = [];
  for (const map of sitemapUrls) {
    console.log("Lecture sitemap :", map);
    const r = await fetch(map);
    if (!r.ok) continue;

    const subXml = await r.text();
    const subUrls = [...subXml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].trim());
    urls.push(...subUrls);
  }

  urls = [...new Set(urls)];
  urls = filterUrls(urls);

  return urls.slice(0, MAX_URLS);
}

// -------------------------
// Crawl
// -------------------------
async function crawlPages(urls) {
  const pages = [];

  for (const url of urls) {
    try {
      console.log("Scan :", url);

      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 Enercal Consistency Audit Bot" }
      });

      const html = await r.text();
      const $ = cheerio.load(html);

      const title = cleanText($("title").first().text());
      const h1 = $("h1")
        .map((i, el) => cleanText($(el).text()))
        .get()
        .filter(Boolean);

      const mainText = cleanText(
        $("main").text() ||
          $(".entry-content").text() ||
          $(".wp-block-post-content").text() ||
          $("article").text() ||
          $("body").text() ||
          ""
      );

      const sentences = splitSentences(mainText);

      pages.push({
        url,
        title,
        h1,
        text: mainText.slice(0, 5000),
        textLength: mainText.length,
        numbers: extractNumbers(mainText),
        dates: extractDates(mainText),
        sentences
      });
    } catch (e) {
      pages.push({
        url,
        error: e.message,
        title: "",
        h1: [],
        text: "",
        textLength: 0,
        numbers: [],
        dates: [],
        sentences: []
      });
    }
  }

  return pages;
}

// -------------------------
// AI - page batch analysis
// -------------------------
async function analyzePageBatch(batch) {
  const prompt = `
Tu es un relecteur éditorial senior et un analyste de cohérence.

Analyse ce lot de pages d’un site institutionnel énergie.

Objectif :
- repérer les formulations ambiguës
- repérer les tournures contradictoires ou peu claires
- repérer les noms de projets / notions à harmoniser
- repérer les chiffres et dates sensibles à comparer

Réponds STRICTEMENT en JSON :

{
  "page_findings": [
    {
      "url": "...",
      "ambiguous_phrases": ["..."],
      "naming_variations": ["..."],
      "numbers_to_watch": ["..."],
      "dates_to_watch": ["..."],
      "notes": ["..."]
    }
  ]
}

Pages :
${JSON.stringify(batch, null, 2)}
`;

  const response = await client.responses.create({
    model: "gpt-5",
    input: prompt
  });

  return JSON.parse(response.output_text);
}

// -------------------------
// AI - cross-site analysis
// -------------------------
async function analyzeCrossSite(pages, pageFindings) {
  const prompt = `
Tu es un expert en cohérence éditoriale pour un site corporate énergie.

À partir des données ci-dessous, produis un audit de cohérence uniquement.

Tu dois identifier :
1. incohérences chiffrées entre pages
2. incohérences de dates
3. variations de vocabulaire / dénomination
4. formulations ambiguës ou contradictoires
5. pages à harmoniser en priorité

Réponds STRICTEMENT en JSON avec cette structure :

{
  "summary": ["...","...","..."],
  "numeric_inconsistencies": [
    {
      "topic": "...",
      "urls": ["...","..."],
      "issue": "...",
      "details": "..."
    }
  ],
  "semantic_inconsistencies": [
    {
      "topic": "...",
      "urls": ["...","..."],
      "issue": "...",
      "details": "..."
    }
  ],
  "ambiguous_wording": [
    {
      "url": "...",
      "issue": "...",
      "example": "..."
    }
  ],
  "priority_pages": [
    {
      "url": "...",
      "reason": "..."
    }
  ],
  "harmonization_plan": {
    "urgent": ["...","..."],
    "important": ["...","..."],
    "follow_up": ["...","..."]
  }
}

Pages :
${JSON.stringify(pages, null, 2)}

Findings :
${JSON.stringify(pageFindings, null, 2)}
`;

  const response = await client.responses.create({
    model: "gpt-5",
    input: prompt
  });

  return JSON.parse(response.output_text);
}

// -------------------------
// PPT
// -------------------------
function addSectionTitle(slide, text, x = 0.6, y = 0.6) {
  slide.addText(text, {
    x,
    y,
    w: 11.8,
    h: 0.4,
    fontSize: 24,
    bold: true,
    color: "003B5C"
  });
}

function addBullets(slide, items, x = 0.8, y = 1.4, w = 11.5, h = 5.2, fontSize = 18) {
  const lines = safeArray(items).length
    ? safeArray(items).map((i) => ({ text: String(i), options: { bullet: { indent: 14 } } }))
    : [{ text: "Aucun point saillant." }];

  slide.addText(lines, {
    x,
    y,
    w,
    h,
    fontSize,
    breakLine: true,
    margin: 0.05,
    color: "1F1F1F"
  });
}

async function createPPT(data) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "ChatGPT";
  pptx.company = "Enercal";
  pptx.subject = "Audit de cohérence éditoriale";
  pptx.title = "Audit de cohérence Enercal";
  pptx.lang = "fr-FR";

  // Slide 1
  let slide = pptx.addSlide();
  slide.background = { color: "FFFFFF" };
  slide.addText("Audit de cohérence du site Enercal", {
    x: 0.7, y: 0.9, w: 10, h: 0.6, fontSize: 26, bold: true, color: "003B5C"
  });
  slide.addText("Version V3 — cohérence sémantique et chiffrée", {
    x: 0.7, y: 1.7, w: 9.5, h: 0.3, fontSize: 18, color: "4A4A4A"
  });
  slide.addText(`Date : ${new Date().toLocaleString("fr-FR")}`, {
    x: 0.7, y: 2.3, w: 5, h: 0.3, fontSize: 12, color: "6B6B6B"
  });

  // Slide 2
  slide = pptx.addSlide();
  addSectionTitle(slide, "Synthèse");
  addBullets(slide, data.summary, 0.8, 1.4, 11.5, 5.2, 20);

  // Slide 3
  slide = pptx.addSlide();
  addSectionTitle(slide, "Incohérences chiffrées");

  const numRows = [["Sujet", "Pages", "Problème"]];
  for (const item of safeArray(data.numeric_inconsistencies).slice(0, 8)) {
    numRows.push([
      truncate(item.topic, 30),
      truncate(safeArray(item.urls).join(" / "), 45),
      truncate(item.issue, 45)
    ]);
  }
  if (numRows.length === 1) numRows.push(["Aucune", "-", "-"]);

  slide.addTable(numRows, {
    x: 0.5, y: 1.4, w: 12.3, h: 5.5,
    fontSize: 12,
    border: { type: "solid", pt: 1, color: "C9D3DD" }
  });

  // Slide 4
  slide = pptx.addSlide();
  addSectionTitle(slide, "Incohérences sémantiques");

  const semRows = [["Sujet", "Pages", "Problème"]];
  for (const item of safeArray(data.semantic_inconsistencies).slice(0, 8)) {
    semRows.push([
      truncate(item.topic, 30),
      truncate(safeArray(item.urls).join(" / "), 45),
      truncate(item.issue, 45)
    ]);
  }
  if (semRows.length === 1) semRows.push(["Aucune", "-", "-"]);

  slide.addTable(semRows, {
    x: 0.5, y: 1.4, w: 12.3, h: 5.5,
    fontSize: 12,
    border: { type: "solid", pt: 1, color: "C9D3DD" }
  });

  // Slide 5
  slide = pptx.addSlide();
  addSectionTitle(slide, "Formulations ambiguës ou à clarifier");

  const ambRows = [["URL", "Problème", "Exemple"]];
  for (const item of safeArray(data.ambiguous_wording).slice(0, 10)) {
    ambRows.push([
      truncate(item.url, 45),
      truncate(item.issue, 28),
      truncate(item.example, 55)
    ]);
  }
  if (ambRows.length === 1) ambRows.push(["Aucune", "-", "-"]);

  slide.addTable(ambRows, {
    x: 0.4, y: 1.4, w: 12.4, h: 5.5,
    fontSize: 11,
    border: { type: "solid", pt: 1, color: "C9D3DD" }
  });

  // Slide 6
  slide = pptx.addSlide();
  addSectionTitle(slide, "Pages à harmoniser en priorité");

  const priorityRows = [["URL", "Raison"]];
  for (const item of safeArray(data.priority_pages).slice(0, 10)) {
    priorityRows.push([
      truncate(item.url, 55),
      truncate(item.reason, 65)
    ]);
  }
  if (priorityRows.length === 1) priorityRows.push(["Aucune", "-"]);

  slide.addTable(priorityRows, {
    x: 0.5, y: 1.4, w: 12.2, h: 5.5,
    fontSize: 12,
    border: { type: "solid", pt: 1, color: "C9D3DD" }
  });

  // Slide 7
  slide = pptx.addSlide();
  addSectionTitle(slide, "Plan d’harmonisation");

  slide.addText("Urgent", {
    x: 0.6, y: 1.3, w: 2.5, h: 0.3, fontSize: 18, bold: true, color: "B00020"
  });
  addBullets(slide, safeArray(data.harmonization_plan?.urgent), 0.6, 1.7, 3.6, 4.8, 14);

  slide.addText("Important", {
    x: 4.7, y: 1.3, w: 2.5, h: 0.3, fontSize: 18, bold: true, color: "D98200"
  });
  addBullets(slide, safeArray(data.harmonization_plan?.important), 4.7, 1.7, 3.6, 4.8, 14);

  slide.addText("Suivi", {
    x: 8.8, y: 1.3, w: 2.5, h: 0.3, fontSize: 18, bold: true, color: "0B6E4F"
  });
  addBullets(slide, safeArray(data.harmonization_plan?.follow_up), 8.8, 1.7, 3.6, 4.8, 14);

  await pptx.writeFile({ fileName: "audit-enercal.pptx" });
}

// -------------------------
// Main
// -------------------------
async function main() {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY manquante");
    }

    console.log("Récupération des URLs...");
    const urls = await getUrls();

    console.log("Crawl des pages...");
    const pages = await crawlPages(urls);

    const batches = chunkArray(pages, BATCH_SIZE);
    let pageFindings = [];

    for (let i = 0; i < batches.length; i++) {
      console.log(`Analyse lot ${i + 1}/${batches.length}...`);
      const result = await analyzePageBatch(batches[i]);
      pageFindings.push(...safeArray(result.page_findings));
    }

    console.log("Analyse croisée...");
    const finalData = await analyzeCrossSite(pages, pageFindings);

    console.log("Génération du PowerPoint...");
    await createPPT(finalData);

    console.log("✅ PPT généré : audit-enercal.pptx");
  } catch (err) {
    console.error("Erreur :", err.message);
    process.exit(1);
  }
}

main();
