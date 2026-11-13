# Celilsemi Sam Erkiner Personal Application

This progressive web application is a personal page demo built with the Ionic Framework and Angular Framework intended to run on an Apache Server with LAMP Stack.

## Table of Contents
- [Getting Started](#getting-started)
- [Checking Changes](#checking-changes)
- [Deploying as Progressive Web App](#deploying-as-progressive-web-app)


## Getting Started

* [Download the installer](https://nodejs.org/) for Node LTS.
* Install the ionic CLI globally: `npm install -g ionic`
* Clone this repository: `git clone https://github.com/cerkiner/app.git`.
* Run `npm install` from the project root.
* Run `ionic serve` in a terminal from the project root.
* Profit. :tada:

_Note: See [How to Prevent Permissions Errors](https://docs.npmjs.com/getting-started/fixing-npm-permissions) if you are running into issues when trying to install packages globally._

## Deploying as Progressive Web App

1. Run `npm run ionic:build --prod`
2. Push the `app` folder to your hosting service

## Checking Changes

Autonomous issue investigation, PR review and bounded CI repair are configured in
GitHub Actions. See [.github/CODEX_AUTOMATION.md](.github/CODEX_AUTOMATION.md) for
subscription credential setup, collaborator-only operation, security boundaries
and tests. Collaborator issues and repository-owned PRs run automatically
regardless of repository visibility.

Use Node 24 from `.nvmrc` (`nvm install && nvm use`). Install the locked dependencies
and the single browser used by both test suites:

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm ci
npx playwright install --no-shell chromium
```

On Linux, use `npx playwright install --with-deps --no-shell chromium` to also install
the browser's system dependencies. Python 3 is needed for the local test server.

Run the same checks as CI:

```sh
npm run build -- --configuration=production
npm run test:ci
npm run e2e
```

The browser suite serves the generated `app/` directory at
`http://127.0.0.1:4173/app/`. Build first; the suite never tests the development
server or deploys to production. It checks the biography, loaded profile image,
desktop navigation, and both mobile menus in headless Chromium. JavaScript errors,
console errors, and failed local asset requests fail the suite. Browser contexts
are isolated and tests have no automatic retries or screenshot comparisons.

On failure, screenshots, traces, and an HTML report are written under
`output/playwright/`. View the report with
`npx playwright show-report output/playwright/report`. GitHub retains failure
diagnostics for seven days.

The `CI` workflow runs `Validate app` on PRs targeting `master`, pushes to `master`,
and manual runs. New PR commits replace superseded runs. The repository's active
`master` ruleset requires this GitHub Actions check to pass against the current
base branch, requires a PR, blocks force pushes and deletion, and has no bypass
actors or required human approvals. These repository settings are managed in
GitHub, separately from this workflow. Green means the defined checks passed;
it does not cover other browser engines, native builds, or the WordPress theme.
