# 🔍 Lead Scraper – Verified Email & WhatsApp

> Extract verified business emails and WhatsApp contacts filtered by **industry**, **country** and **city**. Ready to import into Apify.

---

## ✨ Features

- 🏭 **Filter by Industry** — 20 sectors (restaurants, hotels, tech, law firms, etc.)
- 🌍 **Filter by Country** — 20 countries (Spain, Mexico, Argentina, Colombia, US, UK, etc.)
- 🏙️ **Filter by City** — Any city within the selected country
- 📧 **Email Extraction + Confidence Score** — Validates format, domain, and business match
- 📱 **WhatsApp Detection** — Extracts `wa.me` links + mobile number verification
- 🔄 **Multi-Source Scraping** — Google Maps + Yellow Pages (simultaneous)
- 🧹 **Deduplication** — No repeated businesses across sources
- 📊 **Export to CSV/JSON/Excel** — Standard Apify dataset output

---

## 🚀 Quick Start

### Option A – Import to Apify (recommended)

1. Go to [apify.com](https://apify.com) → **Actors** → **Create new**
2. Choose **Link a GitHub repository**
3. Paste this repo URL
4. Click **Build** → **Run**

### Option B – Run locally

```bash
git clone https://github.com/YOUR_USERNAME/lead-scraper-email-whatsapp
cd lead-scraper-email-whatsapp
npm install
npm run dev
```

---

## ⚙️ Input Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `industry` | select | `restaurants` | Business sector to search |
| `country` | select | `spain` | Target country |
| `city` | string | *(empty)* | Target city (optional) |
| `maxResults` | number | `100` | Max leads to extract (1–5000) |
| `sources` | array | `[google_maps, yellow_pages]` | Data sources to use |
| `verifyEmails` | boolean | `true` | Run email validation |
| `extractWhatsApp` | boolean | `true` | Detect WhatsApp numbers |
| `proxyConfiguration` | object | Apify Proxy | Proxy settings |

### Example Input (JSON)

```json
{
  "industry": "restaurants",
  "country": "spain",
  "city": "Barcelona",
  "maxResults": 200,
  "sources": ["google_maps", "yellow_pages"],
  "verifyEmails": true,
  "extractWhatsApp": true,
  "proxyConfiguration": {
    "useApifyProxy": true
  }
}
```

---

## 📤 Output Format

Each lead is saved with the following fields:

```json
{
  "businessName": "Restaurant El Born",
  "industry": "restaurants",
  "country": "spain",
  "city": "Barcelona",
  "address": "Carrer del Rec, 10, 08003 Barcelona",
  "website": "https://restauranteelborn.com",
  "email": "info@restauranteelborn.com",
  "emailVerified": true,
  "emailConfidence": 85,
  "phone": "+34612345678",
  "whatsapp": "+34612345678",
  "whatsappVerified": true,
  "whatsappUrl": "https://wa.me/34612345678",
  "rating": 4.5,
  "reviewCount": 312,
  "allEmails": ["info@restauranteelborn.com"],
  "allPhones": ["+34612345678"],
  "googleMapsUrl": "https://maps.google.com/...",
  "source": "google_maps",
  "scrapedAt": "2025-01-15T10:30:00Z"
}
```

---

## 🔧 Architecture

```
.
├── .actor/
│   ├── actor.json          # Actor metadata & dataset views
│   └── input_schema.json   # UI input form definition
├── src/
│   ├── main.js             # Entry point & orchestrator
│   ├── emailVerifier.js    # Email extraction & scoring
│   ├── whatsappVerifier.js # WhatsApp detection & phone utils
│   └── scrapers/
│       ├── googleMaps.js   # Google Maps scraper
│       └── yellowPages.js  # Yellow Pages scraper
├── Dockerfile              # Apify Docker image
├── package.json
└── README.md
```

---

## 📊 Supported Industries

| Key | Label |
|-----|-------|
| `restaurants` | 🍽️ Restaurants & Food |
| `hotels` | 🏨 Hotels & Hospitality |
| `real_estate` | 🏠 Real Estate |
| `construction` | 🏗️ Construction |
| `law_firms` | ⚖️ Law Firms |
| `medical_clinics` | 🏥 Medical Clinics |
| `dentists` | 🦷 Dentists |
| `gyms_fitness` | 💪 Gyms & Fitness |
| `beauty_salons` | 💅 Beauty Salons & Spas |
| `it_technology` | 💻 IT & Technology |
| `marketing_agencies` | 📣 Marketing Agencies |
| ... | (20 total) |

---

## 🌍 Supported Countries

Spain 🇪🇸 · Mexico 🇲🇽 · Argentina 🇦🇷 · Colombia 🇨🇴 · Chile 🇨🇱 · Peru 🇵🇪 · USA 🇺🇸 · UK 🇬🇧 · France 🇫🇷 · Germany 🇩🇪 · Italy 🇮🇹 · Portugal 🇵🇹 · Brazil 🇧🇷 · Uruguay 🇺🇾 · and more...

---

## 📝 License

Apache-2.0
