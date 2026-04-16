/**
 * WhatsApp number extraction and verification utilities
 */

/**
 * Country phone codes mapping
 */
export const COUNTRY_CODES = {
  spain: '34',
  mexico: '52',
  argentina: '54',
  colombia: '57',
  chile: '56',
  peru: '51',
  united_states: '1',
  united_kingdom: '44',
  france: '33',
  germany: '49',
  italy: '39',
  portugal: '351',
  brazil: '55',
  uruguay: '598',
  venezuela: '58',
  ecuador: '593',
  bolivia: '591',
  paraguay: '595',
  panama: '507',
  costa_rica: '506'
};

/**
 * Clean and normalize a phone number
 */
export function normalizePhoneNumber(phone, countryCode = '') {
  if (!phone) return null;

  // Remove all non-numeric characters except leading +
  let cleaned = phone.replace(/[^\d+]/g, '');

  // Remove leading +
  cleaned = cleaned.replace(/^\+/, '');

  // Remove leading zeros (international format)
  cleaned = cleaned.replace(/^00/, '');

  // If number doesn't start with country code, prepend it
  if (countryCode && !cleaned.startsWith(countryCode)) {
    // Remove local leading zero
    cleaned = cleaned.replace(/^0+/, '');
    cleaned = countryCode + cleaned;
  }

  return cleaned;
}

/**
 * Extract phone numbers from text
 * Handles multiple formats: +34 612 345 678, 612-345-678, (34) 612345678, etc.
 */
export function extractPhoneNumbers(text) {
  if (!text) return [];

  const patterns = [
    // International format: +34 612 345 678
    /\+[\d\s\-().]{7,18}\d/g,
    // With parentheses: (34) 612 345 678
    /\([\d]{1,4}\)[\s\-.]?[\d\s\-.]{6,15}/g,
    // Plain: 612 345 678 or 612-345-678
    /\b[\d]{2,4}[\s\-.][\d]{3}[\s\-.][\d]{3,4}\b/g,
    // 9 digit Spanish mobile: 6XX or 7XX
    /\b[67]\d{8}\b/g,
  ];

  const found = new Set();
  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    matches.forEach(m => found.add(m.trim()));
  }

  return [...found];
}

/**
 * Check if a phone number could be a WhatsApp number
 * WhatsApp supports mobile numbers; landlines usually can't use WhatsApp
 */
export function isProbablyWhatsApp(phone, country = '') {
  const cleaned = phone.replace(/[^\d]/g, '');
  const countryCode = COUNTRY_CODES[country] || '';

  // Get the number without country code
  let local = cleaned;
  if (countryCode && local.startsWith(countryCode)) {
    local = local.substring(countryCode.length);
  }

  // Mobile number patterns by country
  const mobilePatterns = {
    '34': /^[67]\d{8}$/, // Spain: 6XX or 7XX
    '52': /^[1-9]\d{9}$/, // Mexico: 10 digits
    '54': /^[1-9]\d{9,10}$/, // Argentina
    '57': /^3\d{9}$/, // Colombia: 3XX XXXXXXX
    '56': /^[79]\d{8}$/, // Chile
    '51': /^9\d{8}$/, // Peru: 9XX XXX XXX
    '1':  /^[2-9]\d{9}$/, // US/Canada
    '44': /^7\d{9}$/, // UK: 07XXX XXXXXX
    '55': /^[1-9]{2}9?\d{8}$/, // Brazil
  };

  const pattern = mobilePatterns[countryCode];
  if (pattern) {
    return pattern.test(local);
  }

  // Generic: if number is 8-12 digits, assume potentially mobile
  return local.length >= 8 && local.length <= 12;
}

/**
 * Generate WhatsApp click-to-chat URL for verification
 */
export function getWhatsAppUrl(phone, countryCode = '') {
  const normalized = normalizePhoneNumber(phone, countryCode);
  if (!normalized) return null;
  return `https://wa.me/${normalized}`;
}

/**
 * Extract WhatsApp links from page content
 * Finds: wa.me links, api.whatsapp.com links, WhatsApp buttons
 */
export function extractWhatsAppFromContent(html, text) {
  const found = new Set();

  // Extract from wa.me links
  const waMePattern = /wa\.me\/(\+?[\d]{7,15})/gi;
  const waMeMatches = (html + ' ' + text).match(waMePattern) || [];
  waMeMatches.forEach(m => {
    const num = m.replace(/wa\.me\//i, '').replace(/\+/, '');
    if (num) found.add(num);
  });

  // Extract from api.whatsapp.com links
  const waApiPattern = /api\.whatsapp\.com\/send\?phone=([\d]+)/gi;
  let match;
  const fullText = html + ' ' + text;
  while ((match = waApiPattern.exec(fullText)) !== null) {
    if (match[1]) found.add(match[1]);
  }

  // Extract from whatsapp:// protocol
  const waProtoPattern = /whatsapp:\/\/send\?phone=([\d]+)/gi;
  while ((match = waProtoPattern.exec(fullText)) !== null) {
    if (match[1]) found.add(match[1]);
  }

  return [...found];
}

/**
 * Format phone for display
 */
export function formatPhoneDisplay(phone, country = '') {
  const code = COUNTRY_CODES[country];
  if (!code || !phone) return phone;

  const cleaned = phone.replace(/[^\d]/g, '');
  if (cleaned.startsWith(code)) {
    return '+' + code + ' ' + cleaned.substring(code.length).replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
  }
  return '+' + cleaned;
}
