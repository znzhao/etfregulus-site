# ETFRegulus Daily

https://znzhao.github.io/etfregulus-site/

A phone-first web app showing, every US trading day, the holdings recommended by the
[ETFRegulus](https://github.com/znzhao/ETFRegulus) baseline strategies under the project's trading
rules (30-day lock per ETF, drawdown ceiling measured from the 12-month high), with their backtests
since 2004. Not investment advice.

## How it works

- `.github/workflows/daily.yml` runs after each US close (22:30 UTC, retry at 02:30 UTC). It checks
  out ETFRegulus at the version pinned in `ETFREGULUS_REF`, fetches prices (yfinance), curates them,
  runs every strategy x ceiling (`scripts/s15_publish.py`), validates the output against the data
  contract, and deploys `app/` plus the data to GitHub Pages. If any step fails, nothing is deployed
  and the site keeps the previous data (the app marks it as late).
- `log/` is the live record: one line per session with what the app recommended, appended by the
  workflow and never rewritten.
- `app/` is a static site with no build step: `core.js` (pure logic), `app.js` (pages and charts),
  `i18n.js` (Chinese/English), `styles.css`. Settings and holdings stay in the browser.

## Development

    node --test tests/*.test.js  # unit tests of app/core.js and the i18n tables

To change the strategy code the site uses, tag a new ETFRegulus version and update `ETFREGULUS_REF`.
