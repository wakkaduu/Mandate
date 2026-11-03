// Seed catalog. In a real deployment this would be a merchant feed (e.g. Channel3 / PayPal Store Sync).
export const PRODUCTS = [
  { id: 'lamp-aurora', name: 'Aurora LED Desk Lamp', merchant: 'Lumen & Co', category: 'office', price_cents: 3400, tags: 'lamp light desk lighting led', description: 'Dimmable LED lamp with warm/cool modes and USB-C charging.', emoji: '💡' },
  { id: 'lamp-pro', name: 'Halo Architect Lamp', merchant: 'Lumen & Co', category: 'office', price_cents: 14900, tags: 'lamp light desk lighting premium', description: 'Premium articulated architect lamp, brushed aluminium.', emoji: '🔦' },
  { id: 'kb-tactile', name: 'Tactile 75% Mechanical Keyboard', merchant: 'Keywright', category: 'electronics', price_cents: 8900, tags: 'keyboard mechanical typing', description: 'Hot-swappable 75% board with tactile switches and PBT keycaps.', emoji: '⌨️' },
  { id: 'kb-basic', name: 'Quiet Membrane Keyboard', merchant: 'Keywright', category: 'electronics', price_cents: 2900, tags: 'keyboard quiet typing budget', description: 'Full-size quiet keyboard. Plug and play.', emoji: '🎹' },
  { id: 'mon-4k', name: 'Vista 27" 4K Monitor', merchant: 'Pixelmart', category: 'electronics', price_cents: 42900, tags: 'monitor display screen 4k', description: '27-inch 4K IPS monitor with USB-C 65W docking.', emoji: '🖥️' },
  { id: 'mon-fhd', name: 'Vista 24" Full HD Monitor', merchant: 'Pixelmart', category: 'electronics', price_cents: 10900, tags: 'monitor display screen 1080p hd', description: '24-inch Full HD IPS monitor, HDMI and DisplayPort.', emoji: '🖥️' },
  { id: 'mon-stand', name: 'Bamboo Monitor Riser', merchant: 'Pixelmart', category: 'office', price_cents: 3900, tags: 'monitor stand riser desk shelf', description: 'Bamboo riser with storage shelf; lifts screen to eye level.', emoji: '🪵' },
  { id: 'chair-ergo', name: 'ErgoFlex Mesh Chair', merchant: 'Sitwell', category: 'furniture', price_cents: 24900, tags: 'chair ergonomic seat office', description: 'Breathable mesh ergonomic chair with lumbar support.', emoji: '🪑' },
  { id: 'mat-desk', name: 'Felt Desk Mat (Large)', merchant: 'Sitwell', category: 'office', price_cents: 2400, tags: 'mat desk pad mouse felt', description: 'Large wool-felt desk mat, 90x40cm.', emoji: '🟫' },
  { id: 'hub-usbc', name: '7-in-1 USB-C Hub', merchant: 'Pixelmart', category: 'electronics', price_cents: 4500, tags: 'hub usb-c dock adapter hdmi', description: 'HDMI, SD, 3x USB-A and 100W pass-through charging.', emoji: '🔌' },
  { id: 'plant-pothos', name: 'Pothos Desk Plant', merchant: 'Leaf Lane', category: 'home', price_cents: 1800, tags: 'plant greenery pothos desk', description: 'Low-light friendly pothos in a ceramic pot.', emoji: '🪴' },
  { id: 'mouse-ergo', name: 'Vertical Ergonomic Mouse', merchant: 'Keywright', category: 'electronics', price_cents: 3600, tags: 'mouse ergonomic vertical wireless', description: 'Wireless vertical mouse that reduces wrist strain.', emoji: '🖱️' },
  { id: 'headphones-nc', name: 'Calm NC Headphones', merchant: 'Soundhaus', category: 'electronics', price_cents: 19900, tags: 'headphones noise cancelling audio', description: 'Over-ear active noise-cancelling headphones, 40h battery.', emoji: '🎧' },
];

export const DEFAULT_MANDATE = {
  name: 'Home office refresh',
  budget_cents: 30000,
  per_item_cap_cents: 12000,
  categories: ['office', 'electronics', 'home'],
};
