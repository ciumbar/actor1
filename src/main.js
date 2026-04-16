/**
 * Lead Scraper – Verified Email & WhatsApp
 * Para Noxoia Empresas — Automatización IA para pymes
 */
import { Actor, log } from 'apify';
import { scrapeGoogleMaps } from './scrapers/googleMaps.js';
import { scrapeYellowPages } from './scrapers/yellowPages.js';

await Actor.init();

try {
  const input = await Actor.getInput();

  const {
    industry = 'medical_clinics',
    country = 'spain',
    city = '',
    maxResults = 50,
    sources = ['google_maps', 'yellow_pages'],
    proxyConfiguration: proxyConfig = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
  } = input || {};

  log.info('═══════════════════════════════════════════════');
  log.info('🚀 Lead Scraper – Email & WhatsApp Extractor');
  log.info('═══════════════════════════════════════════════');
  log.info(`📦 Sector    : ${industry}`);
  log.info(`🌍 País      : ${country}`);
  log.info(`🏙️  Ciudad    : ${city || '(todo el país)'}`);
  log.info(`📊 Max leads : ${maxResults}`);
  log.info(`🔍 Fuentes   : ${sources.join(', ')}`);
  log.info('═══════════════════════════════════════════════');

  let proxy = null;
  try {
    proxy = await Actor.createProxyConfiguration(proxyConfig);
  } catch {
    log.warning('Sin proxy — ejecutando sin proxy (más riesgo de bloqueos)');
  }

  const dataset = await Actor.openDataset();
  const allLeads = [];
  const seen = new Set();

  async function pushLead(lead) {
    const key = `${lead.businessName}|${lead.city}`.toLowerCase().replace(/\s/g, '');
    if (!seen.has(key)) {
      seen.add(key);
      allLeads.push(lead);
      await dataset.pushData(lead);
    }
  }

  const perSource = Math.ceil(maxResults / Math.max(sources.length, 1));
  const params = { industry, country, city, maxResults: perSource, proxyConfig: proxy, log, pushData: pushLead };

  const tasks = [];
  if (sources.includes('google_maps')) {
    log.info('🗺️  Iniciando Google Maps...');
    tasks.push(scrapeGoogleMaps(params).catch(e => { log.error(`Google Maps falló: ${e.message}`); return []; }));
  }
  if (sources.includes('yellow_pages')) {
    log.info('📒 Iniciando PáginasAmarillas...');
    tasks.push(scrapeYellowPages(params).catch(e => { log.error(`PáginasAmarillas falló: ${e.message}`); return []; }));
  }

  await Promise.all(tasks);

  const stats = {
    total: allLeads.length,
    conEmail: allLeads.filter(l => l.email).length,
    emailVerificado: allLeads.filter(l => l.emailVerified).length,
    conWhatsApp: allLeads.filter(l => l.whatsapp).length,
    waVerificado: allLeads.filter(l => l.whatsappVerified).length,
    ambos: allLeads.filter(l => l.email && l.whatsapp).length,
  };

  log.info('═══════════════════════════════════════════════');
  log.info(`✅ TOTAL leads         : ${stats.total}`);
  log.info(`📧 Con email           : ${stats.conEmail} (verificados: ${stats.emailVerificado})`);
  log.info(`📱 Con WhatsApp        : ${stats.conWhatsApp} (verificados: ${stats.waVerificado})`);
  log.info(`🎯 Con email + WA      : ${stats.ambos}`);
  log.info('═══════════════════════════════════════════════');

  await Actor.setValue('STATS', stats);
  log.info('🎉 Actor finalizado!');

} catch (err) {
  log.error(`Error fatal: ${err.message}\n${err.stack}`);
  throw err;
} finally {
  await Actor.exit();
}
