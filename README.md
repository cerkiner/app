# Celilsemi Sam Erkiner Personal Application

This progressive web application is a personal page demo built with the Ionic Framework and Angular Framework intended to run on an Apache Server with LAMP Stack.

## Table of Contents
- [Getting Started](#getting-started)
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

1. Run `npm run build -- --configuration production`
2. Upload the generated `app/` files to `public_html/app/` on the Hostinger website `erkiner.com`. The public address is https://sam.erkiner.com/app/.
3. Upload supporting assets first, then `index.html` and finally `ngsw.json`. Retain previous hashed assets so existing visitors can finish using their cached version.
4. Verify the live page and service-worker resources after uploading. The deployment target is recorded in `.hostinger/site.json`.

The hosting document root is shared with WordPress, the blog and the API. Use targeted file uploads into `app/`; do not use a whole-site archive deployment or replace the document root. Preserve the existing server redirects and the canonical URL and migration cleanup in `src/index.html`.
