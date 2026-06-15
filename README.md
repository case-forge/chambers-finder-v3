# Chambers Finder

Find barristers' chambers near any family court in England and Wales.

Chambers Finder helps family law practitioners, especially those working on legal aid, reach counsel near a hearing without trawling through dozens of chambers websites. Search for a court and see the chambers around it, ordered by distance, or search for a chambers and see all of its branches. You can star the sets you work with, keep your own notes, and mark who you have already contacted, and everything you save stays in your browser.

Live at [caseforge.uk](https://caseforge.uk).

## Running it locally

Chambers Finder is plain HTML, CSS and JavaScript with one serverless function behind the contact form.

For the whole site, including the contact form, install [Wrangler](https://developers.cloudflare.com/workers/wrangler/) and run its dev server:

```sh
cp .dev.vars.example .dev.vars
npx wrangler pages dev .
```

The example secrets file uses Cloudflare's public Turnstile test key, so the form works without real credentials. Wrangler prints the local address.

For just the front page, extract the files and run:

```sh
python -m http.server 8000 --directory "C:\Users\{user}\Downloads\chambers-finder-v3-main" --bind 127.0.0.1
```

Then open http://127.0.0.1:8000/. Internal links like `/contact` and `/privacy` and the contact form only resolve under Wrangler.

## How it is built

The site runs on Cloudflare Pages. Court and chambers data lives in `finder-data.json`. The contact form posts to a Pages Function that checks a Cloudflare Turnstile token, rate limits each IP, and sends the message through Resend. Fonts and icons are served from this domain; the only third-party code is the Turnstile widget on the contact page. The site runs no analytics.

Live credentials are kept as environment variables on the Pages project, not in this repository.

## Data

Court names, locations and coordinates are based in part on the GOV.UK Find a Court or Tribunal service, which contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). The chambers directory is researched and curated by CaseForge.

## Copyright

© 2026 CaseForge. All rights reserved.
