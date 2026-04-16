/**
 * PáginasAmarillas scraper - Versión final con CheerioCrawler
 * Más rápido y sin bloqueos que Playwright para HTML estático
 */
import { CheerioCrawler, PlaywrightCrawler, sleep } from 'crawlee';
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
  brazil: 'https://www.paginasamarelas.com.br',
};

const INDUSTRY_KEYWORDS = {
  restaurants: 'restaurantes', hotels: 'hoteles', real_estate: 'inmobiliaria',
  construction: 'construccion', law_firms: 'abogados', medical_clinics: 'medicos',
  dentists: 'dentistas', gyms_fitness: 'gimnasios', beauty_salons: 'peluquerias',
  auto_dealerships: 'concesionarios', accounting_finance: 'gestoria',
  it_technology: 'informatica', marketing_agencies: 'agencias-marketing',
  retail_stores: 'tiendas', education_schools: 'academias',
  logistics_transport: 'transportes', manufacturing: 'fabricacion',
  travel_agencies: 'agencias-viajes', insurance: 'seguros', e_commerce: 'comercio-electronico',
};

function buildUrl(industry, country, city) {
  const base = YELLOW_PAGES_URLS[country] || YELLOW_PAGES_URLS.spain;
  const kw = INDUSTRY_KEYWORDS[industry] || industry.replace(/_/g, '-');
  if (country === 'united_states') {
    return `${base}/search?search_terms=${encodeURIComponent(kw)}&geo_location_terms=${encodeURIComponent(city || '')}`;
  }
  if (country === 'united_kingdom') {
    return `${base}/search?what=${encodeURIComponent(kw)}&where=${encodeURIComponent(city || '')}`;
  }
  const citySlug = city
    ? city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    : '';
  return citySlug ? `${base}/${kw}/${citySlug}/1` : `${base}/${kw}/1`;
}

export async function scrapeYellowPages({ industry, country, city, maxResults, proxyConfig, log, pushData }) {
  const countryCode = COUNTRY_CODES[country] || '';
  const searchUrl = buildUrl(industry, country, city);
  const results = [];

  log.info(`📒 Yellow Pages: ${searchUrl}`);

  // Primero intentamos con CheerioCrawler (rápido, sin bloqueos)
  const detailUrls = [];

  const listingCrawler = new CheerioCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries: 2,
    navigationTimeoutSecs: 30,
    additionalMimeTypes: ['text/html'],
    requestHandlerTimeoutSecs: 60,

    async requestHandler({ $, request, log: L }) {
      L.info(`📋 Listado: ${request.url}`);

      // Extraer tarjetas de negocios con Cheerio
      const cards = $('.listado-item, .item-listado, article.item, .listado article, li.listado-item');

      if (cards.length === 0) {
        L.warning('No se encontraron tarjetas con selectores CSS. Revisar estructura HTML.');
      }

      cards.each((i, el) => {
        if (detailUrls.length >= maxResults) return;
        const $el = $(el);
        const nameLink = $el.find('h2 a, h3 a, .nombre a, a.nombre, [itemprop="name"] a').first();
        const name = nameLink.text().trim();
        const href = nameLink.attr('href');
        const phone = $el.find('[itemprop="telephone"], .telefono, .phone').first().text().trim() || null;
        const address = $el.find('[itemprop="address"], address, .direccion').first().text().trim() || '';
        const emailLink = $el.find('a[href^="mailto:"]').first();
        const email = emailLink.length ? emailLink.attr('href').replace('mailto:', '') : null;
        const website = $el.find('a[href^="http"]:not([href*="paginasamarillas"])').first().attr('href') || null;

        if (name && href) {
          const fullHref = href.startsWith('http') ? href : `${YELLOW_PAGES_URLS[country] || YELLOW_PAGES_URLS.spain}${href}`;
          detailUrls.push({ name, href: fullHref, phone, address, email, website });
        }
      });

      L.info(`Extraídas ${detailUrls.length} entradas del listado`);

      // Paginación
      if (detailUrls.length < maxResults) {
        const nextHref = $('a[rel="next"], a.next, .pagination a:last-child, a[aria-label="Siguiente"]').first().attr('href');
        if (nextHref) {
          const nextUrl = nextHref.startsWith('http') ? nextHref : `${YELLOW_PAGES_URLS[country] || YELLOW_PAGES_URLS.spain}${nextHref}`;
          await listingCrawler.requestQueue?.addRequest({ url: nextUrl });
        }
      }
    },
    failedRequestHandler({ request, log: L }) {
      L.warning(`Fallo listado: ${request.url}`);
    },
  });

  await listingCrawler.run([{ url: searchUrl }]);

  if (detailUrls.length === 0) {
    log.warning('CheerioCrawler no extrajo datos. Usando Playwright como fallback...');
    return scrapeYellowPagesPlaywright({ industry, country, city, maxResults, proxyConfig, log, pushData, searchUrl });
  }

  log.info(`📒 Procesando ${detailUrls.length} fichas con Playwright...`);

  // Visitar webs de los negocios con Playwright para extraer email y WA
  const detailCrawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries: 1,
    navigationTimeoutSecs: 30,
    requestHandlerTimeoutSecs: 60,
    maxConcurrency: 3,
    headless: true,
    launchContext: {
      launchOptions: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    },

    async requestHandler({ page, request, log: L }) {
      if (results.length >= maxResults) return;
      const { listing } = request.userData;

      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(500);

      const html = await page.content();
      const text = await page.evaluate(() => document.body?.innerText || '');

      let emails = listing.email ? [listing.email, ...extractEmailsFromText(html + ' ' + text)] : extractEmailsFromText(html + ' ' + text);
      let phones = listing.phone ? [listing.phone, ...extractPhoneNumbers(text)] : extractPhoneNumbers(text);
      let waNumbers = extractWhatsAppFromContent(html, text);

      // Obtener web desde la ficha de PáginasAmarillas si no la tenemos
      let website = listing.website;
      if (!website) {
        website = await page.evaluate(() => {
          return document.querySelector('a.web-link, a[data-ga-label="website"], a[href*="http"]:not([href*="paginasamarillas"])')?.href || null;
        });
      }

      // Visitar web del negocio
      if (website && website.startsWith('http') && !website.includes('paginasamarillas')) {
        try {
          await page.goto(website, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await sleep(500);
          const wHtml = await page.content();
          const wText = await page.evaluate(() => document.body?.innerText || '');
          emails = [...new Set([...emails, ...extractEmailsFromText(wHtml + ' ' + wText)])];
          waNumbers = [...new Set([...waNumbers, ...extractWhatsAppFromContent(wHtml, wText)])];
        } catch { /* web inaccesible */ }
      }

      emails = [...new Set(emails)].filter(Boolean);
      phones = [...new Set(phones)].filter(Boolean);

      const bestEmail = emails.map(e => ({ email: e, score: getEmailConfidenceScore(e, listing.name) })).sort((a, b) => b.score - a.score)[0];
      const bestPhone = phones[0] ? normalizePhoneNumber(phones[0], countryCode) : null;
      const bestWa = waNumbers[0] || (bestPhone && isProbablyWhatsApp(bestPhone, country) ? bestPhone : null);

      const lead = {
        businessName: listing.name,
        industry, country, city: city || '',
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
        scrapedAt: new Date().toISOString(),
      };

      results.push(lead);
      await pushData(lead);
      L.info(`✅ ${lead.businessName} | 📧 ${lead.email || '-'} | 📱 ${lead.whatsapp || '-'}`);
    },
    failedRequestHandler({ request, log: L }) {
      L.warning(`Fallo detalle: ${request.url}`);
    },
  });

  const detailRequests = detailUrls.slice(0, maxResults).map(listing => ({
    url: listing.href,
    label: 'DETAIL',
    userData: { listing },
  }));

  await detailCrawler.run(detailRequests);
  log.info(`✅ Yellow Pages: ${results.length} leads`);
  return results;
}

// Fallback con Playwright puro si Cheerio falla
async function scrapeYellowPagesPlaywright({ industry, country, city, maxResults, proxyConfig, log, pushData, searchUrl }) {
  const countryCode = COUNTRY_CODES[country] || '';
  const results = [];
  const base = YELLOW_PAGES_URLS[country] || YELLOW_PAGES_URLS.spain;

  const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries: 2,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 180,
    headless: true,
    launchContext: { launchOptions: { args: ['--no-sandbox', '--lang=es-ES'] } },

    async requestHandler({ page, request, log: L }) {
      if (results.length >= maxResults) return;
      await page.waitForLoadState('domcontentloaded');
      await sleep(2000);

      // Aceptar cookies
      try {
        await page.click('#didomi-notice-agree-button, #onetrust-accept-btn-handler, button[class*="accept"]', { timeout: 3000 });
        await sleep(500);
      } catch { /* sin banner */ }

      const html = await page.content();
      const $ = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('.listado-item, article.item, .item-listado').forEach(card => {
          const nameEl = card.querySelector('h2 a, h3 a, .nombre a');
          if (!nameEl) return;
          items.push({
            name: nameEl.textContent?.trim(),
            href: nameEl.href,
            phone: card.querySelector('[itemprop="telephone"], .telefono')?.textContent?.trim() || null,
            address: card.querySelector('[itemprop="address"], address')?.textContent?.trim() || '',
            email: card.querySelector('a[href^="mailto:"]')?.href?.replace('mailto:', '') || null,
          });
        });
        return items;
      });

      L.info(`Playwright fallback: ${$.length} listados`);

      for (const listing of $.slice(0, maxResults - results.length)) {
        let emails = listing.email ? [listing.email] : [];
        let phones = listing.phone ? [listing.phone] : [];
        let waNumbers = [];

        if (listing.href) {
          try {
            await page.goto(listing.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await sleep(600);
            const dHtml = await page.content();
            const dText = await page.evaluate(() => document.body?.innerText || '');
            emails = [...new Set([...emails, ...extractEmailsFromText(dHtml + ' ' + dText)])];
            phones = [...new Set([...phones, ...extractPhoneNumbers(dText)])];
            waNumbers = extractWhatsAppFromContent(dHtml, dText);
            const web = await page.evaluate(() => document.querySelector('a.web-link')?.href || null);
            if (web && web.startsWith('http')) {
              try {
                await page.goto(web, { waitUntil: 'domcontentloaded', timeout: 12000 });
                const wHtml = await page.content();
                const wText = await page.evaluate(() => document.body?.innerText || '');
                emails = [...new Set([...emails, ...extractEmailsFromText(wHtml + ' ' + wText)])];
                waNumbers = [...new Set([...waNumbers, ...extractWhatsAppFromContent(wHtml, wText)])];
              } catch { /* web inaccesible */ }
            }
          } catch { /* fallo detalle */ }
        }

        emails = [...new Set(emails)].filter(Boolean);
        phones = [...new Set(phones)].filter(Boolean);
        const bestEmail = emails.map(e => ({ email: e, score: getEmailConfidenceScore(e, listing.name) })).sort((a, b) => b.score - a.score)[0];
        const bestPhone = phones[0] ? normalizePhoneNumber(phones[0], countryCode) : null;
        const bestWa = waNumbers[0] || (bestPhone && isProbablyWhatsApp(bestPhone, country) ? bestPhone : null);

        const lead = {
          businessName: listing.name, industry, country, city: city || '',
          address: listing.address || '', website: null,
          email: bestEmail?.email || null, emailVerified: bestEmail ? bestEmail.score >= 60 : false,
          emailConfidence: bestEmail?.score || 0, phone: bestPhone || null,
          whatsapp: bestWa ? `+${String(bestWa).replace(/^\+/, '')}` : null,
          whatsappVerified: !!waNumbers[0],
          whatsappUrl: bestWa ? `https://wa.me/${String(bestWa).replace(/[^0-9]/g, '')}` : null,
          allEmails: emails.slice(0, 5), allPhones: phones.slice(0, 5),
          source: 'yellow_pages', scrapedAt: new Date().toISOString(),
        };
        results.push(lead);
        await pushData(lead);
        L.info(`✅ ${lead.businessName} | 📧 ${lead.email || '-'} | 📱 ${lead.whatsapp || '-'}`);
      }
    },
    failedRequestHandler({ request, log: L }) { L.warning(`Fallo: ${request.url}`); },
  });

  await crawler.run([{ url: searchUrl }]);
  return results;
}
