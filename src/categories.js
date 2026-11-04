// Spending categories a mandate can allow. Products come from live web search (src/web/search.js); the model
// must assign each one of these, and anything it cannot classify becomes "other" (which a mandate can still
// allow or refuse). The list is deliberately short so the mandate editor stays readable.
export const CATEGORIES = ['electronics', 'office', 'furniture', 'home', 'kitchen', 'books', 'clothing', 'sports', 'toys', 'health', 'other'];

// A mandate has NO built-in amount. The owner chooses every figure (budget, per-purchase cap, categories) before
// anything can be searched or bought. Only these non-money starting values are suggested in the setup form.
export const MANDATE_DEFAULTS = {
  name: 'My mandate',
  max_per_hour: 6,   // purchase requests per hour; a safety default, the owner can change or remove it
};

// The SERVER decides a product's category (from the product page's own title/category), never the chat model:
// otherwise a model could label a TV "office" to slip past a mandate. This is a deliberately plain keyword
// heuristic; anything it cannot place is "other", which a mandate can allow or refuse like any category.
const KEYWORDS = {
  electronics: /\b(monitors?|keyboards?|(?:mouse|mice)(?! ?pads?)|headphones?|earbuds?|headsets?|speakers?|laptops?|tablets?|phones?|smartphones?|chargers?|cables?|hubs?|docks?|cameras?|webcams?|tvs?|televisions?|routers?|printers?|ssd|hard drives?|consoles?|smartwatch|microphones?|power ?banks?|gpu|processors?|electronics?)\b/gi,
  office: /\b(lamps?|notebooks?|pens?|pencils?|staplers?|organi[sz]ers?|desk mats?|desk pads?|mouse ?pads?|riser|planners?|paper|whiteboards?|binders?|folders?|labels?|stationery|monitor stands?)\b/gi,
  furniture: /\b(chairs?|desks?(?! (?:mats?|pads?|organi[sz]ers?|lamps?|fans?|accessor\w*))|tables?|sofas?|couch(?:es)?|beds?|mattress(?:es)?|shelf|shelves|bookcases?|cabinets?|stools?|dressers?|wardrobes?|ottomans?|furniture)\b/gi,
  kitchen: /\b(pans?|pots?|knives|knife|cookware|blenders?|kettles?|coffee|toasters?|air fryers?|utensils?|cutlery|mugs?|kitchen|cutting boards?|bakeware)\b/gi,
  books: /\b(books?|novels?|paperbacks?|hardcovers?|textbooks?|cookbooks?)\b/gi,
  clothing: /\b(shirts?|t-shirts?|jackets?|shoes?|sneakers?|runners?|boots?|dress(?:es)?|pants|jeans|hoodies?|socks?|hats?|caps?|coats?|sweaters?|apparel|clothing|shorts|leggings)\b/gi,
  sports: /\b(yoga|dumbbells?|bikes?|bicycles?|tents?|camping|fitness|football|basketball|tennis|golf|hiking|kettlebells?|sports?|treadmill)\b/gi,
  toys: /\b(toys?|lego|puzzles?|dolls?|board games?|plush|action figures?)\b/gi,
  health: /\b(vitamins?|supplements?|first aid|massagers?|thermometers?|skincare|toothbrush(?:es)?|sunscreen|protein)\b/gi,
  home: /\b(plants?|candles?|rugs?|curtains?|pillows?|blankets?|vases?|decor|towels?|storage|baskets?|humidifiers?|vacuums?|diffusers?|bedding|home)\b/gi,
};

export function categorize(...texts) {
  const text = texts.filter(Boolean).join(' ').toLowerCase();
  let best = 'other';
  let score = 0;
  for (const [cat, re] of Object.entries(KEYWORDS)) {
    const n = (text.match(re) ?? []).length;
    if (n > score) { best = cat; score = n; }
  }
  return best;
}
