import OpenAI from "openai";
import * as cheerio from "cheerio";
import PptxGenJS from "pptxgenjs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const SITEMAP_INDEX = "https://www.enercal.nc/sitemap_index.xml";
const MAX_PAGE_URLS = 18;
const MAX_POST_URLS = 6;
const BATCH_SIZE = 6;

// -------------------------
// Helpers
// -------------------------
function cleanText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function truncate(str, max = 110) {
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

function urlLabel(url) {
  return url
    .replace("https://www.enercal.nc", "")
    .replace(/\/$/, "") || "/";
}

function isInstitutionalPriority(url) {
  const u = url.toLowerCase();
  return (
    u.includes("/enercal/") ||
    u.includes("/lelectricite-en-nouvelle-caledonie/") ||
    u.includes("/la-transition-energetique-en-nouvelle-caledonie/") ||
    u.includes("/les-energies/") ||
    u.includes("/nos-offres") ||
    u.includes("/faq") ||
    u.includes("/politique") ||
    u.includes("/securite") ||
    u.includes("/histoire") ||
    u.includes("/entreprise")
  );
}

function isPostUrl(url) {
  const u = url.toLowerCase();
  return u.includes("/actualite/") || u.includes("/article/") || u.includes("/evenement/");
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
  const sitemapUrls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].trim());

  let allUrls = [];

  for (const map of sitemapUrls) {
    const lower = map.toLowerCase();

    // on garde pages + posts, mais on ne laisse pas les posts dominer
    if (!lower.includes("page-sitemap") && !lower.includes("post-sitemap")) continue;

    console.log("Lecture sitemap :", map);
    const r = await fetch(map);
    if (!r.ok) continue;

    const subXml = await r.text();
    const subUrls = [...subXml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].trim());
    allUrls.push(...subUrls);
  }

  allUrls = [...new Set(allUrls)];
  allUrls = filterUrls(allUrls);

  const priorityPages = allUrls.filter((u) => !isPostUrl(u) && isInstitutionalPriority(u)).slice(0, MAX_PAGE_URLS);
  const otherPages = allUrls.filter((u) => !isPostUrl(u) && !priorityPages.includes(u)).slice(0, 8);
  const posts = allUrls.filter((u) => isPostUrl(u)).slice(0, MAX_POST_URLS);

  const finalUrls = [...new Set([...priorityPages, ...otherPages, ...posts])];

  return finalUrls;
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

      pages.push({
        url,
        title,
        h1,
        text: mainText.slice(0, 4500),
        textLength: mainText.length,
        numbers: extractNumbers(mainText),
        dates: extractDates(mainText),
        sentences: splitSentences(mainText)
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
// AI batch
// -------------------------
async function analyzePageBatch(batch) {
  const prompt = `
Tu es un relecteur éditorial senior.

Analyse ce lot de pages institutionnelles énergie.

Objectif :
- repérer les formulations ambiguës
- repérer les noms / notions à harmoniser
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
// AI cross
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
    x, y, w: 11.8, h: 0.4,
    fontSize: 24, bold: true, color: "003B5C"
  });
}

function addBullets(slide, items, x = 0.8, y = 1.4, w = 11.5, h = 5.2, fontSize = 18) {
  const lines = safeArray(items).length
    ? safeArray(items).map((i) => ({ text: String(i), options: { bullet: { indent: 14 } } }))
    : [{ text: "Aucun point saillant." }];

  slide.addText(lines, {
    x, y, w, h, fontSize, breakLine: true, margin: 0.05, color: "1F1F1F"
  });
}

function addClickableUrl(slide, url, x, y, w = 5.6) {
  slide.addText(urlLabel(url), {
    x, y, w, h: 0.28,
    fontSize: 11,
    color: "0563C1",
    underline: { color: "0563C1" },
    hyperlink: { url }
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
  slide.addText("Version V3.1 — cohérence sémantique et chiffrée", {
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
  let y = 1.3;
  const numeric = safeArray(data.numeric_inconsistencies).slice(0, 4);
  if (!numeric.length) {
    addBullets(slide, ["Aucune incohérence chiffrée majeure détectée."], 0.8, 1.5);
  } else {
    for (const item of numeric) {
      slide.addText(truncate(item.topic, 55), {
        x: 0.7, y, w: 5.2, h: 0.3, fontSize: 16, bold: true, color: "B00020"
      });
      slide.addText(truncate(item.issue, 95), {
        x: 0.7, y: y + 0.3, w: 11.2, h: 0.35, fontSize: 14, color: "1F1F1F"
      });
      const urls = safeArray(item.urls).slice(0, 2);
      if (urls[0]) addClickableUrl(slide, urls[0], 0.9, y + 0.72, 5.3);
      if (urls[1]) addClickableUrl(slide, urls[1], 6.4, y + 0.72, 5.3);
      y += 1.35;
    }
  }

  // Slide 4
  slide = pptx.addSlide();
  addSectionTitle(slide, "Incohérences sémantiques");
  y = 1.3;
  const semantic = safeArray(data.semantic_inconsistencies).slice(0, 4);
  if (!semantic.length) {
    addBullets(slide, ["Aucune incohérence sémantique majeure détectée."], 0.8, 1.5);
  } else {
    for (const item of semantic) {
      slide.addText(truncate(item.topic, 55), {
        x: 0.7, y, w: 5.2, h: 0.3, fontSize: 16, bold: true, color: "D98200"
      });
      slide.addText(truncate(item.issue, 95), {
        x: 0.7, y: y + 0.3, w: 11.2, h: 0.35, fontSize: 14, color: "1F1F1F"
      });
      const urls = safeArray(item.urls).slice(0, 2);
      if (urls[0]) addClickableUrl(slide, urls[0], 0.9, y + 0.72, 5.3);
      if (urls[1]) addClickableUrl(slide, urls[1], 6.4, y + 0.72, 5.3);
      y += 1.35;
    }
  }

  // Slide 5
  slide = pptx.addSlide();
  addSectionTitle(slide, "Formulations ambiguës ou à clarifier");
  y = 1.2;
  const ambiguous = safeArray(data.ambiguous_wording).slice(0, 5);
  if (!ambiguous.length) {
    addBullets(slide, ["Aucune formulation ambiguë majeure détectée."], 0.8, 1.5);
  } else {
    for (const item of ambiguous) {
      addClickableUrl(slide, item.url, 0.7, y, 6.6);
      slide.addText(truncate(item.issue, 80), {
        x: 0.7, y: y + 0.28, w: 11.5, h: 0.28, fontSize: 14, bold: true, color: "003B5C"
      });
      slide.addText(`Exemple : ${truncate(item.example, 110)}`, {
        x: 0.9, y: y + 0.6, w: 11.0, h: 0.32, fontSize: 12, color: "4A4A4A"
      });
      y += 1.15;
    }
  }

  // Slide 6
  slide = pptx.addSlide();
  addSectionTitle(slide, "Pages à harmoniser en priorité");
  y = 1.25;
  const priority = safeArray(data.priority_pages).slice(0, 6);
  if (!priority.length) {
    addBullets(slide, ["Aucune page prioritaire signalée."], 0.8, 1.5);
  } else {
    for (const item of priority) {
      addClickableUrl(slide, item.url, 0.7, y, 7.0);
      slide.addText(truncate(item.reason, 95), {
        x: 0.9, y: y + 0.32, w: 11.0, h: 0.35, fontSize: 13, color: "1F1F1F"
      });
      y += 0.95;
    }
  }

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
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquante");

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
