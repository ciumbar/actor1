/**
 * Lead Scraper – Verified Email & WhatsApp
 * Apify Actor – Main Entry Point
 *
 * Scrapes verified business emails and WhatsApp contacts
 * filtered by industry, country and city.
 */
import { Actor, log } from 'apify';
import { scrapeGoogleMaps } from './scrapers/googleMaps.js';
import { scrapeYellowPages } from './scrapers/yellowPages.js';

await Actor.init();

try {
  // ─────────────────────────────────────────
  // 1. READ INPUT
  // ─────────────────────────────────────────
  const input = await Actor.getInput();

  const {
    // 📌 PLACEHOLDER 1 – Industry / Sector
    industry = 'restaurants',

    // 📌 PLACEHOLDER 2 – Country
    country = 'spain',

    // 📌 PLACEHOLDER 3 – City (optional)
    city = '',

    maxResults = 100,
    sources = ['google_maps', 'yellow_pages'],
    verifyEmails = true,
    extractWhatsApp = true,
    proxyConfiguration: proxyConfig = { useApifyProxy: true }
  } = input || {};

  log.info('═══════════════════════════════════════════════');
  log.info('🚀 Lead Scraper – Email & WhatsApp Extractor');
  log.info('═══════════════════════════════════════════════');
  log.info(`📦 Industry  : ${industry}`);
  log.info(`🌍 Country   : ${country}`);
  log.info(`🏙️  City      : ${city || '(all)'}`);
  log.info(`📊 Max results: ${maxResults}`);
  log.info(`🔍 Sources   : ${sources.join(', ')}`);
  log.info(`✅ Verify emails: ${verifyEmails}`);
  log.info(`📱 Extract WhatsApp: ${extractWhatsApp}`);
  log.info('═══════════════════════════════════════════════');

  // ─────────────────────────────────────────
  // 2. SETUP PROXY
  // ─────────────────────────────────────────
  let proxy = null;
  try {
    proxy = await Actor.createProxyConfiguration(proxyConfig);
  } catch {
    log.warning('Proxy configuration failed, running without proxy');
  }

  // ─────────────────────────────────────────
  // 3. SHARED STATE
  // ─────────────────────────────────────────
  const dataset = await Actor.openDataset();
  const allLeads = [];
  const seenBusinesses = new Set();

  async function pushDeduplicatedLead(lead) {
    const key = `${lead.businessName}|${lead.city}`.toLowerCase();
    if (!seenBusinesses.has(key)) {
      seenBusinesses.add(key);
      allLeads.push(lead);
      await dataset.pushData(lead);
    }
  }

  const resultsPerSource = Math.ceil(maxResults / Math.max(sources.length, 1));
  const scraperParams = {
    industry,
    country,
    city,
    maxResults: resultsPerSource,
    proxyConfig: proxy,
    log,
    pushData: pushDeduplicatedLead
  };

  // ─────────────────────────────────────────
  // 4. RUN SCRAPERS
  // ─────────────────────────────────────────
  const scraperTasks = [];

  if (sources.includes('google_maps')) {
    log.info('📍 Starting Google Maps scraper...');
    scraperTasks.push(
      scrapeGoogleMaps(scraperParams).catch(err => {
        log.error(`Google Maps scraper failed: ${err.message}`);
        return [];
      })
    );
  }

  if (sources.includes('yellow_pages')) {
    log.info('📒 Starting Yellow Pages scraper...');
    scraperTasks.push(
      scrapeYellowPages(scraperParams).catch(err => {
        log.error(`Yellow Pages scraper failed: ${err.message}`);
        return [];
      })
    );
  }

  // Run all scrapers (in parallel if multiple sources)
  await Promise.all(scraperTasks);

  // ─────────────────────────────────────────
  // 5. GENERATE STATS & SUMMARY
  // ─────────────────────────────────────────
  const stats = {
    totalLeads: allLeads.length,
    withEmail: allLeads.filter(l => l.email).length,
    withVerifiedEmail: allLeads.filter(l => l.emailVerified).length,
    withWhatsApp: allLeads.filter(l => l.whatsapp).length,
    withVerifiedWhatsApp: allLeads.filter(l => l.whatsappVerified).length,
    withBoth: allLeads.filter(l => l.email && l.whatsapp).length,
    bySource: {}
  };

  sources.forEach(src => {
    stats.bySource[src] = allLeads.filter(l => l.source === src).length;
  });

  log.info('═══════════════════════════════════════════════');
  log.info('📊 FINAL RESULTS SUMMARY');
  log.info('═══════════════════════════════════════════════');
  log.info(`✅ Total leads scraped    : ${stats.totalLeads}`);
  log.info(`📧 With email            : ${stats.withEmail}`);
  log.info(`✅ With verified email   : ${stats.withVerifiedEmail}`);
  log.info(`📱 With WhatsApp         : ${stats.withWhatsApp}`);
  log.info(`✅ With verified WA      : ${stats.withVerifiedWhatsApp}`);
  log.info(`🎯 With BOTH (email+WA)  : ${stats.withBoth}`);
  log.info('───────────────────────────────────────────────');
  Object.entries(stats.bySource).forEach(([src, count]) => {
    log.info(`   ${src}: ${count} leads`);
  });
  log.info('═══════════════════════════════════════════════');

  // Save stats to key-value store
  await Actor.setValue('STATS', stats);

  log.info('🎉 Actor finished successfully!');

} catch (error) {
  log.error(`Actor failed: ${error.message}`);
  log.error(error.stack);
  throw error;
} finally {
  await Actor.exit();
}
