/**
 * Hotfrog scraper - Directorio de empresas, emails visibles, sin captcha
 * Cubre España, México, Argentina y más
 */
import { PlaywrightCrawler, sleep } from 'crawlee';
import { extractEmailsFromText, getEmailConfidenceScore } from '../emailVerifier.js';
import { extractPhoneNumbers, extractWhatsAppFromContent, isProbablyWhatsApp, normalizePhoneNumber, COUNTRY_CODES } from '../whatsappVerifier.js';

const HOTFROG_URLS = {
  spain: 'https://www.hotfrog.es',
  mexico: 'https://www.hotfrog.com.mx',
  argentina: 'https://www.hotfrog.com.ar',
  colombia: 'https://www.hotfrog.com.co',
  chile: 'https://www.hotfrog.cl',
  peru: 'https://www.hotfrog.pe',
  united_states: 'https://www.hotfrog.com',
  united_kingdom: 'https://www.hotfrog.co.uk',
  default: 'https://www.hotfrog.es'
};

const INDUSTRY_SLUGS = {
  restaurants: 'restaurantes',
  hotels: 'hoteles',
  real_estate: 'inmobiliaria',
  construction: 'construccion',
  law_firms: 'abogados',
  medical_clinics: 'clinicas-medicas',
  dentists: 'dentistas',
  gyms_fitness: 'gimnasios',
  beauty_salons: 'peluquerias',
  auto_dealerships: 'concesionarios',
  accounting_finance: 'asesoria-fiscal',
  it_technology: 'informatica',
  marketing_agencies: 'agencias-marketing',
  retail_stores: 'tiendas',
  education_schools: 'academias',
  logistics_transport: 'transportes',
  manufacturing: 'industria',
  travel_agencies: 'agencias-viajes',
  insurance: 'seguros',
  e_commerce: 'comercio-online'
};

function buildHotfrogUrl(industry, country, city) {
  const base = HOTFROG_URLS[country] || HOTFROG_URLS.default;
  const kw = INDUSTRY_SLUGS[industry] || industry;
  const citySlug = city
    ? city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    : '';
  return citySlug
    ? `${base}/search/np/0/${citySlug}/${kw}`
    : `${base}/buscar/${kw}`;
}

export async function scrapeHotfrog({ industry, country, city, maxResults, proxyConfig, log, pushData }) {
  const countryCode = COUNTRY_CODES[country] || '';
  const searchUrl = buildHotfrogUrl(industry, country, city);
  const results = [];

  log.info(`🔥 Hotfrog URL: ${searchUrl}`);

  const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries: 2,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 180,
    headless: true,
    launchContext: {
      launchOptions: { args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=es-ES,es'] },
    },

    async requestHandler({ page, request, log: L }) {
      if (results.length >= maxResults) return;
      await page.waitForLoadState('domcontentloaded');
      await sleep(1200);

      if (request.label === 'SEARCH' || !request.label) {
        const listings = await page.evaluate(() => {
          const items = [];
          document.querySelectorAll('.search-result, .listing-item, article.business, .bizresult').forEach(card => {
            const nameEl = card.querySelector('h2 a, h3 a, .business-name a, a.name');
            if (!nameEl) return;
            const name = nameEl.textContent?.trim();
            const href = nameEl.href;
            const phone = card.querySelector('.phone, .tel, [class*="phone"]')?.textContent?.trim() || null;
            const address = card.querySelector('address, .address, [class*="address"]')?.textContent?.trim() || '';
            const emailLink = card.querySelector('a[href^="mailto:"]');
            const email = emailLink?.href?.replace('mailto:', '') || null;
            if (name && href) items.push({ name, href, phone, address, email });
          });
          // Fallback: any business link
          if (items.length === 0) {
            document.querySelectorAll('a[href*="/np/"]').forEach(a => {
              const name = a.textContent?.trim();
              if (name && name.length > 2) items.push({ name, href: a.href, phone: null, address: '', email: null });
            });
          }
          return items;
        });

        L.info(`Hotfrog: found ${listings.length} listings`);

        for (const listing of listings.slice(0, maxResults - results.length)) {
          await crawler.requestQueue?.addRequest({
            url: listing.href,
            label: 'DETAIL',
            userData: { listing }
          });
        }

        // Pagination
        if (results.length < maxResults) {
          const nextUrl = await page.evaluate(() => document.querySelector('a[rel="next"], a.next, .pagination a:last-child')?.href || null);
          if (nextUrl) await crawler.requestQueue?.addRequest({ url: nextUrl, label: 'SEARCH' });
        }

      } else if (request.label === 'DETAIL') {
        if (results.length >= maxResults) return;
        const { listing } = request.userData;

        const html = await page.content();
        const text = await page.evaluate(() => document.body?.innerText || '');

        const website = await page.evaluate(() => {
          return document.querySelector('a.website-link, a[href*="http"][data-ga*="website"], a[rel="nofollow noopener"]')?.href || null;
        });

        let emails = listing.email ? [listing.email, ...extractEmailsFromText(html + ' ' + text)] : extractEmailsFromText(html + ' ' + text);
        let phones = listing.phone ? [listing.phone, ...extractPhoneNumbers(text)] : extractPhoneNumbers(text);
        let waNumbers = extractWhatsAppFromContent(html, text);

        // Scrape website
        if (website && website.startsWith('http')) {
          try {
            await page.goto(website, { waitUntil: 'domcontentloaded', timeout: 18000 });
            await sleep(600);
            const wHtml = await page.content();
            const wText = await page.evaluate(() => document.body?.innerText || '');
            emails = [...new Set([...emails, ...extractEmailsFromText(wHtml + ' ' + wText)])];
            waNumbers = [...new Set([...waNumbers, ...extractWhatsAppFromContent(wHtml, wText)])];
          } catch { /* unreachable */ }
        }

        emails = [...new Set(emails)].filter(Boolean);
        phones = [...new Set(phones)].filter(Boolean);

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
          source: 'hotfrog',
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
  log.info(`✅ Hotfrog done. ${results.length} leads.`);
  return results;
}
