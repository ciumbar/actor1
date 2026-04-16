/**
 * Lead Scraper – Verified Email & WhatsApp
 * Apify Actor – Optimizado para Noxoia Empresas
 * Fuentes: Yelp + Hotfrog + PáginasAmarillas
 */
import { Actor, log } from 'apify';
import { scrapeYelp } from './scrapers/yelp.js';
import { scrapeHotfrog } from './scrapers/hotfrog.js';
import { scrapeYellowPages } from './scrapers/yellowPages.js';

await Actor.init();

try {
  const input = await Actor.getInput();

  const {
    industry = 'medical_clinics',
    country = 'spain',
    city = '',
    maxResults = 100,
    sources = ['yelp', 'hotfrog', 'yellow_pages'],
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
  log.info('═══════════════════════════════════════════════');

  let proxy = null;
  try {
    proxy = await Actor.createProxyConfiguration(proxyConfig);
  } catch {
    log.warning('Proxy configuration failed, running without proxy');
  }

  const dataset = await Actor.openDataset();
  const allLeads = [];
  const seenBusinesses = new Set();

  async function pushDeduplicatedLead(lead) {
    const key = `${lead.businessName}|${lead.city}`.toLowerCase().replace(/\s+/g, '');
    if (!seenBusinesses.has(key)) {
      seenBusinesses.add(key);
      allLeads.push(lead);
      await dataset.pushData(lead);
    }
  }

  const resultsPerSource = Math.ceil(maxResults / Math.max(sources.length, 1));
  const scraperParams = {
    industry, country, city,
    maxResults: resultsPerSource,
    proxyConfig: proxy,
    log,
    pushData: pushDeduplicatedLead
  };

  const scraperTasks = [];

  if (sources.includes('yelp')) {
    log.info('⭐ Starting Yelp scraper...');
    scraperTasks.push(
      scrapeYelp(scraperParams).catch(err => {
        log.error(`Yelp scraper failed: ${err.message}`);
        return [];
      })
    );
  }

  if (sources.includes('hotfrog')) {
    log.info('🔥 Starting Hotfrog scraper...');
    scraperTasks.push(
      scrapeHotfrog(scraperParams).catch(err => {
        log.error(`Hotfrog scraper failed: ${err.message}`);
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

  await Promise.all(scraperTasks);

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

  await Actor.setValue('STATS', stats);
  log.info('🎉 Actor finished successfully!');

} catch (error) {
  log.error(`Actor failed: ${error.message}`);
  throw error;
} finally {
  await Actor.exit();
}
