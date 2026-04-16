/**
 * Google Maps scraper
 * Extracts business listings with contacts from Google Maps
 */
import { PlaywrightCrawler, sleep } from 'crawlee';
import { extractEmailsFromText, decodeObfuscatedEmail, getEmailConfidenceScore } from '../emailVerifier.js';
import { extractPhoneNumbers, extractWhatsAppFromContent, isProbablyWhatsApp, normalizePhoneNumber, COUNTRY_CODES } from '../whatsappVerifier.js';
const INDUSTRY_QUERIES = {
  restaurants: 'restaurantes',
  hotels: 'hoteles',
  real_estate: 'inmobiliaria',
  construction: 'construcción empresa',
  law_firms: 'abogados despacho',
  medical_clinics: 'clínica médica',
  dentists: 'dentista clínica dental',
  gyms_fitness: 'gimnasio fitness',
  beauty_salons: 'peluquería salón belleza',
  auto_dealerships: 'concesionario coches',
  accounting_finance: 'gestoría asesoría fiscal',
  it_technology: 'empresa tecnología informática',
  marketing_agencies: 'agencia marketing publicidad',
  retail_stores: 'tienda comercio',
  education_schools: 'academia escuela educación',
  logistics_transport: 'transporte logística',
  manufacturing: 'fábrica manufactura',
  travel_agencies: 'agencia de viajes',
  insurance: 'seguros correduría',
  e_commerce: 'tienda online ecommerce'
};

/**
 * Build Google Maps search URL
 */
function buildGoogleMapsUrl(industry, country, city) {
  const query = INDUSTRY_QUERIES[industry] || industry;
  const location = city ? `${city}, ${country}` : country;
  const searchQuery = encodeURIComponent(`${query} en ${location}`);
  return `https://www.google.com/maps/search/${searchQuery}`;
}

/**
 * Scrape individual business page for contact details
 */
async function scrapeBusinessContacts(page, url, log) {
  const contacts = { emails: [], phones: [], whatsappNumbers: [] };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText || '');

    // Extract emails
    const rawEmails = extractEmailsFromText(html + ' ' + text);
    contacts.emails = rawEmails.map(email => ({
      email,
      decoded: decodeObfuscatedEmail(email),
      confidence: getEmailConfidenceScore(email)
    })).filter(e => e.confidence > 30);

    // Extract phones
    const phones = extractPhoneNumbers(text + ' ' + html);
    contacts.phones = phones;

    // Extract WhatsApp specific links
    const waNumbers = extractWhatsAppFromContent(html, text);
    contacts.whatsappNumbers = waNumbers;

  } catch (err) {
    log.warning(`Failed to scrape contacts from ${url}: ${err.message}`);
  }

  return contacts;
}

/**
 * Main Google Maps scraper function
 */
export async function scrapeGoogleMaps({ industry, country, city, maxResults, proxyConfig, log, pushData }) {
  const countryCode = COUNTRY_CODES[country] || '';
  const searchUrl = buildGoogleMapsUrl(industry, country, city);
  const results = [];

  log.info(`🗺️ Starting Google Maps scrape: ${searchUrl}`);

  const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries: 3,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    headless: true,

    async requestHandler({ page, request, log: crawlerLog }) {
      if (results.length >= maxResults) return;

      if (request.label === 'SEARCH') {
        crawlerLog.info('📍 Parsing Google Maps search results...');

        await page.waitForSelector('[role="feed"]', { timeout: 15000 }).catch(() => {});
        await sleep(2000);

        // Scroll to load more results
        for (let i = 0; i < Math.ceil(maxResults / 20); i++) {
          await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            if (feed) feed.scrollTop = feed.scrollHeight;
          });
          await sleep(1500);
        }

        // Extract listing data
        const listings = await page.evaluate(() => {
          const items = document.querySelectorAll('[data-result-index], [jsaction*="mouseover:pane"]');
          const data = [];

          document.querySelectorAll('a[href*="/maps/place/"]').forEach(link => {
            const container = link.closest('[data-result-index]') || link.parentElement;
            if (!container) return;

            const name = container.querySelector('.qBF1Pd, .fontHeadlineSmall, h3')?.textContent?.trim() ||
                         link.textContent?.trim();

            const ratingEl = container.querySelector('[aria-label*="stars"], [aria-label*="estrellas"]');
            const rating = ratingEl?.getAttribute('aria-label')?.match(/[\d.]+/)?.[0] || null;

            const reviewEl = container.querySelector('[aria-label*="reviews"], [aria-label*="reseñas"]');
            const reviews = reviewEl?.getAttribute('aria-label')?.match(/[\d,]+/)?.[0]?.replace(',', '') || null;

            const addressEl = container.querySelector('.W4Efsd:last-child .W4Efsd:first-child > span:last-child, .Io6YTe');
            const address = addressEl?.textContent?.trim() || '';

            if (name && link.href) {
              data.push({
                name: name.replace(/\n/g, ' ').trim(),
                url: link.href,
                rating: rating ? parseFloat(rating) : null,
                reviewCount: reviews ? parseInt(reviews) : null,
                address
              });
            }
          });

          return data;
        });

        crawlerLog.info(`Found ${listings.length} listings`);

        // Add detail URLs to queue
        for (const listing of listings.slice(0, maxResults - results.length)) {
          await crawler.requestQueue?.addRequest({
            url: listing.url,
            label: 'DETAIL',
            userData: { listing }
          });
        }

      } else if (request.label === 'DETAIL') {
        if (results.length >= maxResults) return;

        const { listing } = request.userData;
        crawlerLog.info(`🔍 Scraping details: ${listing.name}`);

        await page.waitForSelector('[data-attrid="title"]', { timeout: 10000 }).catch(() => {});
        await sleep(1000);

        const pageText = await page.evaluate(() => document.body?.innerText || '');
        const pageHtml = await page.content();

        // Extract website link
        const website = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href]'));
          const websiteLink = links.find(l =>
            l.closest('[data-item-id="authority"]') ||
            l.getAttribute('aria-label')?.toLowerCase().includes('web') ||
            l.getAttribute('data-tooltip')?.toLowerCase().includes('web')
          );
          return websiteLink?.href || null;
        });

        // Get phone from the page
        const phoneFromPage = await page.evaluate(() => {
          const phoneEl = document.querySelector('[data-item-id*="phone"]');
          return phoneEl?.textContent?.trim() || null;
        });

        // Extract emails from text content
        const emails = extractEmailsFromText(pageText + ' ' + pageHtml);

        // Extract phones
        const phones = phoneFromPage
          ? [phoneFromPage, ...extractPhoneNumbers(pageText)]
          : extractPhoneNumbers(pageText);

        // Extract WhatsApp
        const waNumbers = extractWhatsAppFromContent(pageHtml, pageText);

        // If website exists, try to fetch it for more contact info
        let websiteContacts = { emails: [], phones: [], whatsappNumbers: [] };
        if (website && website.startsWith('http')) {
          websiteContacts = await scrapeBusinessContacts(page, website, crawlerLog);
        }

        // Merge all contacts
        const allEmails = [...new Set([
          ...emails,
          ...websiteContacts.emails.map(e => e.email)
        ])].filter(Boolean);

        const allPhones = [...new Set([
          ...phones,
          ...websiteContacts.phones
        ])].filter(Boolean);

        const allWaNumbers = [...new Set([
          ...waNumbers,
          ...websiteContacts.whatsappNumbers
        ])].filter(Boolean);

        // Build best email with confidence
        const bestEmail = allEmails
          .map(e => ({ email: e, score: getEmailConfidenceScore(e, listing.name) }))
          .sort((a, b) => b.score - a.score)[0];

        // Best phone
        const bestPhone = allPhones[0] ? normalizePhoneNumber(allPhones[0], countryCode) : null;

        // Best WhatsApp
        const bestWa = allWaNumbers[0] ||
          (bestPhone && isProbablyWhatsApp(bestPhone, country) ? bestPhone : null);

        const lead = {
          businessName: listing.name,
          industry,
          country,
          city: city || '',
          address: listing.address,
          rating: listing.rating,
          reviewCount: listing.reviewCount,
          website: website || null,
          email: bestEmail?.email || null,
          emailVerified: bestEmail ? bestEmail.score >= 60 : false,
          emailConfidence: bestEmail?.score || 0,
          phone: bestPhone,
          whatsapp: bestWa ? `+${bestWa}` : null,
          whatsappVerified: !!allWaNumbers[0], // Direct WA link = verified
          whatsappUrl: bestWa ? `https://wa.me/${bestWa}` : null,
          allEmails: allEmails.slice(0, 5),
          allPhones: allPhones.slice(0, 5),
          googleMapsUrl: listing.url,
          source: 'google_maps',
          scrapedAt: new Date().toISOString()
        };

        results.push(lead);
        await pushData(lead);
        crawlerLog.info(`✅ Lead saved: ${lead.businessName} | Email: ${lead.email || 'none'} | WA: ${lead.whatsapp || 'none'}`);
      }
    },

    failedRequestHandler({ request, log: crawlerLog }) {
      crawlerLog.error(`Request failed: ${request.url}`);
    }
  });

  await crawler.run([{ url: searchUrl, label: 'SEARCH' }]);

  log.info(`✅ Google Maps scraping complete. Found ${results.length} leads.`);
  return results;
}
