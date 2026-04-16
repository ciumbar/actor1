/**
 * Yelp scraper - HTML estático, sin bloqueos en cloud
 * Funciona para España y LATAM via yelp.es / yelp.com
 */
import { PlaywrightCrawler, sleep } from 'crawlee';
import { extractEmailsFromText, getEmailConfidenceScore } from '../emailVerifier.js';
import { extractPhoneNumbers, extractWhatsAppFromContent, isProbablyWhatsApp, normalizePhoneNumber, COUNTRY_CODES } from '../whatsappVerifier.js';

const YELP_DOMAINS = {
  spain: 'https://www.yelp.es',
  united_states: 'https://www.yelp.com',
  united_kingdom: 'https://www.yelp.co.uk',
  france: 'https://www.yelp.fr',
  germany: 'https://www.yelp.de',
  italy: 'https://www.yelp.it',
  default: 'https://www.yelp.com'
};

const INDUSTRY_TERMS = {
  restaurants: 'restaurantes',
  hotels: 'hoteles',
  real_estate: 'inmobiliaria',
  construction: 'construccion',
  law_firms: 'abogados',
  medical_clinics: 'medicos clinicas',
  dentists: 'dentistas',
  gyms_fitness: 'gimnasios',
  beauty_salons: 'peluquerias',
  auto_dealerships: 'concesionarios',
  accounting_finance: 'gestoria asesoria',
  it_technology: 'informatica tecnologia',
  marketing_agencies: 'marketing publicidad',
  retail_stores: 'tiendas',
  education_schools: 'academias escuelas',
  logistics_transport: 'transportes',
  manufacturing: 'fabricacion industria',
  travel_agencies: 'agencias viajes',
  insurance: 'seguros',
  e_commerce: 'tienda online'
};

function buildYelpUrl(industry, country, city) {
  const base = YELP_DOMAINS[country] || YELP_DOMAINS.default;
  const term = encodeURIComponent(INDUSTRY_TERMS[industry] || industry);
  const location = encodeURIComponent(city || country);
  return `${base}/search?find_desc=${term}&find_loc=${location}`;
}

export async function scrapeYelp({ industry, country, city, maxResults, proxyConfig, log, pushData }) {
  const countryCode = COUNTRY_CODES[country] || '';
  const searchUrl = buildYelpUrl(industry, country, city);
  const results = [];

  log.info(`⭐ Yelp URL: ${searchUrl}`);

  const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries: 2,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 180,
    headless: true,
    launchContext: {
      launchOptions: { args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=es-ES,es'] },
    },
    preNavigationHooks: [
      async ({ page }) => {
        await page.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9' });
      },
    ],

    async requestHandler({ page, request, log: L }) {
      if (results.length >= maxResults) return;

      await page.waitForLoadState('domcontentloaded');
      await sleep(1500);

      // Accept cookies
      try {
        await page.click('[data-testid="uc-accept-all-button"], button[id*="accept"], #onetrust-accept-btn-handler', { timeout: 3000 });
        await sleep(500);
      } catch { /* no banner */ }

      if (request.label === 'SEARCH') {
        // Extract business links from search results
        const businesses = await page.evaluate(() => {
          const items = [];
          // Yelp search result cards
          document.querySelectorAll('h3 a[href*="/biz/"], h4 a[href*="/biz/"]').forEach(a => {
            const name = a.textContent?.trim();
            const href = a.href;
            if (name && href && !items.find(i => i.href === href)) {
              items.push({ name, href });
            }
          });
          return items;
        });

        L.info(`Yelp: found ${businesses.length} businesses`);

        for (const biz of businesses.slice(0, maxResults)) {
          await crawler.requestQueue?.addRequest({
            url: biz.href,
            label: 'DETAIL',
            userData: { biz }
          });
        }

        // Pagination
        if (results.length < maxResults) {
          const nextUrl = await page.evaluate(() => {
            const next = document.querySelector('a[aria-label="Next"]');
            return next?.href || null;
          });
          if (nextUrl) await crawler.requestQueue?.addRequest({ url: nextUrl, label: 'SEARCH' });
        }

      } else if (request.label === 'DETAIL') {
        if (results.length >= maxResults) return;
        const { biz } = request.userData;

        const html = await page.content();
        const text = await page.evaluate(() => document.body?.innerText || '');

        // Phone
        const phone = await page.evaluate(() => {
          const p = document.querySelector('a[href^="tel:"], p.css-1p9ibgf');
          if (p?.href) return p.href.replace('tel:', '');
          return p?.textContent?.trim() || null;
        });

        // Website
        const website = await page.evaluate(() => {
          const a = document.querySelector('a[href*="biz_website"]');
          if (a) {
            const url = new URL(a.href);
            return url.searchParams.get('url') || a.href;
          }
          return null;
        });

        // Address
        const address = await page.evaluate(() => {
          return document.querySelector('address p, [data-testid="address"]')?.textContent?.trim() || '';
        });

        let emails = extractEmailsFromText(text + ' ' + html);
        let waNumbers = extractWhatsAppFromContent(html, text);
        let phones = phone ? [phone, ...extractPhoneNumbers(text)] : extractPhoneNumbers(text);

        // Scrape business website
        if (website && website.startsWith('http')) {
          try {
            await page.goto(website, { waitUntil: 'domcontentloaded', timeout: 18000 });
            await sleep(600);
            const wHtml = await page.content();
            const wText = await page.evaluate(() => document.body?.innerText || '');
            emails = [...new Set([...emails, ...extractEmailsFromText(wHtml + ' ' + wText)])];
            waNumbers = [...new Set([...waNumbers, ...extractWhatsAppFromContent(wHtml, wText)])];
            // Try /contacto
            if (emails.length === 0) {
              try {
                await page.goto(new URL('/contacto', website).href, { waitUntil: 'domcontentloaded', timeout: 10000 });
                const cHtml = await page.content();
                const cText = await page.evaluate(() => document.body?.innerText || '');
                emails = [...new Set([...emails, ...extractEmailsFromText(cHtml + ' ' + cText)])];
                waNumbers = [...new Set([...waNumbers, ...extractWhatsAppFromContent(cHtml, cText)])];
              } catch { /* no /contacto */ }
            }
          } catch { /* unreachable */ }
        }

        const bestEmail = emails
          .map(e => ({ email: e, score: getEmailConfidenceScore(e, biz.name) }))
          .sort((a, b) => b.score - a.score)[0];

        const bestPhone = phones[0] ? normalizePhoneNumber(phones[0], countryCode) : null;
        const bestWa = waNumbers[0] || (bestPhone && isProbablyWhatsApp(bestPhone, country) ? bestPhone : null);

        const lead = {
          businessName: biz.name,
          industry, country,
          city: city || '',
          address,
          website: website || null,
          email: bestEmail?.email || null,
          emailVerified: bestEmail ? bestEmail.score >= 60 : false,
          emailConfidence: bestEmail?.score || 0,
          phone: bestPhone || null,
          whatsapp: bestWa ? `+${String(bestWa).replace(/^\+/, '')}` : null,
          whatsappVerified: !!waNumbers[0],
          whatsappUrl: bestWa ? `https://wa.me/${String(bestWa).replace(/[^0-9]/g, '')}` : null,
          allEmails: emails.slice(0, 5),
          allPhones: phones.slice(0, 5),
          yelpUrl: biz.href,
          source: 'yelp',
          scrapedAt: new Date().toISOString()
        };

        results.push(lead);
        await pushData(lead);
        L.info(`✅ ${lead.businessName} | Email: ${lead.email || '-'} | WA: ${lead.whatsapp || '-'}`);
      }
    },

    failedRequestHandler({ request, log: L }) {
      L.warning(`Failed: ${request.url}`);
    }
  });

  await crawler.run([{ url: searchUrl, label: 'SEARCH' }]);
  log.info(`✅ Yelp done. ${results.length} leads.`);
  return results;
}
