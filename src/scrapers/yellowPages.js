/**
 * Yellow Pages / PáginasAmarillas scraper - Robust version
 */
import { PlaywrightCrawler, sleep } from 'crawlee';
import { extractEmailsFromText, getEmailConfidenceScore } from '../emailVerifier.js';
import { extractPhoneNumbers, extractWhatsAppFromContent, isProbablyWhatsApp, normalizePhoneNumber, COUNTRY_CODES } from '../whatsappVerifier.js';

const YELLOW_PAGES_URLS = {
  spain: 'https://www.paginasamarillas.es',
  mexico: 'https://www.paginasamarillas.com.mx',
  argentina: 'https://www.paginasamarillas.com.ar',
  colombia: 'https://www.paginasamarillas.com.co',
  chile: 'https://www.paginasamarillas.cl',
  peru: 'https://www.paginasamarillas.com.pe',
  united_states: 'https://www.yellowpages.com',
  united_kingdom: 'https://www.yell.com',
  portugal: 'https://www.paginasamarelas.pt',
  brazil: 'https://www.paginasamarelas.com.br'
};

const INDUSTRY_KEYWORDS = {
  restaurants: 'restaurantes',
  hotels: 'hoteles',
  real_estate: 'inmobiliaria',
  construction: 'construccion',
  law_firms: 'abogados',
  medical_clinics: 'medicos',
  dentists: 'dentistas',
  gyms_fitness: 'gimnasios',
  beauty_salons: 'peluquerias',
  auto_dealerships: 'concesionarios',
  accounting_finance: 'gestoria',
  it_technology: 'informatica',
  marketing_agencies: 'agencias-marketing',
  retail_stores: 'tiendas',
  education_schools: 'academias',
  logistics_transport: 'transportes',
  manufacturing: 'fabricacion',
  travel_agencies: 'agencias-viajes',
  insurance: 'seguros',
  e_commerce: 'comercio-electronico'
};

function buildSearchUrl(industry, country, city) {
  const base = YELLOW_PAGES_URLS[country] || YELLOW_PAGES_URLS.spain;
  const kw = INDUSTRY_KEYWORDS[industry] || industry;

  if (country === 'united_states') {
    return `${base}/search?search_terms=${kw}&geo_location_terms=${encodeURIComponent(city || '')}`;
  }
  if (country === 'united_kingdom') {
    return `${base}/search?what=${encodeURIComponent(kw)}&where=${encodeURIComponent(city || '')}`;
  }

  const citySlug = city
    ? city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    : '';
  return citySlug
    ? `${base}/${kw}/${citySlug}/1`
    : `${base}/${kw}/1`;
}

export async function scrapeYellowPages({ industry, country, city, maxResults, proxyConfig, log, pushData }) {
  const countryCode = COUNTRY_CODES[country] || '';
  const searchUrl = buildSearchUrl(industry, country, city);
  const results = [];

  log.info(`📒 Yellow Pages URL: ${searchUrl}`);

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
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9' });
      },
    ],

    async requestHandler({ page, request, log: L }) {
      if (results.length >= maxResults) return;

      await page.waitForLoadState('domcontentloaded');
      await sleep(2000);

      // Accept cookies
      try {
        await page.click('button#didomi-notice-agree-button, button[id*="accept"], button[class*="accept"], #onetrust-accept-btn-handler', { timeout: 3000 });
        await sleep(800);
      } catch { /* no cookie banner */ }

      const listings = await page.evaluate(() => {
        const results = [];
        const cards = document.querySelectorAll(
          '.listado-item, .item-listado, [class*="listado"] li, .business-card, .result-item, article.item'
        );

        cards.forEach(card => {
          const nameEl = card.querySelector('h2 a, h3 a, .nombre a, .name a, [class*="nombre"], [itemprop="name"]');
          const name = nameEl?.textContent?.trim();
          if (!name) return;

          const detailUrl = nameEl?.href || card.querySelector('a[href*="/detalle/"], a[href*="/empresa/"], a.more-info')?.href;
          const phone = card.querySelector('[itemprop="telephone"], .telefono, .phone, [class*="phone"], [class*="tel"]')?.textContent?.trim();
          const address = card.querySelector('[itemprop="address"], address, .direccion, [class*="address"]')?.textContent?.trim();
          const emailLink = card.querySelector('a[href^="mailto:"]');
          const email = emailLink?.href?.replace('mailto:', '') || null;
          const website = card.querySelector('a[href*="http"]:not([href*="paginasamarillas"])')?.href || null;

          results.push({ name, detailUrl, phone, address, email, website });
        });

        // Fallback
        if (results.length === 0) {
          document.querySelectorAll('a[href*="/detalle/"], a[href*="/empresa/"]').forEach(a => {
            const name = a.textContent?.trim();
            if (name && name.length > 2) {
              results.push({ name, detailUrl: a.href, phone: null, address: null, email: null, website: null });
            }
          });
        }

        return results;
      });

      L.info(`Found ${listings.length} listings`);

      for (const listing of listings.slice(0, maxResults - results.length)) {
        let emails = listing.email ? [listing.email] : [];
        let phones = listing.phone ? [listing.phone] : [];
        let waNumbers = [];
        let website = listing.website;

        // Visit detail page
        if (listing.detailUrl) {
          try {
            await page.goto(listing.detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await sleep(800);
            const dHtml = await page.content();
            const dText = await page.evaluate(() => document.body?.innerText || '');

            emails = [...new Set([...emails, ...extractEmailsFromText(dHtml + ' ' + dText)])];
            phones = [...new Set([...phones, ...extractPhoneNumbers(dText)])];
            waNumbers = extractWhatsAppFromContent(dHtml, dText);

            if (!website) {
              website = await page.evaluate(() => {
                return document.querySelector('a[href*="http"][data-ga-label="website"], a.web, a[class*="website"], a[itemprop="url"]')?.href || null;
              });
            }
          } catch { /* detail page failed */ }
        }

        // Scrape website
        if (website && website.startsWith('http') && !website.includes('paginasamarillas')) {
          try {
            await page.goto(website, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await sleep(600);
            const wHtml = await page.content();
            const wText = await page.evaluate(() => document.body?.innerText || '');
            emails = [...new Set([...emails, ...extractEmailsFromText(wHtml + ' ' + wText)])];
            waNumbers = [...new Set([...waNumbers, ...extractWhatsAppFromContent(wHtml, wText)])];
          } catch { /* website failed */ }
        }

        const bestEmail = emails
          .map(e => ({ email: e, score: getEmailConfidenceScore(e, listing.name) }))
          .sort((a, b) => b.score - a.score)[0];

        const bestPhone = phones[0] ? normalizePhoneNumber(phones[0], countryCode) : null;
        const bestWa = waNumbers[0] || (bestPhone && isProbablyWhatsApp(bestPhone, country) ? bestPhone : null);

        const lead = {
          businessName: listing.name,
          industry, country,
          city: city || '',
          address: listing.address || '',
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
          source: 'yellow_pages',
          scrapedAt: new Date().toISOString()
        };

        results.push(lead);
        await pushData(lead);
        L.info(`✅ ${lead.businessName} | Email: ${lead.email || '-'} | WA: ${lead.whatsapp || '-'}`);

        // Go back to listing
        try {
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
          await sleep(500);
        } catch {
          await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await sleep(800);
        }
      }

      // Pagination
      if (results.length < maxResults) {
        const nextUrl = await page.evaluate(() => {
          const next = document.querySelector('a[rel="next"], a.next, a[aria-label="Siguiente"], .pagination .active + li a');
          return next?.href || null;
        });
        if (nextUrl) {
          await crawler.requestQueue?.addRequest({ url: nextUrl });
        }
      }
    },

    failedRequestHandler({ request, log: L }) {
      L.warning(`Failed: ${request.url}`);
    }
  });

  await crawler.run([{ url: searchUrl }]);
  log.info(`✅ Yellow Pages done. ${results.length} leads.`);
  return results;
}
