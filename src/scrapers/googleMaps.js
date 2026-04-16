/**
 * Google Maps scraper - Robust version
 * Uses stealth mode + correct selectors
 */
import { PlaywrightCrawler, sleep } from 'crawlee';
import { extractEmailsFromText, getEmailConfidenceScore } from '../emailVerifier.js';
import { extractPhoneNumbers, extractWhatsAppFromContent, isProbablyWhatsApp, normalizePhoneNumber, COUNTRY_CODES } from '../whatsappVerifier.js';

const INDUSTRY_QUERIES = {
  restaurants: 'restaurantes',
  hotels: 'hoteles',
  real_estate: 'inmobiliaria',
  construction: 'empresa construcción',
  law_firms: 'abogados',
  medical_clinics: 'clínica médica',
  dentists: 'dentista',
  gyms_fitness: 'gimnasio',
  beauty_salons: 'peluquería salón belleza',
  auto_dealerships: 'concesionario coches',
  accounting_finance: 'gestoría asesoría',
  it_technology: 'empresa informática tecnología',
  marketing_agencies: 'agencia marketing',
  retail_stores: 'tienda',
  education_schools: 'academia escuela',
  logistics_transport: 'empresa transporte',
  manufacturing: 'empresa fabricación',
  travel_agencies: 'agencia de viajes',
  insurance: 'correduría seguros',
  e_commerce: 'tienda online'
};

function buildSearchUrl(industry, country, city) {
  const query = INDUSTRY_QUERIES[industry] || industry;
  const location = city || country;
  return `https://www.google.com/maps/search/${encodeURIComponent(`${query} ${location}`)}`;
}

export async function scrapeGoogleMaps({ industry, country, city, maxResults, proxyConfig, log, pushData }) {
  const countryCode = COUNTRY_CODES[country] || '';
  const searchUrl = buildSearchUrl(industry, country, city);
  const results = [];

  log.info(`🗺️ Google Maps URL: ${searchUrl}`);

  const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries: 2,
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 180,
    headless: true,
    launchContext: {
      launchOptions: {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--lang=es-ES,es'],
      },
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
      L.info(`Processing: ${request.label} - ${request.url}`);

      // Accept cookies
      try {
        await page.waitForSelector('button[aria-label*="Aceptar"], button[aria-label*="Accept"], form[action*="consent"] button', { timeout: 5000 });
        await page.click('button[aria-label*="Aceptar"], button[aria-label*="Accept"], form[action*="consent"] button');
        await sleep(1500);
      } catch { /* no cookie banner */ }

      if (request.label === 'SEARCH') {
        // Wait for feed
        await page.waitForSelector('div[role="feed"], div.Nv2PK', { timeout: 25000 }).catch(() => {});
        await sleep(2000);

        // Scroll to load more
        const scrolls = Math.min(Math.ceil(maxResults / 7) + 2, 20);
        for (let i = 0; i < scrolls; i++) {
          await page.evaluate(() => {
            const feed = document.querySelector('div[role="feed"]');
            if (feed) feed.scrollBy(0, 600);
          });
          await sleep(700);
        }

        // Extract place links
        const places = await page.evaluate(() => {
          const seen = new Set();
          const items = [];
          document.querySelectorAll('a[href*="/maps/place/"]').forEach(a => {
            if (seen.has(a.href)) return;
            seen.add(a.href);
            const card = a.closest('[jsaction]') || a.closest('li') || a.parentElement;
            const name = (card?.querySelector('.qBF1Pd, .fontHeadlineSmall, [class*="fontHeadline"]')?.textContent
                       || a.textContent || '').trim();
            const address = (card?.querySelector('.W4Efsd .W4Efsd span:last-child, .Io6YTe, .W4Efsd span')?.textContent || '').trim();
            const ratingLabel = card?.querySelector('[aria-label*="star"], [aria-label*="estrell"]')?.getAttribute('aria-label') || '';
            const ratingMatch = ratingLabel.match(/[\d.]+/);
            if (name && a.href.includes('/maps/place/')) {
              items.push({ href: a.href, name, address, rating: ratingMatch ? parseFloat(ratingMatch[0]) : null });
            }
          });
          return items;
        });

        L.info(`Found ${places.length} places`);

        for (const place of places.slice(0, maxResults)) {
          await crawler.requestQueue?.addRequest({ url: place.href, label: 'DETAIL', userData: { place } });
        }

      } else if (request.label === 'DETAIL') {
        if (results.length >= maxResults) return;
        const { place } = request.userData;

        await page.waitForSelector('.DUwDvf, h1, [data-attrid="title"]', { timeout: 12000 }).catch(() => {});
        await sleep(800);

        const html = await page.content();
        const text = await page.evaluate(() => document.body?.innerText || '');

        // Phone from Maps
        const phone = await page.evaluate(() => {
          const tel = document.querySelector('a[href^="tel:"]');
          if (tel) return tel.href.replace('tel:', '').trim();
          const btn = document.querySelector('[data-item-id*="phone"], [aria-label*="Teléfono"], [aria-label*="Phone number"]');
          return btn?.getAttribute('aria-label')?.replace(/[^\d+\s()-]/g, '').trim() || null;
        });

        // Website
        const website = await page.evaluate(() => {
          const a = document.querySelector('[data-item-id="authority"] a, a[aria-label*="Sitio web"], a[aria-label*="Website"], a[data-tooltip*="eb"]');
          return a?.href || null;
        });

        let emails = extractEmailsFromText(text + ' ' + html);
        let waNumbers = extractWhatsAppFromContent(html, text);
        let phones = phone ? [phone, ...extractPhoneNumbers(text)] : extractPhoneNumbers(text);

        // Scrape website
        if (website && website.startsWith('http') && !website.includes('google.com') && !website.includes('goo.gl')) {
          try {
            await page.goto(website, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await sleep(800);
            const sHtml = await page.content();
            const sText = await page.evaluate(() => document.body?.innerText || '');
            emails = [...new Set([...emails, ...extractEmailsFromText(sHtml + ' ' + sText)])];
            waNumbers = [...new Set([...waNumbers, ...extractWhatsAppFromContent(sHtml, sText)])];
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
          .map(e => ({ email: e, score: getEmailConfidenceScore(e, place.name) }))
          .sort((a, b) => b.score - a.score)[0];

        const bestPhone = phones[0] ? normalizePhoneNumber(phones[0], countryCode) : null;
        const bestWa = waNumbers[0] || (bestPhone && isProbablyWhatsApp(bestPhone, country) ? bestPhone : null);

        const lead = {
          businessName: place.name,
          industry, country,
          city: city || '',
          address: place.address || '',
          rating: place.rating,
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
          googleMapsUrl: place.href,
          source: 'google_maps',
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
  log.info(`✅ Google Maps done. ${results.length} leads.`);
  return results;
}
