'use strict';
// Unit tests for the SEO surfaces around the Founding Lifetime row (node --test, zero deps).
// Run: node --test test/seo.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const seo = require('../src/seo');
const { Billing } = require('../src/billing');

store_quiet();
function store_quiet() {
  const store = require('../src/store');
  store.save = () => Promise.resolve();
  store.load = () => Promise.resolve(undefined);
}

const BASE = 'https://treehost.example';
const plans = (b) => b.publicPlans();

test('offers() emits the founding row as a one-time InStock offer', () => {
  const b = new Billing();
  b.testSite = true;
  const graph = JSON.parse(seo.injectSeo('<html><head><title>x</title></head></html>', {
    base: BASE, path: '/pricing', plans: plans(b),
  }).match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1].replace(/\\"/g, '"').replace(/\\u003c/g, '<'));
  const product = graph['@graph'].find((g) => g['@type'] === 'Product');
  const founding = product.offers.find((o) => o.name.startsWith('Founding Lifetime'));
  assert.ok(founding, 'founding offer present');
  assert.equal(founding.price, '199.00'); // seo's money format
  assert.equal(founding.priceCurrency, 'USD');
  assert.equal(founding.availability, 'https://schema.org/InStock');
  assert.equal(founding.priceSpecification, undefined); // one-time: no monthly billing spec
  // the monthly plans keep their UnitPriceSpecification
  const monthly = product.offers.find((o) => o.name.startsWith('Sapling'));
  assert.equal(monthly.priceSpecification.unitText, 'month');
});

test('a sold-out founding row emits schema.org/SoldOut', () => {
  const b = new Billing();
  b.testSite = true;
  process.env.TREEHOST_FOUNDING_CAP = '1';
  b.subs.push(makeSub(b, 'active'));
  const html = seo.injectSeo('<html><head><title>x</title></head></html>', { base: BASE, path: '/pricing', plans: plans(b) });
  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1].replace(/\\"/g, '"').replace(/\\u003c/g, '<'));
  const founding = graph['@graph'].find((g) => g['@type'] === 'Product').offers.find((o) => o.name.startsWith('Founding Lifetime'));
  assert.equal(founding.availability, 'https://schema.org/SoldOut');
  delete process.env.TREEHOST_FOUNDING_CAP;
});

function makeSub(b, status) {
  const s = b.newSub({ id: 'u1' }, b.plan('founding-lifetime'));
  s.status = status;
  s.createdAt = Date.now();
  return s;
}

test('llmsTxt includes the founding line with the price and the "first 25" wording', () => {
  const b = new Billing();
  b.testSite = true;
  const txt = seo.llmsTxt(BASE, { plans: plans(b) });
  const line = txt.split('\n').find((l) => l.includes('Founding Lifetime'));
  assert.ok(line, 'founding line present');
  assert.ok(line.includes('$199 once'));
  assert.match(line, /4 servers of 4 GB, 2 proxies/);
  assert.ok(line.includes('priority support'));
  assert.match(line, /first 25 only/); // the scarcity wording, straight from capTotal
  // and the sold-out state flips the plan row the pricing page (source of truth) renders from
  process.env.TREEHOST_FOUNDING_CAP = '1';
  b.subs.push(makeSub(b, 'active'));
  assert.equal(plans(b).plans.find((p) => p.founding).soldOut, true);
  delete process.env.TREEHOST_FOUNDING_CAP;
});
