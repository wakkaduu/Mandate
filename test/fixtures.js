// Test-only product fixtures. The shipped app has NO catalog: products come from live web search. These rows
// stand in for "offers the server already verified", so the policy / PayPal / ledger tests can run offline.
import { saveOffer } from '../src/offers.js';

export const FIXTURES = {
  'lamp-aurora': { title: "Aurora LED Desk Lamp", merchant: "Lumen & Co", category: 'office', price_cents: 3400 },
  'lamp-pro': { title: "Halo Architect Lamp", merchant: "Lumen & Co", category: 'office', price_cents: 14900 },
  'kb-tactile': { title: "Tactile 75% Mechanical Keyboard", merchant: "Keywright", category: 'electronics', price_cents: 8900 },
  'kb-basic': { title: "Quiet Membrane Keyboard", merchant: "Keywright", category: 'electronics', price_cents: 2900 },
  'mon-4k': { title: "Vista 27\" 4K Monitor", merchant: "Pixelmart", category: 'electronics', price_cents: 42900 },
  'mon-fhd': { title: "Vista 24\" Full HD Monitor", merchant: "Pixelmart", category: 'electronics', price_cents: 10900 },
  'mon-stand': { title: "Bamboo Monitor Riser", merchant: "Pixelmart", category: 'office', price_cents: 3900 },
  'chair-ergo': { title: "ErgoFlex Mesh Chair", merchant: "Sitwell", category: 'furniture', price_cents: 24900 },
  'mat-desk': { title: "Felt Desk Mat (Large)", merchant: "Sitwell", category: 'office', price_cents: 2400 },
  'hub-usbc': { title: "7-in-1 USB-C Hub", merchant: "Pixelmart", category: 'electronics', price_cents: 4500 },
  'plant-pothos': { title: "Pothos Desk Plant", merchant: "Leaf Lane", category: 'home', price_cents: 1800 },
  'mouse-ergo': { title: "Vertical Ergonomic Mouse", merchant: "Keywright", category: 'electronics', price_cents: 3600 },
  'headphones-nc': { title: "Calm NC Headphones", merchant: "Soundhaus", category: 'electronics', price_cents: 19900 },
};

export async function seedOffers() {
  for (const [id, o] of Object.entries(FIXTURES)) {
    await saveOffer({ id, ...o, url: `https://shop.example/${id}`, price_verified: true });
  }
}
