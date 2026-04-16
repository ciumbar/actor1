/**
 * Yellow Pages / PáginasAmarillas scraper
 * Supports multiple regional yellow pages sites
 */
import { PlaywrightCrawler, sleep } from 'crawlee';
import { extractEmailsFromText, getEmailConfidenceScore, decodeObfuscatedEmail } from '../emailVerifier.js';
import { extractPhoneNumbers, extractWhatsAppFromContent, isProbablyWhatsApp, normalizePhoneNumber, COUNTRY_CODES } from '../whatsappVerifier.js';

const YELLOW_PAGES_URLS = {
  spain: 'https://www.paginasamarillas.es',
  mexico: 'https://www.seccion.com',
  argentina: 'https://www.paginasamarillas.com.ar',
  colombia: 'https://www.paginasamarillas.com.co',
  chile: 'https://www.paginasamarillas.cl',
  peru: 'https://www.paginasamarillas.com.pe',
  united_states: 'https://www.yellowpages.com',
  united_kingdom: 'https://www.yell.com',
  portugal: 'https://www.paginas-amarelas.pt',
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

/**
 * Build search URL for the appropriate yellow pages site
 */
function buildSearchUrl(industry, country, city) {
  const base = YELLOW_PAGES_URLS[country] || YELLOW_PAGES_URLS.spain;
  const keyword = INDUSTRY_KEYWORDS[industry] || industry;

  if (country === 'spain') {
    const citySlug = city ? city.toLowerCase().replace(/\s+/g, '-').normalize('NFD').replace(/[\u0300-\u036f]/g, '') : 'espana';
    return `${base}/${keyword}/${citySlug}/1`;
  }
  if (country === 'united_states') {
    return `${base}/search?search_terms=${keyword}&geo_location_terms=${encodeURIComponent(city || 'United States')}`;
  }
  if (country === 'united_kingdom') {
    return `${base}/search?what=${encodeURIComponent(keyword)}&where=${encodeURIComponent(city || 'United Kingdom')}`;
  }

  // Generic fallback
  return `${base}/buscar/${keyword}/${city ? encodeURIComponent(city) : ''}`;
}

/**
 * Scrape Yellow Pages listings
 */
export async function scrapeYellowPages({ industry, country, city, maxResults, proxyConfig, log, pushData }) {
  const countryCode = COUNTRY_CODES[country] || '';
  const searchUrl = buildSearchUrl(industry, country, city);
  const results = [];

  log.info(`📒 Starting Yellow Pages scrape: ${searchUrl}`);

  const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries: 3,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    headless: true,

    async requestHandler({ page, request, log: crawlerLog }) {
      if (results.length >= maxResults) return;

      crawlerLog.info(`Processing: ${request.url}`);
      await page.waitForLoadState('domcontentloaded');
      await sleep(2000);

      const html = await page.content();
      const text = await page.evaluate(() => document.body?.innerText || '');

      // Extract listing cards (works for paginasamarillas.es structure)
      const listings = await page.evaluate(() => {
        const cards = document.querySelectorAll('.listado-item, .business-listing, .listing, [data-business-id], .result-item');
        return Array.from(cards).map(card => {
          const name = card.querySelector('h2, h3, .business-name, .name, [itemprop="name"]')?.textContent?.trim();
          const address = card.querySelector('address, .address, [itemprop="address"]')?.textContent?.trim();
          const phone = card.querySelector('.phone, [itemprop="telephone"], .tel')?.textContent?.trim();
          const website = card.querySelector('a[href*="http"]:not([href*="paginasamarillas"])')?.href;
          const detailLink = card.querySelector('a[href*="/detalle/"], a.business-link, h2 a, h3 a')?.href;
          const emailRaw = card.querySelector('a[href^="mailto:"]')?.href?.replace('mailto:', '');

          return { name, address, phone, website, detailLink, email: emailRaw };
        }).filter(l => l.name);
      });

      crawlerLog.info(`Found ${listings.length} listings on this page`);

      for (const listing of listings.slice(0, maxResults - results.length)) {
        // Try to get more details from the detail page
        let extraContacts = { emails: [], phones: [], whatsapp: null };

        if (listing.detailLink) {
          try {
            await page.goto(listing.detailLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await sleep(1000);

            const detailHtml = await page.content();
            const detailText = await page.evaluate(() => document.body?.innerText || '');

            const detailEmails = extractEmailsFromText(detailHtml + ' ' + detailText);
            const detailPhones = extractPhoneNumbers(detailText);
            const detailWa = extractWhatsAppFromContent(detailHtml, detailText);

            // Get website from detail page
            const detailWebsite = await page.evaluate(() => {
              return document.querySelector('a[href*="http"][data-ga-label="website"], .website a')?.href || null;
            });

            extraContacts = {
              emails: detailEmails,
              phones: detailPhones,
              whatsapp: detailWa[0] || null,
              website: detailWebsite
            };

            // Try to scrape the business website too
            if ((detailWebsite || listing.website) && !detailWa[0]) {
              try {
                const targetSite = detailWebsite || listing.website;
                await page.goto(targetSite, { waitUntil: 'domcontentloaded', timeout: 15000 });
                await sleep(800);
                const siteHtml = await page.content();
                const siteText = await page.evaluate(() => document.body?.innerText || '');
                const siteWa = extractWhatsAppFromContent(siteHtml, siteText);
                const siteEmails = extractEmailsFromText(siteHtml + ' ' + siteText);
                extraContacts.emails = [...new Set([...extraContacts.emails, ...siteEmails])];
                if (siteWa[0]) extraContacts.whatsapp = siteWa[0];
              } catch { /* ignore */ }
            }
          } catch (err) {
            crawlerLog.warning(`Detail page error: ${err.message}`);
          }
        }

        // Merge all contact data
        const allEmails = [...new Set([
          ...(listing.email ? [listing.email] : []),
          ...extraContacts.emails
        ])].filter(Boolean);

        const allPhones = [...new Set([
          ...(listing.phone ? [listing.phone] : []),
          ...extraContacts.phones
        ])].filter(Boolean);

        const bestEmail = allEmails
          .map(e => ({ email: e, score: getEmailConfidenceScore(e, listing.name || '') }))
          .sort((a, b) => b.score - a.score)[0];

        const bestPhone = allPhones[0] ? normalizePhoneNumber(allPhones[0], countryCode) : null;
        const bestWa = extraContacts.whatsapp ||
          (bestPhone && isProbablyWhatsApp(bestPhone, country) ? bestPhone : null);

        const lead = {
          businessName: listing.name,
          industry,
          country,
          city: city || '',
          address: listing.address || '',
          website: extraContacts.website || listing.website || null,
          email: bestEmail?.email || null,
          emailVerified: bestEmail ? bestEmail.score >= 60 : false,
          emailConfidence: bestEmail?.score || 0,
          phone: bestPhone,
          whatsapp: bestWa ? `+${bestWa.replace(/^\+/, '')}` : null,
          whatsappVerified: !!extraContacts.whatsapp,
          whatsappUrl: bestWa ? `https://wa.me/${bestWa.replace(/[^0-9]/g, '')}` : null,
          allEmails: allEmails.slice(0, 5),
          allPhones: allPhones.slice(0, 5),
          source: 'yellow_pages',
          scrapedAt: new Date().toISOString()
        };

        results.push(lead);
        await pushData(lead);
        crawlerLog.info(`✅ Lead: ${lead.businessName} | Email: ${lead.email || 'none'} | WA: ${lead.whatsapp || 'none'}`);
      }

      // Handle pagination
      if (results.length < maxResults) {
        const nextPage = await page.evaluate(() => {
          const next = document.querySelector('a[rel="next"], .pagination .next a, a.page-next, [aria-label="Siguiente"]');
          return next?.href || null;
        });

        if (nextPage) {
          await crawler.requestQueue?.addRequest({ url: nextPage });
        }
      }
    },

    failedRequestHandler({ request, log: crawlerLog }) {
      crawlerLog.error(`Failed: ${request.url}`);
    }
  });

  await crawler.run([{ url: searchUrl }]);
  log.info(`✅ Yellow Pages scraping complete. Found ${results.length} leads.`);
  return results;
}
