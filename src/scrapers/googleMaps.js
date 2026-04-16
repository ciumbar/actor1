/**
 * Google Maps scraper - Versión profesional
 * Técnica: interceptar requests XHR de la app de Maps
 * Igual que compass/crawler-google-places (334K usuarios)
 */
import { PlaywrightCrawler, sleep } from 'crawlee';
import { extractEmailsFromText, getEmailConfidenceScore } from '../emailVerifier.js';
import { extractPhoneNumbers, extractWhatsAppFromContent, isProbablyWhatsApp, normalizePhoneNumber, COUNTRY_CODES } from '../whatsappVerifier.js';

const INDUSTRY_QUERIES = {
  restaurants: 'restaurantes', hotels: 'hoteles', real_estate: 'inmobiliaria',
  construction: 'empresa construccion', law_firms: 'abogados', medical_clinics: 'clinica medica',
  dentists: 'dentista', gyms_fitness: 'gimnasio', beauty_salons: 'peluqueria salon belleza',
  auto_dealerships: 'concesionario coches', accounting_finance: 'gestoria asesoria',
  it_technology: 'empresa informatica', marketing_agencies: 'agencia marketing',
  retail_stores: 'tienda comercio', education_schools: 'academia escuela',
  logistics_transport: 'empresa transporte', manufacturing: 'fabrica industria',
  travel_agencies: 'agencia viajes', insurance: 'seguros', e_commerce: 'tienda online'
};

export async function scrapeGoogleMaps({ industry, country, city, maxResults, proxyConfig, log, pushData }) {
  const countryCode = COUNTRY_CODES[country] || '';
  const query = `${INDUSTRY_QUERIES[industry] || industry} ${city || country}`;
  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
  const results = [];

  log.info(`🗺️ Google Maps: "${query}"`);

  const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries: 3,
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 300,
    headless: true,
    launchContext: {
      launchOptions: {
        args: [
          '--no-sandbox', '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security', '--lang=es-ES',
        ],
      },
    },
    preNavigationHooks: [
      async ({ page }) => {
        // Eliminar señales de bot
        await page.addInitScript(() => {
          delete Object.getPrototypeOf(navigator).webdriver;
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
          Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es'] });
          window.chrome = { runtime: {} };
        });
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'es-ES,es;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Cache-Control': 'no-cache',
        });
      },
    ],

    async requestHandler({ page, request, log: L }) {
      if (results.length >= maxResults) return;
      L.info(`📍 [${request.label}] ${request.url.substring(0, 80)}`);

      if (request.label === 'SEARCH') {
        // Aceptar cookies Google
        try {
          await page.waitForSelector('button', { timeout: 6000 });
          const buttons = await page.$$('button');
          for (const btn of buttons) {
            const txt = (await btn.textContent()) || '';
            if (txt.includes('Acepto') || txt.includes('Accept') || txt.includes('Agree') || txt.includes('Aceptar')) {
              await btn.click();
              await sleep(1000);
              break;
            }
          }
        } catch { /* sin banner */ }

        // Esperar feed de resultados
        try {
          await page.waitForSelector('div[role="feed"]', { timeout: 20000 });
        } catch {
          // Intentar selector alternativo
          await page.waitForSelector('[jstcache]', { timeout: 10000 }).catch(() => {});
        }
        await sleep(2500);

        // Scroll para cargar resultados
        const scrolls = Math.min(Math.ceil(maxResults / 6) + 3, 25);
        for (let i = 0; i < scrolls; i++) {
          await page.evaluate(() => {
            const feed = document.querySelector('div[role="feed"]');
            if (feed) feed.scrollBy(0, 500);
            else window.scrollBy(0, 500);
          });
          await sleep(600);
        }

        // Extraer todos los enlaces de lugares
        const places = await page.evaluate(() => {
          const seen = new Set();
          const out = [];

          // Selector principal: tarjetas con enlace a /maps/place/
          document.querySelectorAll('a[href*="/maps/place/"]').forEach(a => {
            const href = a.href.split('?')[0]; // Limpiar parámetros
            if (seen.has(href) || !href.includes('/maps/place/')) return;
            seen.add(href);

            // Subir en el DOM para encontrar la tarjeta padre
            let card = a;
            for (let i = 0; i < 8; i++) {
              card = card.parentElement;
              if (!card) break;
              const h3 = card.querySelector('h3, [class*="fontHeadline"], .qBF1Pd');
              if (h3) {
                const name = h3.textContent?.trim();
                if (name) {
                  // Rating
                  const ratingEl = card.querySelector('[aria-label*="star"], [aria-label*="estrell"], span[role="img"]');
                  const ratingMatch = ratingEl?.getAttribute('aria-label')?.match(/[\d.]+/);
                  // Dirección
                  const addrEls = card.querySelectorAll('.W4Efsd span, .Io6YTe');
                  let address = '';
                  addrEls.forEach(el => { if (el.textContent?.includes(',')) address = el.textContent.trim(); });
                  out.push({ name, href: a.href, address, rating: ratingMatch ? parseFloat(ratingMatch[0]) : null });
                  return;
                }
              }
            }
            // Fallback: usar texto del enlace
            const name = a.querySelector('h3, [class*="fontHeadline"]')?.textContent?.trim()
                       || a.getAttribute('aria-label')?.trim();
            if (name) out.push({ name, href: a.href, address: '', rating: null });
          });
          return out;
        });

        L.info(`✅ Encontrados ${places.length} lugares en Maps`);

        for (const place of places.slice(0, maxResults)) {
          await crawler.requestQueue?.addRequest({
            url: place.href,
            label: 'DETAIL',
            userData: { place },
            uniqueKey: place.href,
          });
        }

      } else if (request.label === 'DETAIL') {
        if (results.length >= maxResults) return;
        const { place } = request.userData;

        // Esperar que cargue la ficha del negocio
        await page.waitForSelector('.DUwDvf, h1.fontHeadlineLarge, [data-attrid="title"]', { timeout: 15000 })
          .catch(() => {});
        await sleep(800);

        const html = await page.content();
        const text = await page.evaluate(() => document.body?.innerText || '');

        // Teléfono — buscamos el enlace tel: directo
        const phone = await page.evaluate(() => {
          const tel = document.querySelector('a[href^="tel:"]');
          if (tel) return tel.href.replace('tel:', '').trim();
          const elems = document.querySelectorAll('[data-item-id], [aria-label]');
          for (const el of elems) {
            const label = el.getAttribute('aria-label') || el.getAttribute('data-item-id') || '';
            if (label.toLowerCase().includes('phone') || label.toLowerCase().includes('teléfono') || label.toLowerCase().includes('telef')) {
              const match = label.match(/[\+\d][\d\s\-().]{7,}/);
              if (match) return match[0].trim();
            }
          }
          return null;
        });

        // Web
        const website = await page.evaluate(() => {
          const sel = [
            '[data-item-id="authority"] a',
            'a[aria-label*="itio web"]',
            'a[aria-label*="Website"]',
            'a[data-tooltip="Open website"]',
            'a[jsaction*="pane.website"]',
          ];
          for (const s of sel) {
            const el = document.querySelector(s);
            if (el?.href && !el.href.includes('google.com')) return el.href;
          }
          return null;
        });

        let emails = extractEmailsFromText(text + ' ' + html);
        let waNumbers = extractWhatsAppFromContent(html, text);
        let phones = phone ? [phone, ...extractPhoneNumbers(text)] : extractPhoneNumbers(text);

        // Visitar web del negocio para extraer email y WA
        if (website && website.startsWith('http') && !website.includes('google.com')) {
          try {
            await page.goto(website, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await sleep(700);
            const wHtml = await page.content();
            const wText = await page.evaluate(() => document.body?.innerText || '');
            emails = [...new Set([...emails, ...extractEmailsFromText(wHtml + ' ' + wText)])];
            waNumbers = [...new Set([...waNumbers, ...extractWhatsAppFromContent(wHtml, wText)])];

            // Buscar en /contacto si no hay email aún
            if (emails.length === 0) {
              for (const path of ['/contacto', '/contact', '/contacta', '/sobre-nosotros']) {
                try {
                  await page.goto(new URL(path, website).href, { waitUntil: 'domcontentloaded', timeout: 8000 });
                  const cHtml = await page.content();
                  const cText = await page.evaluate(() => document.body?.innerText || '');
                  const newEmails = extractEmailsFromText(cHtml + ' ' + cText);
                  const newWa = extractWhatsAppFromContent(cHtml, cText);
                  if (newEmails.length > 0) { emails = [...new Set([...emails, ...newEmails])]; break; }
                  if (newWa.length > 0) waNumbers = [...new Set([...waNumbers, ...newWa])];
                } catch { /* continuar */ }
              }
            }
          } catch { /* web inaccesible */ }
        }

        emails = [...new Set(emails)].filter(Boolean);
        phones = [...new Set(phones)].filter(Boolean);

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
          scrapedAt: new Date().toISOString(),
        };

        results.push(lead);
        await pushData(lead);
        L.info(`✅ ${lead.businessName} | 📧 ${lead.email || '-'} | 📱 ${lead.whatsapp || '-'}`);
      }
    },

    failedRequestHandler({ request, log: L }) {
      L.warning(`⚠️ Fallo: ${request.url}`);
    },
  });

  await crawler.run([{ url: searchUrl, label: 'SEARCH' }]);
  log.info(`✅ Google Maps: ${results.length} leads`);
  return results;
}
