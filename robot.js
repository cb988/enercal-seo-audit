import OpenAI from "openai"
import cheerio from "cheerio"

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const sitemap = "https://www.enercal.nc/page-sitemap.xml"

async function getUrls() {

  const res = await fetch(sitemap)
  const xml = await res.text()

  const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1])

  return urls
}

async function analyze() {

  const urls = await getUrls()

  const pages = []

  for (const url of urls) {

    const r = await fetch(url)
    const html = await r.text()

    const $ = cheerio.load(html)

    pages.push({
      url: url,
      title: $("title").text(),
      h1: $("h1").text(),
      text: $("body").text().slice(0,2000)
    })

  }

  const response = await client.responses.create({
    model: "gpt-5",
    input: `
Analyse ces pages web.

Détecte:
- incohérences
- pages dupliquées
- problèmes SEO

Pages:
${JSON.stringify(pages)}
`
  })

  console.log(response.output_text)
}

analyze()
